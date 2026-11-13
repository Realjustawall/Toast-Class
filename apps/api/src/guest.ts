import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabasePool, DatabaseConnection } from './database.js';
import { readPlatformOptions } from './platform-options.js';
import { transaction } from './db.js';
import { fail } from './errors.js';

export interface GuestContext {
  pool: DatabasePool;
  production: boolean;
  user: (req: { cookies: Record<string, string | undefined> }) => Promise<{
    id: string;
    name: string;
    email: string;
  }>;
  roomAccess: (id: string, uid: string) => Promise<Record<string, unknown>>;
  membership: (org: string, uid: string, write?: boolean) => Promise<string>;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function registerGuest(app: FastifyInstance, ctx: GuestContext) {
  const { pool } = ctx;

  app.get<{ Params: { id: string } }>('/api/v1/classrooms/:id/guest-info', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const roomId = z.uuid().parse(req.params.id);
    const options = await readPlatformOptions(pool);
    if (!options.guestEntryEnabled) return { enabled: false };
    const room = (
      await pool.query(
        'SELECT id,name,locked,guest_entry_enabled,guest_max_capacity FROM classrooms WHERE id=$1',
        [roomId],
      )
    ).rows[0];
    if (!room || !room.guest_entry_enabled) return { enabled: false };
    const countRow = (
      await pool.query('SELECT COUNT(*) AS count FROM classroom_guests WHERE classroom_id=$1', [
        roomId,
      ])
    ).rows[0];
    const currentGuests = Number(countRow?.count ?? 0);
    const maxCapacity = Math.min(
      Number(room.guest_max_capacity ?? options.guestMaxCapacity),
      options.guestMaxCapacity,
    );
    return {
      enabled: true,
      classroomName: String(room.name),
      locked: Boolean(room.locked),
      currentGuests,
      maxCapacity,
      remaining: Math.max(0, maxCapacity - currentGuests),
    };
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/classrooms/:id/guest-join',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const roomId = z.uuid().parse(req.params.id);
      const data = z
        .object({
          name: z.string().trim().min(2).max(60),
          deviceId: z.string().trim().min(8).max(128).optional(),
        })
        .strict()
        .parse(req.body);

      const ipAddress = (req.ip || '127.0.0.1').slice(0, 128);
      const cookieDevice = req.cookies.toaster_guest_device;
      const deviceId = (cookieDevice || data.deviceId || randomUUID()).slice(0, 128);
      const token = randomBytes(32).toString('hex');

      const result = await transaction(pool, async (c: DatabaseConnection) => {
        const room = (await c.query('SELECT * FROM classrooms WHERE id=$1 FOR UPDATE', [roomId]))
          .rows[0];
        if (!room) fail(404, 'Classroom not found');

        const options = await readPlatformOptions(c);
        if (!options.guestEntryEnabled || !room.guest_entry_enabled)
          fail(403, 'Guest entry is disabled');
        if (room.locked) fail(403, 'Classroom is locked by moderator');

        const existingIp = (
          await c.query('SELECT id FROM classroom_guests WHERE classroom_id=$1 AND ip_address=$2', [
            roomId,
            ipAddress,
          ])
        ).rows[0];
        if (existingIp) fail(409, 'Maximum 1 guest user is allowed per IP and device');

        const existingDevice = (
          await c.query('SELECT id FROM classroom_guests WHERE classroom_id=$1 AND device_id=$2', [
            roomId,
            deviceId,
          ])
        ).rows[0];
        if (existingDevice) fail(409, 'Maximum 1 guest user is allowed per IP and device');

        const countRow = (
          await c.query('SELECT COUNT(*) AS count FROM classroom_guests WHERE classroom_id=$1', [
            roomId,
          ])
        ).rows[0];
        const currentGuests = Number(countRow?.count ?? 0);
        const maxCapacity = Math.min(
          Number(room.guest_max_capacity ?? options.guestMaxCapacity),
          options.guestMaxCapacity,
        );
        if (currentGuests >= maxCapacity) fail(409, 'Classroom guest capacity reached');

        const userId = randomUUID();
        const guestId = randomUUID();
        const email = 'guest+' + userId + '@guest.local';
        await c.query(
          'INSERT INTO users(id,email,name,password_hash,is_guest) VALUES($1,$2,$3,$4,true)',
          [userId, email, data.name, '!'],
        );
        await c.query(
          "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'student')",
          [room.organization_id, userId],
        );
        await c.query('INSERT INTO classroom_memberships(classroom_id,user_id) VALUES($1,$2)', [
          roomId,
          userId,
        ]);
        await c.query(
          'INSERT INTO classroom_guests(id,classroom_id,user_id,display_name,ip_address,device_id) VALUES($1,$2,$3,$4,$5,$6)',
          [guestId, roomId, userId, data.name, ipAddress, deviceId],
        );
        await c.query(
          'INSERT INTO auth_sessions(token_hash,user_id,expires_at,user_agent,id) VALUES($1,$2,$3,$4,$5)',
          [
            hashToken(token),
            userId,
            new Date(Date.now() + 43200000),
            (req.headers['user-agent'] ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256),
            randomUUID(),
          ],
        );
        await c.query(
          'INSERT INTO audit_logs(id,actor_id,organization_id,action,resource_id,details) VALUES($1,$2,$3,$4,$5,$6)',
          [
            randomUUID(),
            userId,
            room.organization_id,
            'classroom.guest_joined',
            roomId,
            JSON.stringify({ name: data.name }),
          ],
        );
        return { id: userId, name: data.name, classroomId: roomId, guestId };
      });

      reply.setCookie('toaster_session', token, {
        httpOnly: true,
        secure: ctx.production,
        sameSite: 'strict',
        path: '/',
      });
      reply.setCookie('toaster_guest_device', deviceId, {
        httpOnly: true,
        secure: ctx.production,
        sameSite: 'strict',
        path: '/',
        maxAge: 86400 * 30,
      });
      (
        app as unknown as { notifyClassroom?: (id: string, type?: string) => void }
      ).notifyClassroom?.(roomId, 'users_changed');
      return reply.code(201).send(result);
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/classrooms/:id/guests/clear', async (req) => {
    const u = await ctx.user(req);
    const room = await ctx.roomAccess(req.params.id, u.id);
    await ctx.membership(String(room.organization_id), u.id, true);
    const removed = await transaction(pool, async (c) => {
      const rows = (
        await c.query('SELECT user_id FROM classroom_guests WHERE classroom_id=$1', [room.id])
      ).rows;
      const userIds = rows.map((r) => String(r.user_id));
      if (userIds.length) {
        const placeholders = userIds.map((_, i) => '$' + (i + 1)).join(',');
        await c.query(`DELETE FROM auth_sessions WHERE user_id IN (${placeholders})`, userIds);
        await c.query('DELETE FROM classroom_guests WHERE classroom_id=$1', [room.id]);
        await c.query(
          `DELETE FROM classroom_memberships WHERE classroom_id=$1 AND user_id IN (${placeholders})`,
          [room.id, ...userIds.map((_, i) => userIds[i])],
        );
      }
      return userIds.length;
    });
    (app as unknown as { notifyClassroom?: (id: string, type?: string) => void }).notifyClassroom?.(
      String(room.id),
      'users_changed',
    );
    return { removed };
  });
}
