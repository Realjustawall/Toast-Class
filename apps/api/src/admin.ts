import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { classroomPermissionsSchema, classroomThemeSchema, formatRoomSettings } from './app.js';
import { transaction } from './db.js';
import { fail } from './errors.js';
import type { TeachingContext } from './teaching.js';
import { enrollmentSchema, saveClassroomEnrollment } from './classroom-access.js';

/** Organization administration never grants platform-wide visibility. */
export async function registerAdmin(app: FastifyInstance, ctx: TeachingContext) {
  const base = '/api/v1/organizations/:id/admin';
  const pagination = z.object({
    offset: z.coerce.number().int().min(0).max(100000).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  });
  async function access(req: { cookies: Record<string, string | undefined> }, id: string) {
    const u = await ctx.user(req);
    const org = z.uuid().parse(id);
    if ((await ctx.membership(org, u.id)) !== 'owner') fail(403, 'Organization owner required');
    return { org, user: u };
  }
  app.get<{ Params: { id: string } }>(base + '/overview', async (req) => {
    const { org } = await access(req, req.params.id);
    const [organization, members, rooms, active, files, presentations, sessions, classroomRows] =
      await Promise.all([
        ctx.pool.query(
          'SELECT id,name,storage_quota_bytes,default_classroom_theme FROM organizations WHERE id=$1',
          [org],
        ),
        ctx.pool.query(
          'SELECT role,COUNT(*) AS count FROM memberships WHERE organization_id=$1 GROUP BY role',
          [org],
        ),
        ctx.pool.query('SELECT COUNT(*) AS count FROM classrooms WHERE organization_id=$1', [org]),
        ctx.pool.query(
          'SELECT COUNT(*) AS count FROM classroom_sessions s JOIN classrooms c ON c.id=s.classroom_id WHERE c.organization_id=$1 AND s.ended_at IS NULL',
          [org],
        ),
        ctx.pool.query(
          "SELECT status,COUNT(*) AS count,COALESCE(SUM(byte_size),0) AS bytes FROM files WHERE organization_id=$1 AND status<>'deleted' GROUP BY status",
          [org],
        ),
        ctx.pool.query(
          "SELECT status,COUNT(*) AS count,COALESCE(SUM(reserved_bytes),0) AS reserved_bytes FROM presentations WHERE organization_id=$1 AND status<>'deleted' GROUP BY status",
          [org],
        ),
        ctx.pool.query(
          'SELECT s.id,s.classroom_id,c.name,s.started_at FROM classroom_sessions s JOIN classrooms c ON c.id=s.classroom_id WHERE c.organization_id=$1 AND s.ended_at IS NULL ORDER BY s.started_at DESC,s.id DESC LIMIT 100',
          [org],
        ),
        ctx.pool.query(
          'SELECT c.id,c.name,c.theme,c.locked,c.chat_enabled,c.hand_raise_enabled,c.student_whiteboard_enabled,c.default_microphone,c.default_camera,c.default_screen_share,c.created_at FROM classrooms c LEFT JOIN breakout_rooms b ON b.classroom_id=c.id WHERE c.organization_id=$1 AND b.classroom_id IS NULL ORDER BY c.created_at DESC LIMIT 100',
          [org],
        ),
      ]);
    return {
      organization: organization.rows[0],
      asOf: new Date().toISOString(),
      members: members.rows,
      classroomCount: Number(rooms.rows[0].count),
      activeSessionCount: Number(active.rows[0].count),
      files: files.rows,
      presentations: presentations.rows,
      activeSessions: sessions.rows,
      classrooms: classroomRows.rows.map((row) => ({
        ...row,
        ...formatRoomSettings(row),
      })),
    };
  });
  app.post<{ Params: { id: string } }>(base + '/theme', async (req) => {
    const { org, user } = await access(req, req.params.id);
    const data = z
      .object({
        defaultClassroomTheme: classroomThemeSchema,
        applyToExisting: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    let updatedRooms: string[] = [];
    await transaction(ctx.pool, async (c) => {
      await c.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [org]);
      await c.query('UPDATE organizations SET default_classroom_theme=$1 WHERE id=$2', [
        data.defaultClassroomTheme,
        org,
      ]);
      if (data.applyToExisting) {
        const rooms = (await c.query('SELECT id FROM classrooms WHERE organization_id=$1', [org]))
          .rows;
        updatedRooms = rooms.map((r) => r.id as string);
        await c.query('UPDATE classrooms SET theme=$1 WHERE organization_id=$2', [
          data.defaultClassroomTheme,
          org,
        ]);
      }
      await c.query(
        'INSERT INTO audit_logs(id,actor_id,organization_id,action,resource_id,details) VALUES($1,$2,$3,$4,$3,$5)',
        [
          randomUUID(),
          user.id,
          org,
          'organization.theme_updated',
          JSON.stringify({
            defaultClassroomTheme: data.defaultClassroomTheme,
            applyToExisting: Boolean(data.applyToExisting),
          }),
        ],
      );
    });
    const notify = (app as unknown as { notifyClassroom?: (id: string) => void }).notifyClassroom;
    if (notify) for (const roomId of updatedRooms) notify(roomId);
    return {
      ok: true,
      defaultClassroomTheme: data.defaultClassroomTheme,
      updatedClassrooms: updatedRooms.length,
    };
  });
  app.post<{ Params: { id: string; userId: string } }>(
    base + '/members/:userId/role',
    async (req) => {
      const { org, user } = await access(req, req.params.id);
      const targetId = z.uuid().parse(req.params.userId);
      const data = z
        .object({ role: z.enum(['teacher', 'student']) })
        .strict()
        .parse(req.body);
      await transaction(ctx.pool, async (c) => {
        const current = (
          await c.query(
            'SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE',
            [org, targetId],
          )
        ).rows[0];
        if (!current) fail(404, 'Member not found');
        if (current.role === 'owner') fail(403, 'Cannot change organization owner role');
        await c.query('UPDATE memberships SET role=$1 WHERE organization_id=$2 AND user_id=$3', [
          data.role,
          org,
          targetId,
        ]);
        await c.query(
          'INSERT INTO audit_logs(id,actor_id,organization_id,action,resource_id,details) VALUES($1,$2,$3,$4,$5,$6)',
          [
            randomUUID(),
            user.id,
            org,
            'member.role_changed',
            targetId,
            JSON.stringify({ previousRole: current.role, role: data.role }),
          ],
        );
      });
      return { ok: true, userId: targetId, role: data.role };
    },
  );
  app.post<{ Params: { id: string; roomId: string } }>(
    base + '/classrooms/:roomId/settings',
    async (req) => {
      const { org, user } = await access(req, req.params.id);
      const roomId = z.uuid().parse(req.params.roomId);
      const data = z
        .object({
          name: z.string().trim().min(2).max(120).optional(),
          theme: classroomThemeSchema.optional(),
          permissions: classroomPermissionsSchema.optional(),
          enrollmentMode: z.enum(['assigned', 'organization']).optional(),
          memberIds: z.array(z.uuid()).max(1000).optional(),
        })
        .strict()
        .parse(req.body);
      const updated = await transaction(ctx.pool, async (c) => {
        const current = (
          await c.query('SELECT * FROM classrooms WHERE id=$1 AND organization_id=$2 FOR UPDATE', [
            roomId,
            org,
          ])
        ).rows[0];
        if (!current) fail(404, 'Classroom not found');
        const currentSettings = formatRoomSettings(current);
        const nextName = data.name ?? current.name;
        const nextTheme = data.theme ?? currentSettings.theme;
        const nextPerms = {
          chatEnabled: data.permissions?.chatEnabled ?? currentSettings.permissions.chatEnabled,
          handRaiseEnabled:
            data.permissions?.handRaiseEnabled ?? currentSettings.permissions.handRaiseEnabled,
          studentWhiteboardEnabled:
            data.permissions?.studentWhiteboardEnabled ??
            currentSettings.permissions.studentWhiteboardEnabled,
          defaultMicrophone:
            data.permissions?.defaultMicrophone ?? currentSettings.permissions.defaultMicrophone,
          defaultCamera:
            data.permissions?.defaultCamera ?? currentSettings.permissions.defaultCamera,
          defaultScreenShare:
            data.permissions?.defaultScreenShare ?? currentSettings.permissions.defaultScreenShare,
          locked: data.permissions?.locked ?? currentSettings.permissions.locked,
        };
        await c.query(
          'UPDATE classrooms SET name=$1,theme=$2,chat_enabled=$3,hand_raise_enabled=$4,student_whiteboard_enabled=$5,default_microphone=$6,default_camera=$7,default_screen_share=$8,locked=$9 WHERE id=$10',
          [
            nextName,
            nextTheme,
            nextPerms.chatEnabled,
            nextPerms.handRaiseEnabled,
            nextPerms.studentWhiteboardEnabled,
            nextPerms.defaultMicrophone,
            nextPerms.defaultCamera,
            nextPerms.defaultScreenShare,
            nextPerms.locked,
            roomId,
          ],
        );
        await c.query(
          'INSERT INTO audit_logs(id,actor_id,organization_id,action,resource_id,details) VALUES($1,$2,$3,$4,$5,$6)',
          [
            randomUUID(),
            user.id,
            org,
            'classroom.settings_updated',
            roomId,
            JSON.stringify({ name: nextName, theme: nextTheme, permissions: nextPerms }),
          ],
        );
        if (data.enrollmentMode !== undefined || data.memberIds !== undefined) {
          const ids =
            data.memberIds ??
            (
              await c.query('SELECT user_id FROM classroom_memberships WHERE classroom_id=$1', [
                roomId,
              ])
            ).rows.map((row) => row.user_id as string);
          await saveClassroomEnrollment(c, roomId, org, {
            enrollmentMode: data.enrollmentMode ?? current.enrollment_mode,
            memberIds: ids,
          });
        }
        return { id: roomId, name: nextName, theme: nextTheme, permissions: nextPerms };
      });
      const notify = (app as unknown as { notifyClassroom?: (id: string) => void }).notifyClassroom;
      notify?.(roomId);
      return updated;
    },
  );
  app.get<{ Params: { id: string }; Querystring: unknown }>(base + '/members', async (req) => {
    const { org } = await access(req, req.params.id),
      page = pagination.parse(req.query);
    const rows = (
      await ctx.pool.query(
        'SELECT u.id,u.name,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY u.name,u.id LIMIT $2 OFFSET $3',
        [org, page.limit + 1, page.offset],
      )
    ).rows;
    return { items: rows.slice(0, page.limit), hasMore: rows.length > page.limit };
  });
  app.get<{ Params: { id: string }; Querystring: unknown }>(base + '/audit', async (req) => {
    const { org } = await access(req, req.params.id),
      page = pagination
        .extend({
          action: z
            .string()
            .max(120)
            .regex(/^[a-z0-9_.]*$/)
            .default(''),
        })
        .parse(req.query);
    const rows = (
      await ctx.pool.query(
        "SELECT a.id,a.action,a.resource_id,a.actor_kind,a.created_at,u.name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.organization_id=$1 AND ($2='' OR a.action=$2) ORDER BY a.created_at DESC,a.id DESC LIMIT $3 OFFSET $4",
        [org, page.action, page.limit + 1, page.offset],
      )
    ).rows;
    return { items: rows.slice(0, page.limit), hasMore: rows.length > page.limit };
  });
}
