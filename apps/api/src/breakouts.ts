import { sqlDialect } from './database.js';
import { hasClassroomAccess } from './classroom-access.js';
import type { FastifyInstance } from 'fastify';
import type { DatabasePool, DatabaseConnection } from './database.js';
import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from './errors.js';
import { transaction, audit } from './db.js';
import { mediaRoomName, type MediaService } from './media-control.js';
import type { TeachingContext } from './teaching.js';

type Query = Pick<DatabasePool, 'query'>;
export type BreakoutContext = {
  group_id: string;
  parent_session_id: string;
  parent_id: string;
  parent_name: string;
  status: string;
  ends_at: Date;
  allow_self_select: boolean;
  parent_active: string | null;
};
export function balancedAssignment(userIds: string[], rooms: number) {
  const shuffled = [...userIds];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.map((userId, i) => ({ userId, roomIndex: i % rooms }));
}
export class BreakoutService {
  constructor(
    readonly pool: DatabasePool,
    readonly media: MediaService,
  ) {}
  async context(classroomId: string, c: Query = this.pool): Promise<BreakoutContext | undefined> {
    return (
      await c.query(
        'SELECT r.group_id,g.parent_session_id,g.status,g.ends_at,g.allow_self_select,s.classroom_id AS parent_id,s.active_key AS parent_active,p.name AS parent_name FROM breakout_rooms r JOIN breakout_groups g ON g.id=r.group_id JOIN classroom_sessions s ON s.id=g.parent_session_id JOIN classrooms p ON p.id=s.classroom_id WHERE r.classroom_id=$1',
        [classroomId],
      )
    ).rows[0];
  }
  isActive(context: { status: string; ends_at: Date | string; parent_active?: string | null }) {
    return (
      context.status === 'active' &&
      new Date(context.ends_at).getTime() > Date.now() &&
      (context.parent_active === undefined || context.parent_active !== null)
    );
  }
  async assertRoomAccess(classroomId: string, userId: string, role: string) {
    const context = await this.context(classroomId);
    if (!context || role !== 'student') return;
    if (!this.isActive(context)) fail(403, 'Breakout room is closed');
    const assignment = (
      await this.pool.query(
        'SELECT room_id FROM breakout_assignments WHERE group_id=$1 AND user_id=$2',
        [context.group_id, userId],
      )
    ).rows[0];
    if (assignment?.room_id !== classroomId) fail(403, 'Not assigned to this breakout room');
  }
  async assertMediaLocation(
    classroomId: string,
    sessionId: string,
    userId: string,
    c: Query = this.pool,
  ) {
    const role = (
      await c.query(
        'SELECT m.role FROM memberships m JOIN classrooms r ON r.organization_id=m.organization_id WHERE r.id=$1 AND m.user_id=$2',
        [classroomId, userId],
      )
    ).rows[0]?.role;
    if (!role) fail(403, 'Permission denied');
    if (!(await hasClassroomAccess(c, classroomId, userId, role)))
      fail(403, 'Classroom access is not assigned');
    const context = await this.context(classroomId, c);
    if (context) {
      if (!this.isActive(context)) fail(403, 'Breakout room is closed');
      if (role === 'student') {
        const a = (
          await c.query(
            'SELECT room_id FROM breakout_assignments WHERE group_id=$1 AND user_id=$2',
            [context.group_id, userId],
          )
        ).rows[0];
        if (a?.room_id !== classroomId) fail(403, 'Breakout assignment changed');
      }
      return;
    }
    if (role === 'student') {
      const group = (
        await c.query(
          "SELECT id,ends_at FROM breakout_groups WHERE active_key=$1 AND status='active'",
          [sessionId],
        )
      ).rows[0];
      if (group && new Date(group.ends_at).getTime() > Date.now()) {
        const a = (
          await c.query(
            'SELECT room_id FROM breakout_assignments WHERE group_id=$1 AND user_id=$2',
            [group.id, userId],
          )
        ).rows[0];
        if (a?.room_id) fail(403, 'Join your assigned breakout room or return to main first');
      }
    }
  }
  async parent(c: Query, id: string, active = true) {
    const room = (await c.query('SELECT id,name,organization_id FROM classrooms WHERE id=$1', [id]))
      .rows[0];
    if (!room) fail(404, 'Classroom not found');
    if (await this.context(id, c)) fail(400, 'Nested breakout rooms are not supported');
    const session = (await c.query('SELECT id FROM classroom_sessions WHERE active_key=$1', [id]))
      .rows[0];
    if (active && !session) fail(409, 'No active session');
    return { room, session };
  }
  async lockGroup(c: DatabaseConnection, parentId: string, groupId: string, requireActive = true) {
    const initial = (
      await c.query(
        'SELECT g.id,g.parent_session_id,s.classroom_id FROM breakout_groups g JOIN classroom_sessions s ON s.id=g.parent_session_id WHERE g.id=$1',
        [groupId],
      )
    ).rows[0];
    if (!initial || initial.classroom_id !== parentId) fail(404, 'Breakout group not found');
    await c.query('SELECT id FROM classroom_sessions WHERE id=$1 FOR UPDATE', [
      initial.parent_session_id,
    ]);
    const group = (await c.query('SELECT * FROM breakout_groups WHERE id=$1 FOR UPDATE', [groupId]))
      .rows[0];
    if (requireActive && !this.isActive(group)) fail(409, 'Breakout rooms are closed');
    return group;
  }
  async assign(
    c: DatabaseConnection,
    groupId: string,
    userId: string,
    roomId: string | null,
    actorId: string,
  ) {
    await c.query(
      sqlDialect(
        c,
        'INSERT INTO breakout_assignments(group_id,user_id,room_id) VALUES($1,$2,$3) ON CONFLICT(group_id,user_id) DO UPDATE SET room_id=EXCLUDED.room_id,revision=breakout_assignments.revision+1,assigned_at=CURRENT_TIMESTAMP(3)',
        'INSERT INTO breakout_assignments(group_id,user_id,room_id) VALUES($1,$2,$3) AS incoming ON DUPLICATE KEY UPDATE room_id=incoming.room_id,revision=breakout_assignments.revision+1,assigned_at=CURRENT_TIMESTAMP(3)',
      ),
      [groupId, userId, roomId],
    );
    const revision = (
      await c.query('SELECT revision FROM breakout_assignments WHERE group_id=$1 AND user_id=$2', [
        groupId,
        userId,
      ])
    ).rows[0].revision;
    await c.query(
      'INSERT INTO breakout_assignment_events(id,group_id,user_id,room_id,revision,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(), groupId, userId, roomId, revision, actorId],
    );
    if (!this.media.control) return;
    const group = (
      await c.query('SELECT parent_session_id FROM breakout_groups WHERE id=$1', [groupId])
    ).rows[0];
    const sources = (
      await c.query('SELECT classroom_id,session_id FROM breakout_rooms WHERE group_id=$1', [
        groupId,
      ])
    ).rows;
    const parent = (
      await c.query('SELECT classroom_id FROM classroom_sessions WHERE id=$1', [
        group.parent_session_id,
      ])
    ).rows[0];
    sources.push({ classroom_id: parent.classroom_id, session_id: group.parent_session_id });
    for (const source of sources) {
      if (source.classroom_id === (roomId ?? parent.classroom_id)) continue;
      await c.query(
        "INSERT INTO media_commands(id,session_id,user_id,kind,payload) VALUES($1,$2,$3,'remove',$4)",
        [
          randomUUID(),
          source.session_id,
          userId,
          JSON.stringify({ reason: 'breakout_move', groupId, revision }),
        ],
      );
    }
  }
  async close(
    c: DatabaseConnection,
    group: { id: string; parent_session_id: string; status: string },
    actorId: string | null,
    reason: string,
  ) {
    if (group.status === 'closed') return [];
    const parent = (
      await c.query(
        'SELECT r.organization_id FROM classroom_sessions s JOIN classrooms r ON r.id=s.classroom_id WHERE s.id=$1',
        [group.parent_session_id],
      )
    ).rows[0];
    await c.query(
      "UPDATE breakout_groups SET status='closed',active_key=NULL,closed_at=CURRENT_TIMESTAMP(3) WHERE id=$1",
      [group.id],
    );
    const children = (
      await c.query(
        'SELECT classroom_id,session_id FROM breakout_rooms WHERE group_id=$1 ORDER BY position',
        [group.id],
      )
    ).rows;
    for (const child of children) {
      await c.query('SELECT id FROM classroom_sessions WHERE id=$1 FOR UPDATE', [child.session_id]);
      await c.query(
        'UPDATE classroom_sessions SET ended_at=CURRENT_TIMESTAMP(3),active_key=NULL WHERE id=$1',
        [child.session_id],
      );
      await c.query("UPDATE polls SET status='ended' WHERE session_id=$1", [child.session_id]);
      await this.media.enqueueEnd(c, child.session_id);
    }
    await audit(c, actorId, parent.organization_id, 'breakout.' + reason, group.id, {
      parentSessionId: group.parent_session_id,
    });
    return children.map((v) => v.classroom_id as string);
  }
  async closeForParent(c: DatabaseConnection, parentSessionId: string, actorId: string) {
    const groups = (
      await c.query(
        "SELECT * FROM breakout_groups WHERE parent_session_id=$1 AND status='active' FOR UPDATE",
        [parentSessionId],
      )
    ).rows;
    const children: string[] = [];
    for (const group of groups)
      children.push(...(await this.close(c, group, actorId, 'closed_by_parent')));
    return children;
  }
  async expire() {
    const due = (
      await this.pool.query(
        "SELECT id,parent_session_id FROM breakout_groups WHERE status='active' AND ends_at<=CURRENT_TIMESTAMP(3) ORDER BY ends_at LIMIT 50",
      )
    ).rows;
    const notifications: string[] = [];
    for (const row of due)
      await transaction(this.pool, async (c) => {
        const parent = (
          await c.query('SELECT classroom_id FROM classroom_sessions WHERE id=$1 FOR UPDATE', [
            row.parent_session_id,
          ])
        ).rows[0];
        const group = (
          await c.query('SELECT * FROM breakout_groups WHERE id=$1 FOR UPDATE', [row.id])
        ).rows[0];
        if (group.status !== 'active' || new Date(group.ends_at).getTime() > Date.now()) return;
        notifications.push(parent.classroom_id, ...(await this.close(c, group, null, 'expired')));
      });
    return notifications;
  }
}

const createSchema = z.object({
  rooms: z
    .array(z.object({ name: z.string().trim().min(1).max(120) }))
    .min(2)
    .max(12),
  durationSeconds: z.number().int().min(30).max(86400),
  allowSelfSelect: z.boolean().default(false),
  allocation: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('manual'),
      assignments: z
        .array(z.object({ userId: z.uuid(), roomIndex: z.number().int().min(0).max(11) }))
        .max(500),
    }),
    z.object({ mode: z.literal('balanced-random'), userIds: z.array(z.uuid()).max(500) }),
  ]),
});
export async function registerBreakouts(
  app: FastifyInstance,
  ctx: TeachingContext,
  service: BreakoutService,
  runWorker = true,
) {
  const { pool, user, roomAccess, membership } = ctx;
  const notify = (ids: string[]) => {
    for (const id of new Set(ids))
      (app as unknown as { notifyClassroom: (id: string) => void }).notifyClassroom(id);
  };
  async function access(
    req: { cookies: Record<string, string | undefined> },
    id: string,
    write = false,
  ) {
    const u = await user(req);
    const room = await roomAccess(z.uuid().parse(id), u.id);
    const role = await membership(room.organization_id, u.id, write);
    return { u, room, role };
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<unknown> | undefined;
  app.addHook('onReady', async () => {
    if (runWorker)
      timer = setInterval(() => {
        if (!running)
          running = service
            .expire()
            .then(notify)
            .catch((e) => app.log.error({ err: e }, 'Breakout expiration failed'))
            .finally(() => {
              running = undefined;
            });
      }, 1000);
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await running;
  });
  app.get<{ Params: { id: string } }>('/api/v1/classrooms/:id/breakouts', async (req) => {
    const { u, room, role } = await access(req, req.params.id);
    await service.parent(pool, room.id, false);
    const groups = (
      await pool.query(
        'SELECT g.* FROM breakout_groups g JOIN classroom_sessions s ON s.id=g.parent_session_id WHERE s.classroom_id=$1 ORDER BY g.created_at DESC LIMIT 10',
        [room.id],
      )
    ).rows;
    const result = [];
    let destination: {
      id: string;
      name: string;
      parent?: { id: string; name: string; groupId: string };
    } = { id: room.id, name: room.name };
    for (const group of groups) {
      const active = service.isActive(group);
      const assignments = (
        await pool.query(
          'SELECT a.user_id,a.room_id,a.revision,u.name FROM breakout_assignments a JOIN users u ON u.id=a.user_id WHERE a.group_id=$1',
          [group.id],
        )
      ).rows;
      const own = assignments.find((a) => a.user_id === u.id);
      let rooms = (
        await pool.query(
          'SELECT r.classroom_id,r.session_id,r.position,c.name FROM breakout_rooms r JOIN classrooms c ON c.id=r.classroom_id WHERE r.group_id=$1 ORDER BY r.position',
          [group.id],
        )
      ).rows;
      if (role === 'student')
        rooms = rooms.filter(
          (r) => active && (group.allow_self_select || own?.room_id === r.classroom_id),
        );
      const mapped = await Promise.all(
        rooms.map(async (child) => {
          let liveCount: number | null = null;
          try {
            if (active && service.media.control)
              liveCount = (
                await service.media.control.participants(mediaRoomName(child.session_id))
              ).filter((p) => z.uuid().safeParse(p.identity).success).length;
          } catch {
            liveCount = null;
          }
          return {
            id: child.classroom_id,
            name: child.name,
            assignedCount: assignments.filter((a) => a.room_id === child.classroom_id).length,
            liveCount,
            documents:
              role === 'student'
                ? []
                : (
                    await pool.query(
                      'SELECT id,name,kind FROM collaborative_documents WHERE classroom_id=$1 ORDER BY created_at',
                      [child.classroom_id],
                    )
                  ).rows,
          };
        }),
      );
      if (active && own?.room_id) {
        const assigned = rooms.find((r) => r.classroom_id === own.room_id);
        if (assigned)
          destination = {
            id: assigned.classroom_id,
            name: assigned.name,
            parent: { id: room.id, name: room.name, groupId: group.id },
          };
      }
      result.push({
        id: group.id,
        status: active ? 'active' : 'closed',
        endsAt: group.ends_at,
        allowSelfSelect: group.allow_self_select,
        rooms: mapped,
        assignments:
          role === 'student' ? assignments.filter((a) => a.user_id === u.id) : assignments,
        announcements: (
          await pool.query(
            'SELECT id,body,created_at FROM breakout_announcements WHERE group_id=$1 ORDER BY created_at DESC LIMIT 20',
            [group.id],
          )
        ).rows,
      });
    }
    const students =
      role === 'student'
        ? []
        : (
            await pool.query(
              "SELECT u.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.role='student' ORDER BY u.name",
              [room.organization_id],
            )
          ).rows;
    return { groups: result, destination, students, role, userId: u.id, serverTime: Date.now() };
  });
  app.post<{ Params: { id: string } }>('/api/v1/classrooms/:id/breakouts', async (req, reply) => {
    const { u, room } = await access(req, req.params.id, true);
    const data = createSchema.parse(req.body);
    const groupId = randomUUID();
    const assignments =
      data.allocation.mode === 'manual'
        ? data.allocation.assignments
        : balancedAssignment(data.allocation.userIds, data.rooms.length);
    if (
      new Set(assignments.map((a) => a.userId)).size !== assignments.length ||
      assignments.some((a) => a.roomIndex >= data.rooms.length)
    )
      fail(400, 'Invalid or duplicate breakout assignment');
    await transaction(pool, async (c) => {
      const { session } = await service.parent(c, room.id);
      const parent = (
        await c.query('SELECT active_key FROM classroom_sessions WHERE id=$1 FOR UPDATE', [
          session.id,
        ])
      ).rows[0];
      if (!parent.active_key) fail(409, 'Session has ended');
      const inherited = (await c.query('SELECT * FROM classrooms WHERE id=$1', [room.id])).rows[0];
      for (const a of assignments) {
        const member = (
          await c.query('SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2', [
            room.organization_id,
            a.userId,
          ])
        ).rows[0];
        if (member?.role !== 'student') fail(400, 'Assignments must be organization students');
      }
      await c.query(
        "INSERT INTO breakout_groups(id,parent_session_id,active_key,status,ends_at,allow_self_select,created_by) VALUES($1,$2,$2,'active',$3,$4,$5)",
        [
          groupId,
          session.id,
          new Date(Date.now() + data.durationSeconds * 1000),
          data.allowSelfSelect,
          u.id,
        ],
      );
      const childIds: string[] = [];
      for (const [index, entry] of data.rooms.entries()) {
        const childId = randomUUID(),
          childSession = randomUUID();
        childIds.push(childId);
        await c.query(
          'INSERT INTO classrooms(id,organization_id,name,created_by,theme,chat_enabled,hand_raise_enabled,student_whiteboard_enabled,default_microphone,default_camera,default_screen_share,locks_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
          [
            childId,
            room.organization_id,
            entry.name,
            u.id,
            inherited.theme,
            inherited.chat_enabled,
            inherited.hand_raise_enabled,
            inherited.student_whiteboard_enabled,
            inherited.default_microphone,
            inherited.default_camera,
            inherited.default_screen_share,
            inherited.locks_json,
          ],
        );
        await c.query(
          'INSERT INTO classroom_sessions(id,classroom_id,started_by,active_key) VALUES($1,$2,$3,$2)',
          [childSession, childId, u.id],
        );
        await c.query(
          'INSERT INTO breakout_rooms(classroom_id,group_id,session_id,position) VALUES($1,$2,$3,$4)',
          [childId, groupId, childSession, index],
        );
      }
      for (const a of assignments)
        await service.assign(c, groupId, a.userId, childIds[a.roomIndex], u.id);
      await audit(c, u.id, room.organization_id, 'breakout.created', groupId, {
        roomCount: data.rooms.length,
        durationSeconds: data.durationSeconds,
      });
    });
    notify([room.id]);
    return reply.code(201).send({ id: groupId });
  });
  app.post<{ Params: { id: string; group: string } }>(
    '/api/v1/classrooms/:id/breakouts/:group/assign',
    async (req) => {
      const { u, room, role } = await access(req, req.params.id);
      const data = z.object({ userId: z.uuid(), roomId: z.uuid().nullable() }).parse(req.body);
      const groupId = z.uuid().parse(req.params.group);
      const notifications = await transaction(pool, async (c) => {
        const group = await service.lockGroup(c, room.id, groupId);
        if (
          role === 'student' &&
          (data.userId !== u.id || (!group.allow_self_select && data.roomId !== null))
        )
          fail(403, 'Breakout assignment requires a moderator');
        const member = (
          await c.query('SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2', [
            room.organization_id,
            data.userId,
          ])
        ).rows[0];
        if (member?.role !== 'student')
          fail(400, 'Only students are assigned; teachers can visit rooms');
        if (
          data.roomId &&
          !(
            await c.query(
              'SELECT classroom_id FROM breakout_rooms WHERE classroom_id=$1 AND group_id=$2',
              [data.roomId, group.id],
            )
          ).rowCount
        )
          fail(400, 'Room is not in this breakout group');
        await service.assign(c, group.id, data.userId, data.roomId, u.id);
        await audit(c, u.id, room.organization_id, 'breakout.assignment_changed', group.id, {
          userId: data.userId,
          roomId: data.roomId,
        });
        return [
          room.id,
          ...(
            await c.query('SELECT classroom_id FROM breakout_rooms WHERE group_id=$1', [group.id])
          ).rows.map((r) => r.classroom_id as string),
        ];
      });
      notify(notifications);
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string; group: string } }>(
    '/api/v1/classrooms/:id/breakouts/:group/extend',
    async (req) => {
      const { u, room } = await access(req, req.params.id, true);
      const { seconds } = z
        .object({ seconds: z.number().int().min(30).max(86400) })
        .parse(req.body);
      const groupId = z.uuid().parse(req.params.group);
      await transaction(pool, async (c) => {
        const g = await service.lockGroup(c, room.id, groupId);
        const deadline = new Date(
          Math.min(Date.now() + 86400000, new Date(g.ends_at).getTime() + seconds * 1000),
        );
        await c.query('UPDATE breakout_groups SET ends_at=$1 WHERE id=$2', [deadline, g.id]);
        await audit(c, u.id, room.organization_id, 'breakout.extended', g.id, { seconds });
      });
      notify([room.id]);
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string; group: string } }>(
    '/api/v1/classrooms/:id/breakouts/:group/close',
    async (req) => {
      const { u, room } = await access(req, req.params.id, true);
      const ids = await transaction(pool, async (c) => {
        const group = await service.lockGroup(c, room.id, z.uuid().parse(req.params.group), false);
        return service.close(c, group, u.id, 'closed');
      });
      notify([room.id, ...ids]);
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string; group: string } }>(
    '/api/v1/classrooms/:id/breakouts/:group/announce',
    async (req, reply) => {
      const { u, room } = await access(req, req.params.id, true);
      const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);
      const groupId = z.uuid().parse(req.params.group);
      await transaction(pool, async (c) => {
        await service.lockGroup(c, room.id, groupId);
        await c.query(
          'INSERT INTO breakout_announcements(id,group_id,body,sent_by) VALUES($1,$2,$3,$4)',
          [randomUUID(), groupId, body, u.id],
        );
        await audit(c, u.id, room.organization_id, 'breakout.announced', groupId);
      });
      notify([room.id]);
      return reply.code(201).send({ ok: true });
    },
  );
  app.post<{ Params: { id: string; group: string } }>(
    '/api/v1/classrooms/:id/breakouts/:group/import',
    async (req, reply) => {
      const { u, room } = await access(req, req.params.id, true);
      const { documentId } = z.object({ documentId: z.uuid() }).parse(req.body);
      const id = randomUUID();
      await transaction(pool, async (c) => {
        await service.lockGroup(c, room.id, z.uuid().parse(req.params.group), false);
        const source = (
          await c.query(
            'SELECT d.* FROM collaborative_documents d JOIN breakout_rooms r ON r.classroom_id=d.classroom_id WHERE d.id=$1 AND r.group_id=$2 FOR UPDATE',
            [documentId, req.params.group],
          )
        ).rows[0];
        if (!source) fail(404, 'Breakout document not found');
        const pages =
          source.kind === 'board' && !source.board_book_id
            ? [
                source,
                ...(
                  await c.query(
                    'SELECT * FROM collaborative_documents WHERE board_book_id=$1 AND classroom_id=$2 ORDER BY board_page_index FOR UPDATE',
                    [source.id, source.classroom_id],
                  )
                ).rows,
              ]
            : [source];
        for (const [pageIndex, page] of pages.entries()) {
          const copyId = pageIndex === 0 ? id : randomUUID();
          await c.query(
            'INSERT INTO collaborative_documents(id,classroom_id,kind,name,teacher_only,created_by,source_document_id,board_format,board_book_id,board_page_index,background_file_id,background_width,background_height,page_archived,page_bookmark,page_rotation,pdf_source_file_id,pdf_source_page) VALUES($1,$2,$3,$4,true,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',
            [
              copyId,
              room.id,
              page.kind,
              page.name,
              u.id,
              page.id,
              page.board_format,
              pageIndex === 0 ? null : id,
              pageIndex + 1,
              page.background_file_id ?? null,
              page.background_width ?? null,
              page.background_height ?? null,
              Boolean(page.page_archived),
              page.page_bookmark ?? '',
              page.page_rotation ?? 0,
              page.pdf_source_file_id ?? null,
              page.pdf_source_page ?? null,
            ],
          );
          if (page.board_format === 'excalidraw') {
            for (const asset of (
              await c.query('SELECT file_id FROM board_assets WHERE document_id=$1', [page.id])
            ).rows)
              await c.query('INSERT INTO board_assets(document_id,file_id) VALUES($1,$2)', [
                copyId,
                asset.file_id,
              ]);
            const state = (
              await c.query('SELECT state_base64 FROM board_states WHERE document_id=$1', [page.id])
            ).rows[0];
            if (!state) fail(409, 'Source board state is unavailable');
            await c.query(
              'INSERT INTO board_states(document_id,generation,state_base64) VALUES($1,$2,$3)',
              [copyId, randomUUID(), state.state_base64],
            );
          }
          const updates = (
            await c.query(
              'SELECT author_id,update_base64 FROM document_updates WHERE document_id=$1',
              [page.id],
            )
          ).rows;
          for (const update of updates)
            await c.query(
              'INSERT INTO document_updates(id,document_id,author_id,update_base64) VALUES($1,$2,$3,$4)',
              [randomUUID(), copyId, update.author_id, update.update_base64],
            );
        }
        await audit(c, u.id, room.organization_id, 'breakout.document_imported', id, {
          sourceDocumentId: source.id,
        });
      });
      notify([room.id]);
      return reply.code(201).send({ id });
    },
  );
}
