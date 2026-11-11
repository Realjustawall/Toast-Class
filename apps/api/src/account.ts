import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DatabasePool, DatabaseConnection } from './database.js';
import { transaction, securityEvent } from './db.js';
import { fail } from './errors.js';

export const timezone = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  });
type Identity = { id: string; name: string; email: string };
export async function registerAccount(
  app: FastifyInstance,
  ctx: {
    pool: DatabasePool;
    user: (req: { cookies: Record<string, string | undefined> }) => Promise<Identity>;
    hashToken: (value: string) => string;
    hashPassword: (value: string) => Promise<string>;
    verifyPassword: (value: string, stored: string) => Promise<boolean>;
  },
) {
  const { pool, user } = ctx;
  app.get('/api/v1/account', async (req) => {
    const u = await user(req);
    return (
      await pool.query('SELECT id,name,email,locale,timezone,created_at FROM users WHERE id=$1', [
        u.id,
      ])
    ).rows[0];
  });
  app.post('/api/v1/account/profile', async (req) => {
    const u = await user(req);
    const data = z
      .object({ name: z.string().trim().min(2).max(120), locale: z.enum(['fa', 'en']), timezone })
      .strict()
      .parse(req.body);
    return transaction(pool, async (c) => {
      await c.query('UPDATE users SET name=$1,locale=$2,timezone=$3 WHERE id=$4', [
        data.name,
        data.locale,
        data.timezone,
        u.id,
      ]);
      await securityEvent(c, u.id, 'profile.updated');
      return (
        await c.query('SELECT id,name,email,locale,timezone,created_at FROM users WHERE id=$1', [
          u.id,
        ])
      ).rows[0];
    });
  });
  app.get('/api/v1/account/sessions', async (req) => {
    const u = await user(req);
    const current = ctx.hashToken(req.cookies.toaster_session!);
    const rows = (
      await pool.query(
        'SELECT id,created_at,expires_at,user_agent,token_hash FROM auth_sessions WHERE user_id=$1 AND expires_at>CURRENT_TIMESTAMP(3) ORDER BY created_at DESC,id DESC LIMIT 100',
        [u.id],
      )
    ).rows;
    return rows.map(({ token_hash, ...row }) => ({ ...row, current: token_hash === current }));
  });
  app.post<{ Params: { id: string } }>(
    '/api/v1/account/sessions/:id/revoke',
    async (req, reply) => {
      const u = await user(req),
        id = z.uuid().parse(req.params.id);
      const revoked = await transaction(pool, async (c) => {
        const r = await c.query(
          'SELECT token_hash FROM auth_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
          [id, u.id],
        );
        if (!r.rowCount) fail(404, 'Session not found');
        await c.query('DELETE FROM auth_sessions WHERE id=$1 AND user_id=$2', [id, u.id]);
        await securityEvent(c, u.id, 'session.revoked');
        return r.rows[0].token_hash === ctx.hashToken(req.cookies.toaster_session!);
      });
      if (revoked) reply.clearCookie('toaster_session', { path: '/' });
      return { ok: true, current: revoked };
    },
  );
  app.post('/api/v1/account/sessions/revoke-others', async (req) => {
    const u = await user(req);
    return transaction(pool, async (c) => {
      const r = await c.query('DELETE FROM auth_sessions WHERE user_id=$1 AND token_hash<>$2', [
        u.id,
        ctx.hashToken(req.cookies.toaster_session!),
      ]);
      await securityEvent(c, u.id, 'sessions.others_revoked');
      return { revoked: r.rowCount };
    });
  });
  app.post(
    '/api/v1/account/password',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => {
      const u = await user(req);
      const data = z
        .object({
          currentPassword: z.string().min(1).max(128),
          newPassword: z.string().min(6).max(128),
        })
        .strict()
        .parse(req.body);
      if (data.currentPassword === data.newPassword) fail(400, 'Choose a different password');
      await transaction(pool, async (c) => {
        const account = (
          await c.query('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE', [u.id])
        ).rows[0];
        if (!(await ctx.verifyPassword(data.currentPassword, account.password_hash)))
          fail(401, 'Current password is incorrect');
        await c.query('UPDATE users SET password_hash=$1 WHERE id=$2', [
          await ctx.hashPassword(data.newPassword),
          u.id,
        ]);
        await c.query('DELETE FROM auth_sessions WHERE user_id=$1 AND token_hash<>$2', [
          u.id,
          ctx.hashToken(req.cookies.toaster_session!),
        ]);
        await securityEvent(c, u.id, 'password.changed');
      });
      return { ok: true };
    },
  );
  app.get('/api/v1/account/security', async (req) => {
    const u = await user(req);
    return (
      await pool.query(
        'SELECT id,action,created_at FROM account_security_events WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50',
        [u.id],
      )
    ).rows;
  });
}
