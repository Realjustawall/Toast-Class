import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from './errors.js';
import { canEditWhiteboard } from './app.js';
import type { TeachingContext } from './teaching.js';

type Params = { id: string; doc: string };
type Request = { cookies: Record<string, string | undefined> };
type Access = {
  u: { id: string; name: string };
  room: { id: string; organization_id: string } & Record<string, unknown>;
  role: string;
  document: { id: string; teacher_only: boolean };
};
const cursor = z
  .object({
    x: z.number().finite().min(-1e7).max(1e7),
    y: z.number().finite().min(-1e7).max(1e7),
    tool: z.enum(['pointer', 'laser']),
  })
  .strict();
const message = z
  .object({ generation: z.uuid(), pointer: cursor.nullable(), button: z.enum(['up', 'down']) })
  .strict();
type Update = z.infer<typeof message>;
type Peer = {
  id: string;
  clientId: string;
  userId: string;
  name: string;
  generation: string;
  pointer: Update['pointer'];
  button: Update['button'];
  updatedAt: number;
  alive: boolean;
  socket: WebSocket;
  check: () => Promise<Access & { generation: string }>;
};

/** Single-process, ephemeral cursors. Durable board content uses the independent CRDT protocol. */
export async function registerBoardPresence(
  app: FastifyInstance,
  ctx: TeachingContext,
  access: (request: Request, params: Params) => Promise<Access>,
) {
  const rooms = new Map<string, Map<string, Peer>>(),
    notifications = new Map<string, ReturnType<typeof setTimeout>>();
  let total = 0,
    closing = false;
  app.decorate('notifyBoardView', (documentId: string) => {
    for (const peer of rooms.get(documentId)?.values() ?? []) {
      if (peer.socket.readyState === 1 && peer.socket.bufferedAmount < 16384)
        peer.socket.send(JSON.stringify({ type: 'view_changed' }));
    }
  });
  const notify = (documentId: string) => {
    if (closing) return;
    if (notifications.has(documentId)) return;
    notifications.set(
      documentId,
      setTimeout(() => {
        notifications.delete(documentId);
        const group = rooms.get(documentId);
        const activePeers = [...(group?.values() ?? [])].filter(
          (peer) => peer.socket.readyState === 1 && peer.pointer !== null,
        );
        const byGeneration = new Map<string, ReturnType<typeof activePeers.map>>();
        for (const peer of activePeers) {
          let list = byGeneration.get(peer.generation);
          if (!list) {
            list = [];
            byGeneration.set(peer.generation, list);
          }
          list.push({
            id: peer.id,
            userId: peer.userId,
            name: peer.name,
            pointer: peer.pointer,
            button: peer.button,
            updatedAt: peer.updatedAt,
          });
        }
        for (const peer of group?.values() ?? []) {
          if (peer.socket.readyState === 1 && peer.socket.bufferedAmount < 65536) {
            peer.socket.send(
              JSON.stringify({
                type: 'presence_changed',
                generation: peer.generation,
                peers: byGeneration.get(peer.generation) ?? [],
              }),
            );
          } else if (peer.socket.bufferedAmount >= 65536)
            peer.socket.close(1013, 'Slow presence consumer');
        }
      }, 16),
    );
  };
  async function authorize(request: Request, params: Params) {
    const a = await access(request, params);
    const state = (
      await ctx.pool.query('SELECT generation FROM board_states WHERE document_id=$1', [
        a.document.id,
      ])
    ).rows[0];
    if (!state) fail(409, 'Board state is unavailable');
    return { ...a, generation: String(state.generation) };
  }
  const base = '/api/v1/classrooms/:id/documents/:doc/board/presence';
  app.get<{ Params: Params }>(base, async (req) => {
    const a = await authorize(req, req.params),
      group = rooms.get(a.document.id);
    const memberships = (
      await ctx.pool.query(
        'SELECT m.user_id,m.role,p.can_whiteboard,p.is_presenter FROM memberships m LEFT JOIN classroom_user_permissions p ON p.user_id=m.user_id AND p.classroom_id=$2 WHERE m.organization_id=$1',
        [a.room.organization_id, a.room.id],
      )
    ).rows;
    const permitted = new Set(
      memberships
        .filter((row) =>
          canEditWhiteboard(
            { ...a.room, _userPerm: row },
            row.role,
            Boolean(a.document.teacher_only),
          ),
        )
        .map((row) => String(row.user_id)),
    );
    return {
      generation: a.generation,
      peers: [...(group?.values() ?? [])]
        .filter(
          (peer) =>
            peer.socket.readyState === 1 &&
            peer.generation === a.generation &&
            permitted.has(peer.userId) &&
            peer.pointer !== null,
        )
        .map((peer) => ({
          id: peer.id,
          userId: peer.userId,
          name: peer.name,
          pointer: peer.pointer,
          button: peer.button,
          updatedAt: peer.updatedAt,
        })),
    };
  });
  const upgrades = new WeakMap<object, Access & { generation: string }>();
  app.get<{ Params: Params; Querystring: { clientId?: string } }>(
    base + '/live',
    {
      websocket: true,
      preValidation: async (req) => {
        if (req.headers.origin !== ctx.origin) fail(403, 'Origin rejected');
        const a = await authorize(req, req.params),
          group = rooms.get(a.document.id);
        const clientId = z.uuid().optional().parse(req.query.clientId);
        const replacing = [...(group?.values() ?? [])].find(
          (peer) => peer.userId === a.u.id && peer.clientId === clientId,
        );
        if (
          total - (replacing ? 1 : 0) >= 1024 ||
          (group?.size ?? 0) - (replacing ? 1 : 0) >= 128 ||
          [...(group?.values() ?? [])].filter(
            (peer) => peer.socket.readyState === 1 && peer.userId === a.u.id && peer !== replacing,
          ).length >= 4
        )
          fail(429, 'Board presence connection limit reached');
        upgrades.set(req, a);
      },
    },
    (socket, req) => {
      const a = upgrades.get(req)!;
      upgrades.delete(req);
      const group = rooms.get(a.document.id) ?? new Map<string, Peer>();
      const clientId = req.query.clientId ?? randomUUID();
      const replacing = [...group.values()].find(
        (peer) => peer.userId === a.u.id && peer.clientId === clientId,
      );
      if (replacing) {
        replacing.socket.terminate();
        if (group.delete(replacing.id)) total--;
      }
      if (
        total >= 1024 ||
        group.size >= 128 ||
        [...group.values()].filter((peer) => peer.socket.readyState === 1 && peer.userId === a.u.id)
          .length >= 4
      ) {
        socket.close(1013, 'Board presence connection limit reached');
        return;
      }
      const peer: Peer = {
        id: randomUUID(),
        clientId,
        userId: a.u.id,
        name: a.u.name,
        generation: a.generation,
        pointer: null,
        button: 'up',
        updatedAt: Date.now(),
        alive: true,
        socket,
        check: () => authorize(req, req.params),
      };
      group.set(peer.id, peer);
      rooms.set(a.document.id, group);
      total++;
      socket.send(JSON.stringify({ type: 'ready', id: peer.id }));
      let checking = false,
        pending: Update | undefined,
        tokens = 20,
        refill = Date.now();
      const apply = async () => {
        if (checking) return;
        checking = true;
        try {
          while (pending && socket.readyState === 1) {
            const update = pending;
            pending = undefined;
            const permission = await peer.check();
            if (socket.readyState !== 1) return;
            if (update.generation !== permission.generation) throw new Error('Board replaced');
            if (
              update.pointer &&
              !canEditWhiteboard(
                permission.room,
                permission.role,
                Boolean(permission.document.teacher_only),
              )
            )
              throw new Error('Read only');
            peer.generation = permission.generation;
            peer.name = permission.u.name;
            peer.pointer = update.pointer;
            peer.button = update.button;
            peer.updatedAt = Date.now();
            notify(a.document.id);
          }
        } catch {
          socket.close(1008, 'Presence authorization changed');
        } finally {
          checking = false;
        }
      };
      socket.on('message', (bytes) => {
        const buffer = Buffer.isBuffer(bytes)
          ? bytes
          : Array.isArray(bytes)
            ? Buffer.concat(bytes)
            : Buffer.from(bytes);
        const now = Date.now();
        tokens = Math.min(20, tokens + (now - refill) / 100);
        refill = now;
        if (buffer.length > 2048 || tokens < 1) {
          socket.close(buffer.length > 2048 ? 1009 : 1008, 'Presence message limit');
          return;
        }
        tokens--;
        try {
          pending = message.parse(JSON.parse(buffer.toString()));
          void apply();
        } catch {
          socket.close(1008, 'Invalid presence message');
        }
      });
      socket.on('pong', () => {
        peer.alive = true;
      });
      let heartbeatBusy = false;
      const heartbeat = setInterval(() => {
        if (heartbeatBusy) return;
        if (!peer.alive) {
          socket.terminate();
          return;
        }
        heartbeatBusy = true;
        peer.alive = false;
        void peer
          .check()
          .then((permission) => {
            if (permission.generation !== peer.generation) throw new Error('Board replaced');
            if (
              peer.pointer &&
              !canEditWhiteboard(
                permission.room,
                permission.role,
                Boolean(permission.document.teacher_only),
              )
            ) {
              peer.pointer = null;
              notify(a.document.id);
            }
            if (socket.readyState === 1) socket.ping();
          })
          .catch(() => socket.close(1008, 'Presence authorization expired'))
          .finally(() => {
            heartbeatBusy = false;
          });
      }, 5000);
      socket.on('close', () => {
        clearInterval(heartbeat);
        pending = undefined;
        if (group.delete(peer.id)) total--;
        if (!group.size) rooms.delete(a.document.id);
        notify(a.document.id);
      });
    },
  );
  app.addHook('onClose', async () => {
    closing = true;
    for (const timer of notifications.values()) clearTimeout(timer);
    notifications.clear();
    for (const group of rooms.values()) for (const peer of group.values()) peer.socket.terminate();
    rooms.clear();
  });
}
