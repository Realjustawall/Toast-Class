import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, audit } from './db.js';
import { fail } from './errors.js';
import type { TeachingContext } from './teaching.js';
import type { DatabaseConnection } from './database.js';

export async function registerChatCategories(app: FastifyInstance, ctx: TeachingContext) {
  const { pool, user, roomAccess, membership } = ctx;
  const base = '/api/v1/classrooms/:id/chat-categories';
  const requireManager = async (c: DatabaseConnection, organizationId: string, userId: string) => {
    const member = (
      await c.query(
        'SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE',
        [organizationId, userId],
      )
    ).rows[0];
    if (!member || !['owner', 'teacher'].includes(member.role)) fail(403, 'Forbidden');
  };
  const notify = (id: string) => {
    const live = app as unknown as { notifyClassroom: (id: string, type?: string) => void };
    live.notifyClassroom(id, 'chat_categories_changed');
    live.notifyClassroom(id, 'chat_changed');
  };
  app.get<{ Params: { id: string } }>(
    base,
    { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
    async (req) => {
      const u = await user(req),
        room = await roomAccess(req.params.id, u.id);
      return (
        await pool.query(
          'SELECT id,name FROM chat_categories WHERE classroom_id=$1 ORDER BY created_at,id',
          [room.id],
        )
      ).rows;
    },
  );
  app.post<{ Params: { id: string } }>(base, async (req, reply) => {
    const u = await user(req),
      room = await roomAccess(req.params.id, u.id);
    await membership(room.organization_id, u.id, true);
    const { name } = z
      .object({
        name: z
          .string()
          .transform((value) => value.normalize('NFKC').trim())
          .pipe(
            z
              .string()
              .min(1)
              .max(60)
              .regex(/^[^\u0000-\u001f\u007f]+$/),
          ),
      })
      .strict()
      .parse(req.body);
    const category = { id: randomUUID(), name };
    await transaction(pool, async (c) => {
      await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [room.id]);
      await requireManager(c, room.organization_id, u.id);
      const existing = (
        await c.query('SELECT id,name FROM chat_categories WHERE classroom_id=$1', [room.id])
      ).rows;
      if (
        ['public', 'عمومی'].includes(name.toLowerCase()) ||
        existing.some((row) => row.name.toLowerCase() === name.toLowerCase())
      )
        fail(409, 'Chat category already exists');
      if (existing.length >= 12) fail(409, 'Chat category limit reached');
      await c.query(
        'INSERT INTO chat_categories(id,classroom_id,name,created_by) VALUES($1,$2,$3,$4)',
        [category.id, room.id, name, u.id],
      );
      await audit(c, u.id, room.organization_id, 'chat.category_created', category.id);
    });
    notify(room.id);
    return reply.code(201).send(category);
  });
  app.post<{ Params: { id: string; categoryId: string } }>(
    base + '/:categoryId/delete',
    async (req) => {
      const u = await user(req),
        room = await roomAccess(req.params.id, u.id);
      await membership(room.organization_id, u.id, true);
      const id = z.uuid().parse(req.params.categoryId);
      await transaction(pool, async (c) => {
        await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [room.id]);
        await requireManager(c, room.organization_id, u.id);
        const category = (
          await c.query(
            'SELECT id FROM chat_categories WHERE id=$1 AND classroom_id=$2 FOR UPDATE',
            [id, room.id],
          )
        ).rows[0];
        if (!category) fail(404, 'Not found');
        // Keep conversation history when a moderator removes a category.
        await c.query(
          'UPDATE messages SET category_id=NULL WHERE classroom_id=$1 AND category_id=$2',
          [room.id, id],
        );
        await c.query('DELETE FROM chat_categories WHERE id=$1 AND classroom_id=$2', [id, room.id]);
        await c.query('UPDATE classrooms SET chat_revision=chat_revision+1 WHERE id=$1', [room.id]);
        await audit(c, u.id, room.organization_id, 'chat.category_deleted', id);
      });
      notify(room.id);
      return { ok: true };
    },
  );
}
