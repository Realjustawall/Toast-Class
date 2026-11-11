import { sqlDialect } from './database.js';
import { fail } from './errors.js';
import { classroomAuthorization } from './classroom-access.js';
import { readClassroomWorkspace } from './classroom-workspace.js';
import { roomLockPolicy } from './classroom-lock-policy.js';
import { assertPlatformFeature } from './platform-options.js';
import { canEditWhiteboard, formatRoomSettings, resolveUserPermissions } from './app.js';
import type { FastifyInstance } from 'fastify';
import type { DatabasePool, DatabaseConnection } from './database.js';
import { randomUUID, randomInt } from 'node:crypto';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';

type Identity = { id: string; name: string; email: string };
type Room = { id: string; organization_id: string; name: string } & Record<string, unknown>;
export interface TeachingContext {
  pool: DatabasePool;
  assertSessionControl?: (classroomId: string) => Promise<void>;
  closeBreakoutsForParent?: (
    c: DatabaseConnection,
    sessionId: string,
    actorId: string,
  ) => Promise<string[]>;
  enqueueMediaEnd?: (c: DatabaseConnection, sessionId: string) => Promise<void>;
  origin: string;
  user: (req: { cookies: Record<string, string | undefined> }) => Promise<Identity>;
  roomAccess: (id: string, uid: string) => Promise<Room>;
  membership: (org: string, uid: string, write?: boolean) => Promise<string>;
}

const idSchema = z.uuid();
export async function registerTeaching(app: FastifyInstance, ctx: TeachingContext) {
  const { pool, user, roomAccess, membership } = ctx;
  const listeners = new Map<string, Set<WebSocket>>();
  const liveIdentities = new WeakMap<WebSocket, { id: string; name: string; role: string }>();
  const upgrades = new WeakMap<object, { id: string; name: string; role: string }>();
  const presenceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const liveParticipants = (roomId: string) => [
    ...new Map(
      [...(listeners.get(roomId) ?? [])]
        .filter((socket) => socket.readyState === 1)
        .flatMap((socket) => {
          const person = liveIdentities.get(socket);
          return person ? [[person.id, person] as const] : [];
        }),
    ).values(),
  ];
  const broadcast = (roomId: string, type = 'changed') => {
    // Coalesce join/leave bursts so a large classroom does not generate N² notifications.
    if (type === 'users_changed') {
      if (!presenceTimers.has(roomId))
        presenceTimers.set(
          roomId,
          setTimeout(() => {
            presenceTimers.delete(roomId);
            broadcast(roomId, 'presence_changed');
          }, 75),
        );
      return;
    }
    const payload = JSON.stringify({ type });
    for (const socket of listeners.get(roomId) ?? [])
      if (socket.readyState === 1) {
        if (socket.bufferedAmount > 256 * 1024) socket.close(1013, 'Reconnect to synchronize');
        else socket.send(payload);
      }
  };
  app.decorate('notifyClassroom', broadcast);
  app.decorate('notifyClassroomUsers', (roomId: string, users: string[], type: string) => {
    const wanted = new Set(users),
      payload = JSON.stringify({ type });
    for (const socket of listeners.get(roomId) ?? [])
      if (socket.readyState === 1 && wanted.has(liveIdentities.get(socket)?.id ?? '')) {
        if (socket.bufferedAmount > 256 * 1024) socket.close(1013, 'Reconnect to synchronize');
        else socket.send(payload);
      }
  });
  async function access(
    req: { cookies: Record<string, string | undefined> },
    roomId: string,
    write = false,
  ) {
    const u = await user(req);
    const room = await roomAccess(idSchema.parse(roomId), u.id);
    const role = await membership(room.organization_id, u.id, write);
    return { u, room, role };
  }
  async function active(roomId: string) {
    const row = (await pool.query('SELECT * FROM classroom_sessions WHERE active_key=$1', [roomId]))
      .rows[0];
    if (!row) fail(409, 'No active session');
    return row;
  }
  async function transaction<T>(fn: (c: DatabaseConnection) => Promise<T>) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const v = await fn(c);
      await c.query('COMMIT');
      return v;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async function lockedSession(c: DatabaseConnection, id: string) {
    const s = (
      await c.query('SELECT active_key FROM classroom_sessions WHERE id=$1 FOR UPDATE', [id])
    ).rows[0];
    if (!s?.active_key) fail(409, 'Session has ended');
  }
  async function audit(
    c: DatabaseConnection,
    uid: string,
    org: string,
    action: string,
    id: string,
  ) {
    await c.query(
      'INSERT INTO audit_logs(id,actor_id,organization_id,action,resource_id) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), uid, org, action, id],
    );
  }
  app.get<{ Params: { id: string } }>(
    '/api/v1/classrooms/:id/live',
    {
      websocket: true,
      // Schools may share one public IP. Keep this bounded separately from HTTP mutations.
      config: { rateLimit: { max: 1200, timeWindow: '1 minute' } },
      preValidation: async (req) => {
        if (req.headers.origin !== ctx.origin) fail(403, 'Origin rejected');
        const current = await access(req, req.params.id);
        upgrades.set(req, { id: current.u.id, name: current.u.name, role: current.role });
      },
    },
    (socket, req) => {
      const roomId = req.params.id;
      const group = listeners.get(roomId) ?? new Set<WebSocket>();
      const identity = upgrades.get(req);
      upgrades.delete(req);
      if (!identity) {
        socket.close(1008, 'Authorization required');
        return;
      }
      const present = liveParticipants(roomId).some((person) => person.id === identity.id);
      liveIdentities.set(socket, identity);
      group.add(socket);
      listeners.set(roomId, group);
      socket.send(JSON.stringify({ type: 'ready' }));
      if (!present) broadcast(roomId, 'users_changed');
      // No client commands over this channel: mutations use validated HTTP routes.
      socket.on('message', () => socket.close(1008, 'Read-only event channel'));
      let alive = true;
      let checking = false;
      let transientFailures = 0;
      socket.on('pong', () => {
        alive = true;
      });
      const ping = () => {
        if (socket.readyState !== 1) return;
        alive = false;
        socket.ping();
        socket.send(JSON.stringify({ type: 'heartbeat' }));
      };
      const heartbeat = setInterval(
        () => {
          if (checking || socket.readyState !== 1) return;
          checking = true;
          void (async () => {
            if (!alive) {
              socket.terminate();
              return;
            }
            const current = await access(req, roomId);
            transientFailures = 0;
            liveIdentities.set(socket, {
              id: current.u.id,
              name: current.u.name,
              role: current.role,
            });
            // Browser WebSocket APIs do not expose protocol ping/pong frames.
            ping();
          })()
            .catch((error: { statusCode?: number }) => {
              if ([401, 403, 404, 409].includes(error.statusCode ?? 0)) {
                socket.close(1008, 'Authorization expired');
              } else if (++transientFailures > 2) {
                socket.close(1013, 'Authorization service temporarily unavailable');
              } else {
                // A bounded grace period for transient database pressure. This
                // channel carries invalidations only; every data read is authorized.
                ping();
              }
            })
            .finally(() => {
              checking = false;
            });
        },
        10000 + Math.floor(Math.random() * 5000),
      );
      socket.on('close', () => {
        clearInterval(heartbeat);
        group.delete(socket);
        if (!group.size) listeners.delete(roomId);
        if (!liveParticipants(roomId).some((person) => person.id === identity.id))
          broadcast(roomId, 'users_changed');
      });
    },
  );
  app.addHook('onClose', async () => {
    for (const timer of presenceTimers.values()) clearTimeout(timer);
    presenceTimers.clear();
    for (const group of listeners.values()) for (const s of group) s.terminate();
    listeners.clear();
  });
  app.post<{ Params: { id: string } }>(
    '/api/v1/classrooms/:id/session/start',
    async (req, reply) => {
      const { u, room } = await access(req, req.params.id, true);
      await ctx.assertSessionControl?.(room.id);
      const id = randomUUID();
      await transaction(async (c) => {
        await c.query(
          'INSERT INTO classroom_sessions(id,classroom_id,started_by,active_key) VALUES($1,$2,$3,$2)',
          [id, room.id, u.id],
        );
        await audit(c, u.id, room.organization_id, 'session.started', id);
      });
      broadcast(room.id);
      return reply.code(201).send({ id });
    },
  );
  app.post<{ Params: { id: string } }>('/api/v1/classrooms/:id/session/end', async (req) => {
    const { u, room } = await access(req, req.params.id, true);
    await ctx.assertSessionControl?.(room.id);
    const session = await active(room.id);
    let children: string[] = [];
    await transaction(async (c) => {
      await lockedSession(c, session.id);
      await c.query(
        'UPDATE classroom_sessions SET ended_at=CURRENT_TIMESTAMP(3),active_key=NULL WHERE id=$1',
        [session.id],
      );
      await c.query("UPDATE polls SET status='ended' WHERE session_id=$1 AND status<>'ended'", [
        session.id,
      ]);
      children = (await ctx.closeBreakoutsForParent?.(c, session.id, u.id)) ?? [];
      await ctx.enqueueMediaEnd?.(c, session.id);
      await audit(c, u.id, room.organization_id, 'session.ended', session.id);
    });
    broadcast(room.id);
    for (const id of children) broadcast(id);
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/v1/classrooms/:id/teaching', async (req) => {
    const { u, room, role } = await access(req, req.params.id);
    const settings = formatRoomSettings(room);
    const workspace = await readClassroomWorkspace(pool, room.id);
    const selectedStudent = room.selected_student_id
      ? ((await pool.query('SELECT id,name FROM users WHERE id=$1', [room.selected_student_id]))
          .rows[0] ?? null)
      : null;
    const myPermissions = resolveUserPermissions(
      room,
      role,
      room._userPerm as Record<string, unknown> | undefined,
    );
    const userPermissions = (
      await pool.query(
        'SELECT p.user_id,p.can_chat,p.can_chat_images,p.can_shared_notes,p.lock_exempt,p.interaction_locked,p.can_whiteboard,p.can_microphone,p.can_camera,p.can_screen_share,p.can_raise_hand,p.is_presenter,p.kicked FROM classroom_user_permissions p WHERE p.classroom_id=$1',
        [room.id],
      )
    ).rows.map((r) => {
      const b = (v: unknown) => (v === null || v === undefined ? null : v !== false && v !== 0);
      return {
        userId: r.user_id as string,
        canChat: b(r.can_chat),
        canChatImages: b(r.can_chat_images),
        canSharedNotes: b(r.can_shared_notes),
        lockExempt: Boolean(b(r.lock_exempt)),
        interactionLocked: Boolean(b(r.interaction_locked)),
        canWhiteboard: b(r.can_whiteboard),
        canMicrophone: b(r.can_microphone),
        canCamera: b(r.can_camera),
        canScreenShare: b(r.can_screen_share),
        canRaiseHand: b(r.can_raise_hand),
        isPresenter: Boolean(b(r.is_presenter)),
        kicked: Boolean(b(r.kicked)),
      };
    });
    const statuses = (
      await pool.query(
        "SELECT user_id,status FROM classroom_participant_statuses WHERE classroom_id=$1 AND status<>'none'",
        [room.id],
      )
    ).rows;
    const session =
      (await pool.query('SELECT * FROM classroom_sessions WHERE active_key=$1', [room.id]))
        .rows[0] ?? null;
    if (!session)
      return {
        session: null,
        workspace,
        locks: { locks: roomLockPolicy(room.locks_json), revision: Number(room.lock_revision) },
        selectedStudent,
        role,
        userId: u.id,
        ...settings,
        myPermissions,
        userPermissions,
        statuses,
        participants: liveParticipants(room.id),
        serverTime: Date.now(),
        hands: [],
        polls: [],
        timer: null,
      };
    const hands = (
      await pool.query(
        'SELECT h.user_id,h.raised_at,u.name FROM hand_raises h JOIN users u ON u.id=h.user_id WHERE h.session_id=$1 ORDER BY h.raised_at',
        [session.id],
      )
    ).rows;
    const polls = (
      await pool.query('SELECT * FROM polls WHERE session_id=$1 ORDER BY created_at', [session.id])
    ).rows;
    for (const p of polls) {
      if (p.status === 'open' && p.closes_at && new Date(p.closes_at).getTime() <= Date.now())
        p.status = 'ended';
      const responses = (
        await pool.query('SELECT choice,user_id FROM poll_responses WHERE poll_id=$1', [p.id])
      ).rows;
      p.responseCount = responses.length;
      p.myChoice = responses.find((r) => r.user_id === u.id)?.choice ?? null;
      if (role !== 'student' || p.results_published) {
        p.counts = (p.options as string[]).map(
          (_, i) => responses.filter((r) => r.choice === i).length,
        );
      }
    }
    return {
      session,
      workspace,
      locks: { locks: roomLockPolicy(room.locks_json), revision: Number(room.lock_revision) },
      selectedStudent,
      participants: liveParticipants(room.id),
      role,
      userId: u.id,
      ...settings,
      myPermissions,
      userPermissions,
      statuses,
      serverTime: Date.now(),
      hands,
      polls,
      timer:
        (await pool.query('SELECT * FROM classroom_timers WHERE session_id=$1', [session.id]))
          .rows[0] ?? null,
    };
  });
  app.post<{ Params: { id: string } }>('/api/v1/classrooms/:id/status', async (req) => {
    const { u, room } = await access(req, req.params.id);
    const data = z
      .object({
        status: z.enum(['none', 'agree', 'disagree', 'applause', 'confused', 'away']).optional(),
        userId: z.uuid().optional(),
        clearAll: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    if (data.clearAll || (data.userId && data.userId !== u.id)) {
      await membership(room.organization_id, u.id, true);
    }
    if (data.clearAll) {
      await pool.query('DELETE FROM classroom_participant_statuses WHERE classroom_id=$1', [
        room.id,
      ]);
      broadcast(room.id);
      return { ok: true };
    }
    const target = data.userId ?? u.id;
    const status = data.status ?? 'none';
    if (status === 'none') {
      await pool.query(
        'DELETE FROM classroom_participant_statuses WHERE classroom_id=$1 AND user_id=$2',
        [room.id, target],
      );
    } else {
      await pool.query(
        sqlDialect(
          pool,
          'INSERT INTO classroom_participant_statuses(classroom_id,user_id,status,updated_at) VALUES($1,$2,$3,CURRENT_TIMESTAMP(3)) ON CONFLICT(classroom_id,user_id) DO UPDATE SET status=EXCLUDED.status,updated_at=CURRENT_TIMESTAMP(3)',
          'INSERT INTO classroom_participant_statuses(classroom_id,user_id,status,updated_at) VALUES($1,$2,$3,CURRENT_TIMESTAMP(3)) AS incoming ON DUPLICATE KEY UPDATE status=incoming.status,updated_at=CURRENT_TIMESTAMP(3)',
        ),
        [room.id, target, status],
      );
    }
    broadcast(room.id);
    return { ok: true, status };
  });
  app.post<{ Params: { id: string } }>('/api/v1/classrooms/:id/hand', async (req) => {
    const { u, room, role } = await access(req, req.params.id);
    const data = z
      .object({
        raised: z.boolean().optional(),
        userId: z.uuid().optional(),
        clearAll: z.boolean().optional(),
      })
      .parse(req.body);
    if (data.clearAll || (data.userId && data.userId !== u.id))
      await membership(room.organization_id, u.id, true);
    const effective = resolveUserPermissions(
      room,
      role,
      room._userPerm as Record<string, unknown> | undefined,
    );
    if (data.raised && role === 'student' && !effective.canRaiseHand)
      fail(403, 'Hand raise is disabled by moderator');
    const session = await active(room.id);
    const target = data.userId ?? u.id;
    await transaction(async (c) => {
      await lockedSession(c, session.id);
      if (data.clearAll) {
        await c.query('DELETE FROM hand_raises WHERE session_id=$1', [session.id]);
        await audit(c, u.id, room.organization_id, 'hand.cleared_all', session.id);
      } else if (data.raised) {
        if (target !== u.id) fail(400, 'Cannot raise another participant hand');
        await c.query(
          sqlDialect(
            c,
            'INSERT INTO hand_raises(session_id,user_id) VALUES($1,$2) ON CONFLICT(session_id,user_id) DO NOTHING',
            'INSERT INTO hand_raises(session_id,user_id) VALUES($1,$2) AS incoming ON DUPLICATE KEY UPDATE user_id=incoming.user_id',
          ),
          [session.id, u.id],
        );
      } else {
        await c.query('DELETE FROM hand_raises WHERE session_id=$1 AND user_id=$2', [
          session.id,
          target,
        ]);
        if (target !== u.id) await audit(c, u.id, room.organization_id, 'hand.lowered', target);
      }
    });
    broadcast(room.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/v1/classrooms/:id/polls', async (req, reply) => {
    const { u, room } = await access(req, req.params.id, true);
    const data = z
      .object({
        question: z.string().trim().min(1).max(500),
        options: z.array(z.string().trim().min(1).max(200)).min(2).max(12),
        durationSeconds: z.number().int().min(10).max(86400).optional(),
      })
      .parse(req.body);
    if (new Set(data.options).size !== data.options.length) fail(400, 'Options must be distinct');
    const session = await active(room.id);
    const id = randomUUID();
    await transaction(async (c) => {
      await lockedSession(c, session.id);
      await c.query(
        "INSERT INTO polls(id,session_id,question,options,status,created_by,closes_at) VALUES($1,$2,$3,$4,'open',$5,$6)",
        [
          id,
          session.id,
          data.question,
          JSON.stringify(data.options),
          u.id,
          data.durationSeconds ? new Date(Date.now() + data.durationSeconds * 1000) : null,
        ],
      );
      await audit(c, u.id, room.organization_id, 'poll.created', id);
    });
    broadcast(room.id);
    return reply.code(201).send({ id });
  });
  app.post<{ Params: { id: string; poll: string } }>(
    '/api/v1/classrooms/:id/polls/:poll/vote',
    async (req) => {
      const { u, room } = await access(req, req.params.id);
      const data = z.object({ choice: z.number().int().min(0).max(11) }).parse(req.body);
      const session = await active(room.id);
      await transaction(async (c) => {
        await lockedSession(c, session.id);
        const poll = (
          await c.query('SELECT * FROM polls WHERE id=$1 AND session_id=$2 FOR UPDATE', [
            idSchema.parse(req.params.poll),
            session.id,
          ])
        ).rows[0];
        if (!poll) fail(404, 'Poll not found');
        if (
          poll.status !== 'open' ||
          (poll.closes_at && new Date(poll.closes_at).getTime() <= Date.now())
        )
          fail(409, 'Poll is closed');
        if (data.choice >= poll.options.length) fail(400, 'Invalid choice');
        await c.query('INSERT INTO poll_responses(poll_id,user_id,choice) VALUES($1,$2,$3)', [
          poll.id,
          u.id,
          data.choice,
        ]);
      });
      broadcast(room.id);
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string; poll: string } }>(
    '/api/v1/classrooms/:id/polls/:poll/control',
    async (req) => {
      const { u, room } = await access(req, req.params.id, true);
      const data = z
        .object({ action: z.enum(['pause', 'resume', 'end', 'publish']) })
        .parse(req.body);
      const session = await active(room.id);
      await transaction(async (c) => {
        await lockedSession(c, session.id);
        const p = (
          await c.query('SELECT * FROM polls WHERE id=$1 AND session_id=$2 FOR UPDATE', [
            idSchema.parse(req.params.poll),
            session.id,
          ])
        ).rows[0];
        if (!p) fail(404, 'Poll not found');
        if (data.action === 'publish') {
          await c.query('UPDATE polls SET results_published=true WHERE id=$1', [p.id]);
        } else {
          const next = { pause: 'paused', resume: 'open', end: 'ended' }[data.action];
          if (
            p.status === 'ended' ||
            (data.action === 'pause' && p.status !== 'open') ||
            (data.action === 'resume' && p.status !== 'paused')
          )
            fail(409, 'Invalid poll transition');
          if (
            data.action === 'resume' &&
            p.closes_at &&
            new Date(p.closes_at).getTime() <= Date.now()
          )
            fail(409, 'Poll deadline passed');
          await c.query('UPDATE polls SET status=$1 WHERE id=$2', [next, p.id]);
        }
        await audit(c, u.id, room.organization_id, 'poll.' + data.action, p.id);
      });
      broadcast(room.id);
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string } }>('/api/v1/classrooms/:id/timer', async (req) => {
    const { u, room } = await access(req, req.params.id, true);
    const data = z
      .object({
        action: z.enum(['start', 'pause', 'resume', 'reset']),
        durationSeconds: z.number().int().min(1).max(86400).optional(),
      })
      .parse(req.body);
    const session = await active(room.id);
    await transaction(async (c) => {
      await lockedSession(c, session.id);
      const timer = (
        await c.query('SELECT * FROM classroom_timers WHERE session_id=$1 FOR UPDATE', [session.id])
      ).rows[0];
      if (data.action === 'start') {
        if (!data.durationSeconds) fail(400, 'Duration required');
        await c.query(
          sqlDialect(
            c,
            "INSERT INTO classroom_timers(session_id,duration_seconds,remaining_ms,deadline,status) VALUES($1,$2,$3,$4,'running') ON CONFLICT(session_id) DO UPDATE SET duration_seconds=EXCLUDED.duration_seconds,remaining_ms=EXCLUDED.remaining_ms,deadline=EXCLUDED.deadline,status=EXCLUDED.status",
            "INSERT INTO classroom_timers(session_id,duration_seconds,remaining_ms,deadline,status) VALUES($1,$2,$3,$4,'running') AS incoming ON DUPLICATE KEY UPDATE duration_seconds=incoming.duration_seconds,remaining_ms=incoming.remaining_ms,deadline=incoming.deadline,status=incoming.status",
          ),
          [
            session.id,
            data.durationSeconds,
            data.durationSeconds * 1000,
            new Date(Date.now() + data.durationSeconds * 1000),
          ],
        );
      } else {
        if (!timer) fail(409, 'Timer not started');
        if (data.action === 'pause') {
          if (timer.status !== 'running') fail(409, 'Timer is not running');
          await c.query(
            "UPDATE classroom_timers SET remaining_ms=$1,deadline=NULL,status='paused' WHERE session_id=$2",
            [Math.max(0, new Date(timer.deadline).getTime() - Date.now()), session.id],
          );
        } else if (data.action === 'resume') {
          if (timer.status !== 'paused' || timer.remaining_ms <= 0)
            fail(409, 'Timer cannot resume');
          await c.query(
            "UPDATE classroom_timers SET deadline=$1,status='running' WHERE session_id=$2",
            [new Date(Date.now() + timer.remaining_ms), session.id],
          );
        } else
          await c.query(
            "UPDATE classroom_timers SET remaining_ms=duration_seconds*1000,deadline=NULL,status='stopped' WHERE session_id=$1",
            [session.id],
          );
      }
      await audit(c, u.id, room.organization_id, 'timer.' + data.action, session.id);
    });
    broadcast(room.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/v1/classrooms/:id/random-student', async (req) => {
    const { u, room } = await access(req, req.params.id, true),
      data = z.object({ clear: z.boolean().optional() }).strict().parse(req.body);
    const selected = await transaction(async (c) => {
      await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [room.id]);
      const auth = await classroomAuthorization(c, room.id, u.id);
      if (!['owner', 'teacher'].includes(auth.role)) fail(403, 'Classroom moderator required');
      let chosen: { id: string; name: string } | null = null;
      if (!data.clear) {
        const ids = liveParticipants(room.id)
          .filter((person) => person.role === 'student')
          .map((person) => person.id);
        if (!ids.length) fail(409, 'No eligible students are online');
        const candidates = (
          await c.query(
            "SELECT u.id,u.name FROM users u JOIN memberships m ON m.user_id=u.id JOIN classrooms r ON r.organization_id=m.organization_id LEFT JOIN classroom_memberships a ON a.classroom_id=r.id AND a.user_id=u.id WHERE r.id=$1 AND m.role='student' AND (r.enrollment_mode='organization' OR a.user_id IS NOT NULL) AND u.id IN (" +
              ids.map((_, index) => '$' + (index + 2)).join(',') +
              ')',
            [room.id, ...ids],
          )
        ).rows;
        if (!candidates.length) fail(409, 'No eligible students are online');
        chosen = candidates[randomInt(candidates.length)] as { id: string; name: string };
      }
      await c.query('UPDATE classrooms SET selected_student_id=$1 WHERE id=$2', [
        chosen?.id ?? null,
        room.id,
      ]);
      await audit(
        c,
        u.id,
        room.organization_id,
        'classroom.student_selected',
        chosen?.id ?? room.id,
      );
      return chosen;
    });
    broadcast(room.id, 'selection_changed');
    return { selectedStudent: selected };
  });
  // Append-only Yjs updates allow concurrent writers without replacing each other's state.
  app.get<{ Params: { id: string } }>('/api/v1/classrooms/:id/documents', async (req) => {
    await access(req, req.params.id);
    return (
      await pool.query(
        'SELECT * FROM collaborative_documents WHERE classroom_id=$1 ORDER BY created_at',
        [req.params.id],
      )
    ).rows;
  });
  app.post<{ Params: { id: string } }>('/api/v1/classrooms/:id/documents', async (req, reply) => {
    const { u, room } = await access(req, req.params.id, true);
    const data = z
      .object({
        name: z.string().trim().min(1).max(120),
        kind: z.enum(['notes', 'board']),
        teacherOnly: z.boolean().default(false),
        boardFormat: z.enum(['legacy', 'excalidraw']).default('legacy'),
      })
      .parse(req.body);
    const id = randomUUID();
    if (data.kind !== 'board' && data.boardFormat !== 'legacy')
      fail(400, 'Only boards support an advanced format');
    await transaction(async (c) => {
      await c.query(
        'INSERT INTO collaborative_documents(id,classroom_id,kind,name,teacher_only,created_by,board_format) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id, room.id, data.kind, data.name, data.teacherOnly, u.id, data.boardFormat],
      );
      if (data.boardFormat === 'excalidraw')
        await c.query('INSERT INTO board_states(document_id,generation) VALUES($1,$2)', [
          id,
          randomUUID(),
        ]);
      await audit(c, u.id, room.organization_id, 'document.created', id);
    });
    broadcast(room.id);
    return reply.code(201).send({ id });
  });
  // Creating the initial board is idempotent, including two moderator tabs joining together.
  app.post<{ Params: { id: string } }>('/api/v1/classrooms/:id/board-book', async (req, reply) => {
    const { u, room } = await access(req, req.params.id, true);
    const data = z
      .object({ name: z.string().trim().min(1).max(120).optional() })
      .strict()
      .parse(req.body);
    const id = await transaction(async (c) => {
      await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [room.id]);
      const auth = await classroomAuthorization(c, room.id, u.id);
      if (!['owner', 'teacher'].includes(auth.role)) fail(403, 'Forbidden');
      const existing = (
        await c.query(
          "SELECT id FROM collaborative_documents WHERE classroom_id=$1 AND kind='board' AND board_format='excalidraw' AND board_book_id IS NULL ORDER BY created_at LIMIT 1",
          [room.id],
        )
      ).rows[0];
      if (existing) return existing.id as string;
      const id = randomUUID();
      await c.query(
        "INSERT INTO collaborative_documents(id,classroom_id,kind,name,teacher_only,created_by,board_format) VALUES($1,$2,'board',$3,false,$4,'excalidraw')",
        [id, room.id, data.name ?? 'Whiteboard', u.id],
      );
      await c.query('INSERT INTO board_states(document_id,generation) VALUES($1,$2)', [
        id,
        randomUUID(),
      ]);
      await audit(c, u.id, room.organization_id, 'board.book_created', id);
      return id;
    });
    broadcast(room.id, 'document_changed');
    return reply.code(200).send({ id });
  });
  app.post<{ Params: { id: string; doc: string } }>(
    '/api/v1/classrooms/:id/documents/:doc/pages',
    async (req, reply) => {
      const { u, room } = await access(req, req.params.id);
      z.object({}).strict().parse(req.body);
      const selected = (
        await pool.query(
          "SELECT * FROM collaborative_documents WHERE id=$1 AND classroom_id=$2 AND kind='board'",
          [idSchema.parse(req.params.doc), room.id],
        )
      ).rows[0];
      if (!selected || selected.board_format !== 'excalidraw') fail(404, 'Board not found');
      const rootId = selected.board_book_id ?? selected.id;
      const result = await transaction(async (c) => {
        const root = (
          await c.query(
            'SELECT * FROM collaborative_documents WHERE id=$1 AND classroom_id=$2 FOR UPDATE',
            [rootId, room.id],
          )
        ).rows[0];
        if (!root || root.board_book_id) fail(404, 'Board not found');
        const auth = await classroomAuthorization(c, room.id, u.id);
        if (
          !['owner', 'teacher'].includes(auth.role) &&
          !resolveUserPermissions(auth.room, auth.role, auth.room._userPerm).isPresenter
        )
          fail(403, 'Only the presenter can add a page');
        if (!canEditWhiteboard(auth.room, auth.role, Boolean(root.teacher_only)))
          fail(403, 'Board is read only');
        const pages = (
          await c.query(
            'SELECT board_page_index FROM collaborative_documents WHERE board_book_id=$1',
            [rootId],
          )
        ).rows;
        if (pages.length >= 99) fail(409, 'Board page limit reached');
        const index =
          Math.max(Number(root.board_page_index), ...pages.map((p) => Number(p.board_page_index))) +
          1;
        const id = randomUUID();
        await c.query(
          "INSERT INTO collaborative_documents(id,classroom_id,kind,name,teacher_only,created_by,board_format,board_book_id,board_page_index) VALUES($1,$2,'board',$3,$4,$5,'excalidraw',$6,$7)",
          [id, room.id, 'Page ' + index, Boolean(root.teacher_only), u.id, rootId, index],
        );
        await c.query('INSERT INTO board_states(document_id,generation) VALUES($1,$2)', [
          id,
          randomUUID(),
        ]);
        await audit(c, u.id, room.organization_id, 'board.page_created', id);
        return { id, boardBookId: rootId, pageIndex: index };
      });
      broadcast(room.id, 'document_changed');
      return reply.code(201).send(result);
    },
  );
  app.post<{ Params: { id: string; doc: string } }>(
    '/api/v1/classrooms/:id/documents/:doc/background',
    async (req) => {
      const { u, room } = await access(req, req.params.id, true);
      const data = z
        .object({
          fileId: z.uuid(),
          width: z.number().int().min(1).max(4096),
          height: z.number().int().min(1).max(4096),
        })
        .strict()
        .parse(req.body);
      await transaction(async (c) => {
        const auth = await classroomAuthorization(c, room.id, u.id);
        await assertPlatformFeature(c, 'pdfImportEnabled');
        if (!['owner', 'teacher'].includes(auth.role)) fail(403, 'Forbidden');
        const doc = (
          await c.query(
            'SELECT * FROM collaborative_documents WHERE id=$1 AND classroom_id=$2 FOR UPDATE',
            [idSchema.parse(req.params.doc), room.id],
          )
        ).rows[0];
        if (!doc || doc.kind !== 'board' || doc.board_format !== 'excalidraw')
          fail(404, 'Board not found');
        const file = (await c.query('SELECT * FROM files WHERE id=$1 FOR UPDATE', [data.fileId]))
          .rows[0];
        if (
          !file ||
          file.classroom_id !== room.id ||
          file.organization_id !== room.organization_id ||
          file.purpose !== 'board' ||
          file.status !== 'ready' ||
          !['image/png', 'image/jpeg', 'image/webp'].includes(file.media_type)
        )
          fail(404, 'Image not available');
        // A page background is immutable, so peer annotations keep their coordinates.
        if (
          doc.background_file_id &&
          (doc.background_file_id !== file.id ||
            Number(doc.background_width) !== data.width ||
            Number(doc.background_height) !== data.height)
        )
          fail(409, 'Board background already set');
        await c.query(
          'UPDATE collaborative_documents SET background_file_id=$1,background_width=$2,background_height=$3 WHERE id=$4',
          [file.id, data.width, data.height, doc.id],
        );
        await audit(c, u.id, room.organization_id, 'board.background_set', doc.id);
      });
      broadcast(room.id, 'document_changed');
      return { ok: true };
    },
  );
  async function document(
    req: { cookies: Record<string, string | undefined> },
    roomId: string,
    docId: string,
    write = false,
  ) {
    const a = await access(req, roomId);
    const d = (
      await pool.query('SELECT * FROM collaborative_documents WHERE id=$1 AND classroom_id=$2', [
        idSchema.parse(docId),
        roomId,
      ])
    ).rows[0];
    if (!d) fail(404, 'Document not found');
    const effective = resolveUserPermissions(
      a.room,
      a.role,
      a.room._userPerm as Record<string, unknown> | undefined,
    );
    const allowStudentBoard = d.kind === 'board' && effective.canWhiteboard;
    if (write && effective.interactionLocked) fail(403, 'Document is read only');
    if (write && d.kind === 'notes' && !effective.canSharedNotes)
      fail(403, 'Document is read only');
    if (write && d.teacher_only && !allowStudentBoard && a.role === 'student')
      fail(403, 'Document is read only');
    if (write && d.kind === 'board' && !canEditWhiteboard(a.room, a.role, Boolean(d.teacher_only)))
      fail(403, 'Board is read only');
    return { ...a, d };
  }
  app.get<{ Params: { id: string; doc: string } }>(
    '/api/v1/classrooms/:id/documents/:doc',
    async (req) => {
      const { d } = await document(req, req.params.id, req.params.doc);
      const updates = (
        await pool.query('SELECT id,update_base64 FROM document_updates WHERE document_id=$1', [
          d.id,
        ])
      ).rows;
      return { document: d, updates };
    },
  );
  app.post<{ Params: { id: string; doc: string } }>(
    '/api/v1/classrooms/:id/documents/:doc/updates',
    async (req) => {
      const { u, room, d } = await document(req, req.params.id, req.params.doc, true);
      const data = z
        .object({
          id: z.uuid(),
          update: z
            .string()
            .min(1)
            .max(24000)
            .regex(/^[A-Za-z0-9+/]*={0,2}$/),
        })
        .parse(req.body);
      const bytes = Buffer.from(data.update, 'base64');
      await transaction(async (c) => {
        const locked = (
          await c.query('SELECT * FROM collaborative_documents WHERE id=$1 FOR UPDATE', [d.id])
        ).rows[0];
        if (locked.board_format === 'excalidraw')
          fail(400, 'Use the advanced board update endpoint');
        const authorization = await classroomAuthorization(c, room.id, u.id);
        const role = authorization.role;
        const freshRoom = authorization.room;
        const effective = resolveUserPermissions(freshRoom, role, freshRoom._userPerm);
        const allowStudentBoard = locked.kind === 'board' && effective.canWhiteboard;
        if (effective.interactionLocked) fail(403, 'Document is read only');
        if (locked.kind === 'notes' && !effective.canSharedNotes)
          fail(403, 'Document is read only');
        if (locked.teacher_only && !allowStudentBoard && role === 'student')
          fail(403, 'Document is read only');
        if (
          locked.kind === 'board' &&
          !canEditWhiteboard(freshRoom, role, Boolean(locked.teacher_only))
        )
          fail(403, 'Board is read only');
        const existing = (
          await c.query('SELECT id,update_base64 FROM document_updates WHERE document_id=$1', [
            d.id,
          ])
        ).rows;
        if (existing.some((v) => v.id === data.id)) return;
        if (
          existing.reduce((n, v) => n + v.update_base64.length, 0) + data.update.length >
          5_000_000
        )
          fail(413, 'Document storage limit reached');
        const ydoc = new Y.Doc();
        try {
          for (const v of existing) Y.applyUpdate(ydoc, Buffer.from(v.update_base64, 'base64'));
          Y.applyUpdate(ydoc, bytes);
          if (d.kind === 'notes') {
            if (ydoc.getText('content').length > 10000) fail(400, 'Notes exceed 10000 characters');
          } else {
            const shapes = ydoc.getMap('shapes');
            if (shapes.size > 5000) fail(400, 'Board exceeds 5000 objects');
            const point = z.tuple([
              z.number().finite().min(-1e7).max(1e7),
              z.number().finite().min(-1e7).max(1e7),
            ]);
            const shape = z
              .object({
                type: z.enum(['pen', 'rectangle', 'ellipse', 'text']),
                points: z.array(point).min(1).max(256),
                color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
                text: z.string().max(500).optional(),
              })
              .strict();
            for (const [id, value] of shapes) {
              idSchema.parse(id);
              shape.parse(value);
            }
          }
        } catch (e) {
          if (e instanceof z.ZodError || !(e instanceof Error) || !('statusCode' in e))
            fail(400, 'Invalid collaborative document update');
          throw e;
        } finally {
          ydoc.destroy();
        }
        await c.query(
          'INSERT INTO document_updates(id,document_id,author_id,update_base64) VALUES($1,$2,$3,$4)',
          [data.id, d.id, u.id, data.update],
        );
      });
      broadcast(room.id, 'document_changed');
      return { ok: true };
    },
  );
}
