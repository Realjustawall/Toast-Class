import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { DatabasePool } from './database.js';
import type { TeachingContext } from './teaching.js';
import { classroomAuthorization } from './classroom-access.js';
import { resolveUserPermissions } from './app.js';
import { readPlatformOptions } from './platform-options.js';
import { transaction, audit } from './db.js';
import { fail } from './errors.js';
type Query = Pick<DatabasePool, 'query'>;
export async function readChatPolicy(c: Query, id: string) {
  const p = (
    await c.query(
      'SELECT public_enabled,private_enabled,revision FROM classroom_chat_policies WHERE classroom_id=$1',
      [id],
    )
  ).rows[0];
  return {
    publicEnabled: p ? !!p.public_enabled : true,
    privateEnabled: p ? !!p.private_enabled : true,
    revision: Number(p?.revision ?? 0),
  };
}
export async function assertPublicChat(c: Query, id: string) {
  if (!(await readChatPolicy(c, id)).publicEnabled)
    fail(403, 'Public chat is disabled for this classroom');
}
function privateAllowed(auth: Awaited<ReturnType<typeof classroomAuthorization>>) {
  const p = resolveUserPermissions(auth.room, auth.role, auth.room._userPerm);
  return (
    ['owner', 'teacher'].includes(auth.role) ||
    (!p.interactionLocked && p.overrides.canChat !== false)
  );
}
export async function registerPrivateChat(app: FastifyInstance, ctx: TeachingContext) {
  const base = '/api/v1/classrooms/:id',
    notify = (id: string, users: string[]) =>
      (
        app as unknown as {
          notifyClassroomUsers: (id: string, users: string[], type: string) => void;
        }
      ).notifyClassroomUsers(id, users, 'private_chat_changed');
  app.get<{ Params: { id: string } }>(
    base + '/chat-policy',
    { config: { rateLimit: { max: 360, timeWindow: '1 minute' } } },
    async (req) => {
      const u = await ctx.user(req),
        id = z.uuid().parse(req.params.id),
        auth = await classroomAuthorization(ctx.pool, id, u.id),
        policy = await readChatPolicy(ctx.pool, id);
      const parent = (
        await ctx.pool.query(
          'SELECT s.classroom_id FROM breakout_rooms b JOIN breakout_groups g ON g.id=b.group_id JOIN classroom_sessions s ON s.id=g.parent_session_id WHERE b.classroom_id=$1',
          [id],
        )
      ).rows[0];
      const root = parent
        ? (
            await ctx.pool.query('SELECT id,enrollment_mode FROM classrooms WHERE id=$1', [
              parent.classroom_id,
            ])
          ).rows[0]
        : auth.room;
      const participants = (
        await ctx.pool.query(
          "SELECT u.id,u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN classroom_memberships cm ON cm.user_id=u.id AND cm.classroom_id=$2 LEFT JOIN classroom_user_permissions p ON p.classroom_id=$3 AND p.user_id=u.id WHERE m.organization_id=$1 AND u.id<>$4 AND (m.role='owner' OR $5=true OR cm.user_id IS NOT NULL) AND (p.kicked IS NULL OR p.kicked=false) ORDER BY u.name,u.id LIMIT 1000",
          [auth.room.organization_id, root.id, id, u.id, root.enrollment_mode === 'organization'],
        )
      ).rows;
      const unread = (
        await ctx.pool.query(
          'SELECT sender_id AS user_id,COUNT(*) AS count FROM private_chat_messages WHERE classroom_id=$1 AND recipient_id=$2 AND deleted=false AND read_at IS NULL GROUP BY sender_id',
          [id, u.id],
        )
      ).rows.map((r) => ({ userId: r.user_id, count: Number(r.count) }));
      return {
        ...policy,
        canManage: ['owner', 'teacher'].includes(auth.role),
        canSendPrivate: policy.privateEnabled && privateAllowed(auth),
        participants,
        unread,
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    base + '/chat-policy',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const u = await ctx.user(req),
        id = z.uuid().parse(req.params.id),
        data = z
          .object({
            publicEnabled: z.boolean(),
            privateEnabled: z.boolean(),
            expectedRevision: z.number().int().min(0),
          })
          .strict()
          .parse(req.body);
      const result = await transaction(ctx.pool, async (c) => {
        await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [id]);
        const auth = await classroomAuthorization(c, id, u.id);
        if (!['owner', 'teacher'].includes(auth.role))
          fail(403, 'Only a moderator can change chat permissions');
        const old = await readChatPolicy(c, id);
        if (old.revision !== data.expectedRevision)
          fail(409, 'Chat permissions changed; refresh before saving');
        const revision = old.revision + 1;
        if (old.revision)
          await c.query(
            'UPDATE classroom_chat_policies SET public_enabled=$1,private_enabled=$2,revision=$3,updated_by=$4,updated_at=CURRENT_TIMESTAMP(3) WHERE classroom_id=$5',
            [data.publicEnabled, data.privateEnabled, revision, u.id, id],
          );
        else
          await c.query(
            'INSERT INTO classroom_chat_policies(classroom_id,public_enabled,private_enabled,revision,updated_by) VALUES($1,$2,$3,$4,$5)',
            [id, data.publicEnabled, data.privateEnabled, revision, u.id],
          );
        await audit(c, u.id, auth.room.organization_id, 'classroom.chat_policy_changed', id, {
          publicEnabled: data.publicEnabled,
          privateEnabled: data.privateEnabled,
          revision,
        });
        return { ...data, revision };
      });
      (app as unknown as { notifyClassroom: (id: string, type: string) => void }).notifyClassroom(
        id,
        'chat_policy_changed',
      );
      return result;
    },
  );
  type Params = { id: string; peer: string; messageId: string };
  const path = base + '/private-chats/:peer/messages';
  async function access(c: Query, id: string, uid: string, peer: string, send = false) {
    z.uuid().parse(id);
    z.uuid().parse(peer);
    if (peer === uid) fail(400, 'Choose another participant');
    const auth = await classroomAuthorization(c, id, uid);
    await classroomAuthorization(c, id, peer);
    if (send && (!(await readChatPolicy(c, id)).privateEnabled || !privateAllowed(auth)))
      fail(403, 'Private chat is disabled for this classroom');
    return auth;
  }
  app.get<{ Params: Params }>(
    path,
    { config: { rateLimit: { max: 900, timeWindow: '1 minute' } } },
    async (req) => {
      const u = await ctx.user(req),
        { id, peer } = req.params;
      await access(ctx.pool, id, u.id, peer);
      const limit = (await readPlatformOptions(ctx.pool)).chatHistoryLimit;
      const rows = (
        await ctx.pool.query(
          'SELECT m.id,m.body,m.sender_id AS user_id,m.recipient_id,m.created_at,u.name,r.role FROM private_chat_messages m JOIN users u ON u.id=m.sender_id LEFT JOIN memberships r ON r.user_id=u.id AND r.organization_id=$4 WHERE m.classroom_id=$1 AND m.deleted=false AND ((m.sender_id=$2 AND m.recipient_id=$3) OR (m.sender_id=$3 AND m.recipient_id=$2)) ORDER BY m.created_at DESC,m.id DESC LIMIT ' +
            limit,
          [id, u.id, peer, (await classroomAuthorization(ctx.pool, id, u.id)).room.organization_id],
        )
      ).rows.reverse();
      const read = await ctx.pool.query(
        'UPDATE private_chat_messages SET read_at=CURRENT_TIMESTAMP(3) WHERE classroom_id=$1 AND sender_id=$2 AND recipient_id=$3 AND deleted=false AND read_at IS NULL',
        [id, peer, u.id],
      );
      if (read.rowCount) notify(id, [u.id]);
      return rows;
    },
  );
  app.post<{ Params: Params }>(
    path,
    { config: { rateLimit: { max: 180, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const u = await ctx.user(req),
        { id, peer } = req.params,
        data = z
          .object({ body: z.string().trim().min(1).max(2000), clientMessageId: z.uuid() })
          .strict()
          .parse(req.body);
      const result = await transaction(ctx.pool, async (c) => {
        await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [z.uuid().parse(id)]);
        const auth = await access(c, id, u.id, peer, true);
        if (data.body.length > (await readPlatformOptions(c)).chatMessageMaxLength)
          fail(400, 'Message exceeds the platform length limit');
        const digest = createHash('sha256')
          .update(JSON.stringify([peer, data.body]))
          .digest('hex');
        await c.query(
          'DELETE FROM private_chat_messages WHERE classroom_id=$1 AND sender_id=$2 AND deleted=true AND created_at<$3',
          [id, u.id, new Date(Date.now() - 86400000)],
        );
        const old = (
          await c.query(
            'SELECT id,digest FROM private_chat_messages WHERE classroom_id=$1 AND sender_id=$2 AND client_message_id=$3',
            [id, u.id, data.clientMessageId],
          )
        ).rows[0];
        if (old) {
          if (old.digest !== digest)
            fail(409, 'Message request ID was already used for different content');
          return { id: old.id, replayed: true };
        }
        const messageId = randomUUID();
        await c.query(
          'INSERT INTO private_chat_messages(id,classroom_id,sender_id,recipient_id,client_message_id,digest,body) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [messageId, id, u.id, peer, data.clientMessageId, digest, data.body],
        );
        await audit(c, u.id, auth.room.organization_id, 'private_chat.sent', messageId);
        return { id: messageId, replayed: false };
      });
      notify(id, [u.id, peer]);
      return reply.code(201).send(result);
    },
  );
  for (const action of ['edit', 'delete'] as const)
    app.post<{ Params: Params }>(
      path + '/:messageId/' + action,
      { config: { rateLimit: { max: 180, timeWindow: '1 minute' } } },
      async (req) => {
        const u = await ctx.user(req),
          { id, peer } = req.params,
          messageId = z.uuid().parse(req.params.messageId),
          data =
            action === 'edit'
              ? z
                  .object({
                    body: z.string().trim().min(1).max(2000),
                    expectedBody: z.string().max(2000),
                  })
                  .strict()
                  .parse(req.body)
              : null;
        await transaction(ctx.pool, async (c) => {
          await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [z.uuid().parse(id)]);
          const auth = await access(c, id, u.id, peer, action === 'edit');
          const row = (
            await c.query(
              'SELECT sender_id,recipient_id,body FROM private_chat_messages WHERE id=$1 AND classroom_id=$2 AND deleted=false FOR UPDATE',
              [messageId, id],
            )
          ).rows[0];
          if (!row || row.sender_id !== u.id || row.recipient_id !== peer)
            fail(404, 'Private message not found');
          if (data) {
            if (data.body.length > (await readPlatformOptions(c)).chatMessageMaxLength)
              fail(400, 'Message exceeds the platform length limit');
            if (row.body !== data.expectedBody) fail(409, 'Message changed; reload before editing');
            await c.query('UPDATE private_chat_messages SET body=$1 WHERE id=$2', [
              data.body,
              messageId,
            ]);
          } else
            await c.query("UPDATE private_chat_messages SET body='',deleted=true WHERE id=$1", [
              messageId,
            ]);
          await audit(
            c,
            u.id,
            auth.room.organization_id,
            'private_chat.' + (action === 'edit' ? 'edited' : 'deleted'),
            messageId,
          );
        });
        notify(id, [u.id, peer]);
        return { ok: true };
      },
    );
}
