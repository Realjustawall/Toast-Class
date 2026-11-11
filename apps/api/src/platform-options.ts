import type { FastifyInstance } from 'fastify';
import type { DatabasePool } from './database.js';
import { platformOptionsSchema } from '../../../packages/classroom-settings/schema.js';
import { z } from 'zod';
import { transaction, securityEvent } from './db.js';
import { fail } from './errors.js';
export async function readPlatformOptions(c: Pick<DatabasePool, 'query'>) {
  const row = (await c.query('SELECT options_json FROM platform_settings WHERE id=1')).rows[0];
  if (!row) fail(503, 'Platform settings unavailable');
  try {
    return platformOptionsSchema.parse(
      row.options_json == null
        ? {}
        : typeof row.options_json === 'string'
          ? JSON.parse(row.options_json)
          : row.options_json,
    );
  } catch {
    fail(503, 'Platform settings unavailable');
  }
}
export async function assertPlatformFeature(
  c: Pick<DatabasePool, 'query'>,
  feature: 'geoEnabled' | 'pdfImportEnabled',
) {
  if (!(await readPlatformOptions(c))[feature])
    fail(403, 'This feature is disabled by the platform administrator');
}
export async function registerPlatformOptions(
  app: FastifyInstance,
  pool: DatabasePool,
  user: (req: { cookies: Record<string, string | undefined> }) => Promise<{ id: string }>,
) {
  const read = async () => {
    const row = (
      await pool.query('SELECT registration_open,revision FROM platform_settings WHERE id=1')
    ).rows[0];
    return {
      options: await readPlatformOptions(pool),
      registrationOpen: Boolean(row.registration_open),
      revision: Number(row.revision),
    };
  };
  const admin = async (req: { cookies: Record<string, string | undefined> }) => {
    const u = await user(req);
    if (
      !(await pool.query('SELECT user_id FROM platform_admins WHERE user_id=$1', [u.id])).rows
        .length
    )
      fail(403, 'Platform administrator required');
    return u;
  };
  app.get('/api/v1/app/settings', async (_req, reply) =>
    reply.header('Cache-Control', 'no-store').send(await read()),
  );
  app.get('/api/v1/platform/users', async (req) => {
    await admin(req);
    const query = z
      .object({
        search: z.string().max(120).default(''),
        organizationId: z.uuid().optional(),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .strict()
      .parse(req.query);
    const rows = (
      await pool.query(
        'SELECT u.id,u.name,u.email FROM users u LEFT JOIN memberships m ON m.user_id=u.id AND m.organization_id=$1 WHERE m.user_id IS NULL AND (LOWER(u.name) LIKE $2 OR LOWER(u.email) LIKE $2) ORDER BY u.name,u.id LIMIT 51 OFFSET $3',
        [query.organizationId ?? null, '%' + query.search.toLowerCase() + '%', query.offset],
      )
    ).rows;
    return { items: rows.slice(0, 50), hasMore: rows.length > 50 };
  });
  app.get('/api/v1/platform/settings', async (req) => {
    await admin(req);
    return read();
  });
  app.post('/api/v1/platform/settings', async (req) => {
    const u = await admin(req),
      data = z
        .object({
          options: platformOptionsSchema,
          registrationOpen: z.boolean(),
          expectedRevision: z.number().int().min(0),
        })
        .strict()
        .parse(req.body);
    const affected = await transaction(pool, async (c) => {
      const row = (await c.query('SELECT * FROM platform_settings WHERE id=1 FOR UPDATE')).rows[0];
      if (
        !(await c.query('SELECT user_id FROM platform_admins WHERE user_id=$1', [u.id])).rows.length
      )
        fail(403, 'Platform administrator required');
      if (Number(row.revision) !== data.expectedRevision)
        fail(409, 'Platform settings changed; refresh before saving');
      await c.query(
        'UPDATE platform_settings SET options_json=$1,registration_open=$2,revision=revision+1 WHERE id=1',
        [JSON.stringify(data.options), data.registrationOpen],
      );
      const rooms = new Set<string>(
        (
          await c.query('SELECT classroom_id FROM classroom_sessions WHERE ended_at IS NULL')
        ).rows.map((row) => row.classroom_id),
      );
      if (!data.options.geoEnabled) {
        const worksheets = (
          await c.query("SELECT classroom_id FROM classroom_workspace WHERE kind='geogebra'")
        ).rows;
        for (const worksheet of worksheets) {
          const root = (
            await c.query(
              "SELECT id FROM collaborative_documents WHERE classroom_id=$1 AND kind='board' AND board_book_id IS NULL ORDER BY created_at,id LIMIT 1",
              [worksheet.classroom_id],
            )
          ).rows[0];
          await c.query(
            "UPDATE classroom_workspace SET kind='document',document_id=$1,geogebra_id=NULL,revision=revision+1,updated_by=$2,updated_at=CURRENT_TIMESTAMP(3) WHERE classroom_id=$3",
            [root?.id ?? null, u.id, worksheet.classroom_id],
          );
          rooms.add(worksheet.classroom_id);
        }
      }
      await securityEvent(c, u.id, 'platform.settings_updated');
      return [...rooms];
    });
    for (const id of affected) {
      const notify = (app as unknown as { notifyClassroom: (id: string, type: string) => void })
        .notifyClassroom;
      notify(id, 'platform_changed');
      notify(id, 'workspace_changed');
    }
    return read();
  });
}
