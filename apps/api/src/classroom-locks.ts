import type { FastifyInstance } from 'fastify';
import type { TeachingContext } from './teaching.js';
import type { DatabaseConnection } from './database.js';
import { classroomAuthorization } from './classroom-access.js';
import { lockPolicySchema, roomLockPolicy } from './classroom-lock-policy.js';
import { transaction, audit } from './db.js';
import { fail } from './errors.js';
import { z } from 'zod';
export async function registerClassroomLocks(
  app: FastifyInstance,
  ctx: TeachingContext,
  enqueue: (c: DatabaseConnection, id: string) => Promise<void>,
) {
  const base = '/api/v1/classrooms/:id/locks';
  app.get<{ Params: { id: string } }>(base, async (req) => {
    const u = await ctx.user(req),
      room = await ctx.roomAccess(z.uuid().parse(req.params.id), u.id);
    return { locks: roomLockPolicy(room.locks_json), revision: Number(room.lock_revision ?? 0) };
  });
  app.post<{ Params: { id: string } }>(base, async (req) => {
    const u = await ctx.user(req),
      room = await ctx.roomAccess(z.uuid().parse(req.params.id), u.id);
    const data = z
      .object({ locks: lockPolicySchema, expectedRevision: z.number().int().min(0) })
      .strict()
      .parse(req.body);
    const affected = new Set<string>([room.id]);
    const result = await transaction(ctx.pool, async (c) => {
      await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [room.id]);
      const auth = await classroomAuthorization(c, room.id, u.id);
      if (!['owner', 'teacher'].includes(auth.role)) fail(403, 'Classroom moderator required');
      if (Number(auth.room.lock_revision) !== data.expectedRevision)
        fail(409, 'Classroom locks changed; refresh before saving');
      await c.query(
        'UPDATE classrooms SET locks_json=$1,lock_revision=lock_revision+1 WHERE id=$2',
        [JSON.stringify(data.locks), room.id],
      );
      if (data.locks.raiseHand)
        await c.query(
          'DELETE FROM hand_raises WHERE session_id IN (SELECT id FROM classroom_sessions WHERE active_key=$1)',
          [room.id],
        );
      await enqueue(c, room.id);
      const children = (
        await c.query(
          "SELECT b.classroom_id FROM breakout_rooms b JOIN breakout_groups g ON g.id=b.group_id JOIN classroom_sessions s ON s.id=g.parent_session_id WHERE s.classroom_id=$1 AND g.status='active'",
          [room.id],
        )
      ).rows;
      for (const child of children) {
        await c.query(
          'UPDATE classrooms SET locks_json=$1,lock_revision=lock_revision+1 WHERE id=$2',
          [JSON.stringify(data.locks), child.classroom_id],
        );
        await enqueue(c, child.classroom_id);
        affected.add(child.classroom_id);
      }
      await audit(c, u.id, room.organization_id, 'classroom.locks_updated', room.id, data.locks);
      return { locks: data.locks, revision: data.expectedRevision + 1 };
    });
    for (const id of affected)
      (app as unknown as { notifyClassroom: (id: string, type: string) => void }).notifyClassroom(
        id,
        'locks_changed',
      );
    return result;
  });
}
