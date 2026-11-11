import type { FastifyInstance } from 'fastify';
import type { DatabasePool, DatabaseConnection } from './database.js';
import type { TeachingContext } from './teaching.js';
import { transaction } from './db.js';
import { fail } from './errors.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

type Query = Pick<DatabasePool, 'query'>;
// Use the transaction connection for writes so a queued request cannot reuse an
// old permission result after a moderator changes access.
export async function classroomAuthorization(c: Query, classroomId: string, userId: string) {
  const room = (
    await c.query('SELECT * FROM classrooms WHERE id=$1', [z.uuid().parse(classroomId)])
  ).rows[0];
  if (!room) fail(404, 'Classroom not found');
  const member = (
    await c.query('SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2', [
      room.organization_id,
      userId,
    ])
  ).rows[0];
  if (!member || !['owner', 'teacher', 'student'].includes(member.role))
    fail(403, 'Permission denied');
  const role = member.role as string;
  if (!(await hasClassroomAccess(c, room.id, userId, role)))
    fail(403, 'Classroom access is not assigned');
  if (room.locked && role === 'student') fail(403, 'Classroom is locked by moderator');
  const permission =
    (
      await c.query(
        'SELECT * FROM classroom_user_permissions WHERE classroom_id=$1 AND user_id=$2',
        [room.id, userId],
      )
    ).rows[0] ?? null;
  if (permission?.kicked && role === 'student') fail(403, 'Removed from classroom by moderator');
  return { room: { ...room, _userPerm: permission }, role };
}
export const enrollmentSchema = z.object({
  enrollmentMode: z.enum(['assigned', 'organization']).default('assigned'),
  memberIds: z.array(z.uuid()).max(1000).default([]),
});

export async function hasClassroomAccess(
  c: Query,
  classroomId: string,
  userId: string,
  role: string,
) {
  if (role === 'owner') return true;
  const parent = (
    await c.query(
      'SELECT s.classroom_id AS parent_id FROM breakout_rooms b JOIN breakout_groups g ON g.id=b.group_id JOIN classroom_sessions s ON s.id=g.parent_session_id WHERE b.classroom_id=$1',
      [classroomId],
    )
  ).rows[0];
  const rootId = parent?.parent_id ?? classroomId;
  const access = (
    await c.query(
      'SELECT c.enrollment_mode,m.user_id FROM classrooms c LEFT JOIN classroom_memberships m ON m.classroom_id=c.id AND m.user_id=$2 WHERE c.id=$1',
      [rootId, userId],
    )
  ).rows[0];
  return !!access && (access.enrollment_mode === 'organization' || !!access.user_id);
}

export async function saveClassroomEnrollment(
  c: DatabaseConnection,
  roomId: string,
  orgId: string,
  data: z.infer<typeof enrollmentSchema>,
) {
  const current = (
    await c.query(
      'SELECT enrollment_mode FROM classrooms WHERE id=$1 AND organization_id=$2 FOR UPDATE',
      [roomId, orgId],
    )
  ).rows[0];
  if (!current) fail(404, 'Classroom not found');
  const members = (
    await c.query('SELECT user_id,role FROM memberships WHERE organization_id=$1', [orgId])
  ).rows;
  const selected = [...new Set(data.memberIds)];
  if (selected.some((id) => !members.some((member) => member.user_id === id)))
    fail(400, 'Every classroom member must belong to this organization');
  const previous = new Set(
    (
      await c.query('SELECT user_id FROM classroom_memberships WHERE classroom_id=$1', [roomId])
    ).rows.map((row) => row.user_id),
  );
  await c.query('UPDATE classrooms SET enrollment_mode=$1 WHERE id=$2', [
    data.enrollmentMode,
    roomId,
  ]);
  await c.query('DELETE FROM classroom_memberships WHERE classroom_id=$1', [roomId]);
  for (const id of selected)
    await c.query('INSERT INTO classroom_memberships(classroom_id,user_id) VALUES($1,$2)', [
      roomId,
      id,
    ]);
  const removed = members.filter(
    (member) =>
      member.role !== 'owner' &&
      (current.enrollment_mode === 'organization' || previous.has(member.user_id)) &&
      data.enrollmentMode === 'assigned' &&
      !selected.includes(member.user_id),
  );
  if (removed.length) {
    const sessions = (
      await c.query(
        'SELECT s.id FROM classroom_sessions s LEFT JOIN breakout_rooms b ON b.classroom_id=s.classroom_id LEFT JOIN breakout_groups g ON g.id=b.group_id LEFT JOIN classroom_sessions p ON p.id=g.parent_session_id WHERE s.ended_at IS NULL AND (s.classroom_id=$1 OR p.classroom_id=$1)',
        [roomId],
      )
    ).rows;
    for (const session of sessions)
      for (const member of removed)
        await c.query(
          'INSERT INTO media_commands(id,session_id,user_id,kind,payload) VALUES($1,$2,$3,$4,$5)',
          [
            randomUUID(),
            session.id,
            member.user_id,
            'remove',
            JSON.stringify({ reason: 'enrollment_revoked' }),
          ],
        );
  }
}

export async function registerClassroomAccess(app: FastifyInstance, ctx: TeachingContext) {
  const base = '/api/v1/classrooms/:id/access';
  async function owner(req: { cookies: Record<string, string | undefined> }, id: string) {
    const user = await ctx.user(req);
    const room = await ctx.roomAccess(z.uuid().parse(id), user.id);
    if ((await ctx.membership(room.organization_id, user.id)) !== 'owner')
      fail(403, 'Organization owner required');
    return { user, room };
  }
  app.get<{ Params: { id: string } }>(base, async (req) => {
    const { room } = await owner(req, req.params.id);
    const members = (
      await ctx.pool.query(
        'SELECT u.id,u.name,u.email,m.role,a.user_id AS assigned_user FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN classroom_memberships a ON a.classroom_id=$2 AND a.user_id=u.id WHERE m.organization_id=$1 ORDER BY u.name,u.id',
        [room.organization_id, room.id],
      )
    ).rows;
    return {
      enrollmentMode: room.enrollment_mode,
      members: members.map((member) => ({
        id: member.id,
        name: member.name,
        email: member.email,
        role: member.role,
        assigned: !!member.assigned_user,
        hasAccess:
          member.role === 'owner' ||
          room.enrollment_mode === 'organization' ||
          !!member.assigned_user,
      })),
    };
  });
  app.post<{ Params: { id: string } }>(base, async (req) => {
    const { user, room } = await owner(req, req.params.id);
    const data = enrollmentSchema.strict().parse(req.body);
    await transaction(ctx.pool, async (c) => {
      await saveClassroomEnrollment(c, room.id, room.organization_id, data);
      await c.query(
        'INSERT INTO audit_logs(id,actor_id,organization_id,action,resource_id,details) VALUES($1,$2,$3,$4,$5,$6)',
        [
          randomUUID(),
          user.id,
          room.organization_id,
          'classroom.access_updated',
          room.id,
          JSON.stringify(data),
        ],
      );
    });
    (app as unknown as { notifyClassroom: (id: string) => void }).notifyClassroom(room.id);
    return { ok: true, ...data };
  });
}
