import { sqlDialect } from './database.js';
import { fail } from './errors.js';
import type { FastifyInstance } from 'fastify';
import type { DatabasePool, DatabaseConnection } from './database.js';
import { createHash } from 'node:crypto';
import { WebhookReceiver } from 'livekit-server-sdk';
import { z } from 'zod';
import type { TeachingContext } from './teaching.js';
type Interval = { joined_at: Date | string | null; left_at: Date | string | null };
/** Union observed intervals so overlapping/reconnecting devices do not double attendance. */
export function attendanceDuration(intervals: Interval[], now: number) {
  const sorted = intervals
    .filter((i) => i.joined_at !== null)
    .map(
      (i) =>
        [new Date(i.joined_at!).getTime(), i.left_at ? new Date(i.left_at).getTime() : now] as [
          number,
          number,
        ],
    )
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0,
    start = 0,
    end = 0;
  for (const [a, b] of sorted) {
    if (a > end) {
      total += end - start;
      start = a;
      end = b;
    } else end = Math.max(end, b);
  }
  return total + end - start;
}

export async function registerAttendance(
  app: FastifyInstance,
  ctx: TeachingContext,
  key: string,
  secret: string,
) {
  const { pool, user, roomAccess, membership } = ctx;
  app.addContentTypeParser('application/webhook+json', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );
  app.post(
    '/api/v1/media/webhook',
    { config: { rateLimit: { max: 3000, timeWindow: '1 minute' } } },
    async (req) => {
      if (!key || secret.length < 32) fail(503, 'Webhook receiver not configured');
      if (typeof req.body !== 'string') fail(400, 'Raw webhook body required');
      const receiver = new WebhookReceiver(key, secret);
      let event;
      try {
        event = await receiver.receive(req.body, req.headers.authorization);
      } catch {
        fail(401, 'Invalid webhook signature');
      }
      if (!event.id || event.id.length > 128) fail(400, 'Missing webhook event id');
      const hash = createHash('sha256').update(req.body).digest('hex');
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const previous = (
          await c.query('SELECT body_hash FROM media_webhook_events WHERE id=$1 FOR UPDATE', [
            event.id,
          ])
        ).rows[0];
        if (previous) {
          if (previous.body_hash !== hash) fail(409, 'Webhook id conflict');
          await c.query('COMMIT');
          return { ok: true, duplicate: true };
        }
        let inserted;
        try {
          inserted = await c.query(
            sqlDialect(
              c,
              'INSERT INTO media_webhook_events(id,body_hash,event_type) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
              'INSERT INTO media_webhook_events(id,body_hash,event_type) VALUES($1,$2,$3)',
            ),
            [event.id, hash, event.event],
          );
        } catch (error) {
          // MySQL rolls back this duplicate statement, not the surrounding transaction.
          if (c.dialect !== 'mysql' || (error as { code?: string }).code !== 'ER_DUP_ENTRY')
            throw error;
          inserted = { rowCount: 0 };
        }
        if (!inserted.rowCount) {
          const original = (
            await c.query('SELECT body_hash FROM media_webhook_events WHERE id=$1', [event.id])
          ).rows[0];
          if (original.body_hash !== hash) fail(409, 'Webhook id conflict');
          await c.query('COMMIT');
          return { ok: true, duplicate: true };
        }
        const roomName = event.room?.name;
        const mediaSession =
          roomName?.startsWith('toaster-') && z.uuid().safeParse(roomName.slice(8)).success
            ? (
                await c.query('SELECT id,classroom_id FROM classroom_sessions WHERE id=$1', [
                  roomName.slice(8),
                ])
              ).rows[0]
            : null;
        const roomId = mediaSession?.classroom_id ?? roomName,
          identity = event.participant?.identity,
          sid = event.participant?.sid;
        if (
          ['participant_joined', 'participant_left'].includes(event.event) &&
          z.uuid().safeParse(roomId).success &&
          z.uuid().safeParse(identity).success &&
          sid
        ) {
          const room = (await c.query('SELECT id FROM classrooms WHERE id=$1', [roomId])).rows[0];
          const u = (await c.query('SELECT id FROM users WHERE id=$1', [identity])).rows[0];
          const at = new Date(Number(event.createdAt) * 1000);
          if (
            !Number.isFinite(at.getTime()) ||
            at.getTime() > Date.now() + 120000 ||
            at.getTime() < Date.now() - 7 * 86400000
          )
            fail(400, 'Webhook event timestamp outside allowed range');
          if (room && u) {
            const session =
              mediaSession ??
              (await c.query('SELECT id FROM classroom_sessions WHERE active_key=$1', [roomId]))
                .rows[0];
            if (event.event === 'participant_joined')
              await c.query(
                sqlDialect(
                  c,
                  'INSERT INTO media_connections(id,classroom_id,user_id,session_id,joined_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET joined_at=COALESCE(media_connections.joined_at,EXCLUDED.joined_at)',
                  'INSERT INTO media_connections(id,classroom_id,user_id,session_id,joined_at) VALUES($1,$2,$3,$4,$5) AS incoming ON DUPLICATE KEY UPDATE joined_at=COALESCE(media_connections.joined_at,incoming.joined_at)',
                ),
                [sid, roomId, identity, session?.id ?? null, at],
              );
            else
              await c.query(
                sqlDialect(
                  c,
                  'INSERT INTO media_connections(id,classroom_id,user_id,session_id,left_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET left_at=COALESCE(media_connections.left_at,EXCLUDED.left_at)',
                  'INSERT INTO media_connections(id,classroom_id,user_id,session_id,left_at) VALUES($1,$2,$3,$4,$5) AS incoming ON DUPLICATE KEY UPDATE left_at=COALESCE(media_connections.left_at,incoming.left_at)',
                ),
                [sid, roomId, identity, session?.id ?? null, at],
              );
          }
        }
        await c.query('COMMIT');
        return { ok: true };
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    },
  );
  app.get<{ Params: { id: string } }>('/api/v1/classrooms/:id/attendance', async (req) => {
    const u = await user(req);
    const room = await roomAccess(req.params.id, u.id);
    await membership(room.organization_id, u.id, true);
    const now = Date.now();
    const records = (
      await pool.query(
        'SELECT m.id,m.user_id,m.joined_at,m.left_at,m.session_id,u.name FROM media_connections m JOIN users u ON u.id=m.user_id WHERE m.classroom_id=$1 ORDER BY m.joined_at',
        [room.id],
      )
    ).rows;
    const ids = [...new Set<string>(records.map((r) => r.user_id))];
    return {
      serverTime: now,
      participants: ids.map((id) => {
        const intervals = records.filter((r) => r.user_id === id);
        return {
          userId: id,
          name: intervals[0].name,
          totalDurationMs: attendanceDuration(intervals, now),
          connections: intervals,
        };
      }),
    };
  });
}
