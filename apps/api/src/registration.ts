import type { FastifyInstance } from 'fastify';
import type { DatabasePool, DatabaseConnection } from './database.js';
import { z } from 'zod';
import { transaction, securityEvent } from './db.js';
import { fail } from './errors.js';

export async function registerRegistrationControls(
  app: FastifyInstance,
  pool: DatabasePool,
  user: (req: { cookies: Record<string, string | undefined> }) => Promise<{ id: string }>,
) {
  const read = async () => {
    const row = (
      await pool.query('SELECT registration_open,revision FROM platform_settings WHERE id=1')
    ).rows[0];
    if (!row) fail(503, 'Registration settings unavailable');
    return row;
  };
  const admin = async (req: { cookies: Record<string, string | undefined> }) => {
    const u = await user(req);
    if (
      !(await pool.query('SELECT user_id FROM platform_admins WHERE user_id=$1', [u.id])).rowCount
    )
      fail(403, 'Platform administrator required');
    return u;
  };
  app.get('/api/v1/auth/registration', async () => ({ open: (await read()).registration_open }));
  app.get('/api/v1/platform/registration', async (req) => {
    await admin(req);
    return read();
  });
  app.post('/api/v1/platform/registration', async (req) => {
    const u = await admin(req),
      data = z
        .object({ open: z.boolean(), expectedRevision: z.number().int().min(0) })
        .strict()
        .parse(req.body);
    return transaction(pool, async (c) => {
      const row = (await c.query('SELECT * FROM platform_settings WHERE id=1 FOR UPDATE')).rows[0];
      if (!(await c.query('SELECT user_id FROM platform_admins WHERE user_id=$1', [u.id])).rowCount)
        fail(403, 'Platform administrator required');
      if (row.revision !== data.expectedRevision)
        fail(409, 'Registration settings changed; refresh before saving');
      await c.query(
        'UPDATE platform_settings SET registration_open=$1,revision=revision+1 WHERE id=1',
        [data.open],
      );
      await securityEvent(c, u.id, data.open ? 'registration.opened' : 'registration.closed');
      return { registration_open: data.open, revision: row.revision + 1 };
    });
  });
}
