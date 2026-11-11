import type { FastifyInstance } from 'fastify';
import type { TeachingContext } from './teaching.js';
import { z } from 'zod';
import { transaction } from './db.js';
import { fail } from './errors.js';
import {
  defaultUserPreferences,
  userPreferencesSchema,
} from '../../../packages/user-preferences.js';
export async function registerUserPreferences(
  app: FastifyInstance,
  ctx: Pick<TeachingContext, 'pool' | 'user'>,
) {
  const read = async (userId: string) => {
    const row = (
      await ctx.pool.query(
        'SELECT revision,preferences_json FROM user_preferences WHERE user_id=$1',
        [userId],
      )
    ).rows[0];
    return {
      revision: row ? Number(row.revision) : 0,
      preferences: row
        ? userPreferencesSchema.parse(JSON.parse(row.preferences_json))
        : structuredClone(defaultUserPreferences),
    };
  };
  app.get('/api/v1/account/preferences', async (req, reply) => {
    const user = await ctx.user(req);
    reply.header('Cache-Control', 'private, no-store');
    return read(user.id);
  });
  app.post('/api/v1/account/preferences', { bodyLimit: 16384 }, async (req) => {
    const user = await ctx.user(req),
      data = z
        .object({
          revision: z.number().int().min(0).max(2147483646),
          preferences: userPreferencesSchema,
        })
        .strict()
        .parse(req.body);
    return transaction(ctx.pool, async (c) => {
      await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      const old = (
        await c.query('SELECT revision FROM user_preferences WHERE user_id=$1', [user.id])
      ).rows[0];
      if (Number(old?.revision ?? 0) !== data.revision)
        fail(409, 'Preferences changed; reload before saving');
      if (old)
        await c.query(
          'UPDATE user_preferences SET preferences_json=$1,revision=revision+1,updated_at=CURRENT_TIMESTAMP(3) WHERE user_id=$2',
          [JSON.stringify(data.preferences), user.id],
        );
      else
        await c.query(
          'INSERT INTO user_preferences(user_id,revision,preferences_json) VALUES($1,1,$2)',
          [user.id, JSON.stringify(data.preferences)],
        );
      if (data.preferences.language)
        await c.query('UPDATE users SET locale=$1 WHERE id=$2', [
          data.preferences.language,
          user.id,
        ]);
      return { revision: data.revision + 1, preferences: data.preferences };
    });
  });
}
