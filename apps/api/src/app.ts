import { securityEvent } from './db.js';
import { HttpError } from './errors.js';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { registerAttendance } from './attendance.js';
import { BreakoutService, registerBreakouts } from './breakouts.js';
import { registerTeaching } from './teaching.js';
import { registerFiles, type FileConfig } from './files.js';
import { registerPresentations } from './presentations.js';
import { registerBoards } from './boards.js';
import { registerClassroomDownloads } from './classroom-downloads.js';
import { registerPrivateChat, assertPublicChat } from './private-chat.js';
import { registerChatCategories } from './chat-categories.js';
import { registerGeoGebra } from './geogebra.js';
import { registerSandbox } from './sandbox.js';
import { OptionalCache } from './optional-cache.js';
import { roomLockPolicy } from './classroom-lock-policy.js';
import { registerClassroomLocks } from './classroom-locks.js';
import { registerClassroomWorkspace } from './classroom-workspace.js';
import { registerAnnotationPages } from './annotation-pages.js';
import { readPlatformOptions, registerPlatformOptions } from './platform-options.js';
import { registerAdmin } from './admin.js';
import { registerGuest } from './guest.js';
import {
  assertGuestAccess,
  enrollmentSchema,
  hasClassroomAccess,
  saveClassroomEnrollment,
  registerClassroomAccess,
  classroomAuthorization,
} from './classroom-access.js';
import { registerAccount, timezone } from './account.js';
import { registerUserPreferences } from './user-preferences.js';
import { registerRegistrationControls } from './registration.js';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import {
  randomBytes,
  randomUUID,
  createHash,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { sqlDialect, type DatabasePool, type DatabaseConnection } from './database.js';
import { MediaService, registerMedia, type MediaControl } from './media-control.js';
const scrypt = promisify(scryptCallback);
const hashToken = (v: string) => createHash('sha256').update(v).digest('hex');
async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${((await scrypt(password, salt, 64)) as Buffer).toString('hex')}`;
}
async function verify(password: string, stored: string) {
  const [salt, key] = stored.split(':');
  return timingSafeEqual(Buffer.from(key, 'hex'), (await scrypt(password, salt, 64)) as Buffer);
}
const credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  password: z.string().min(6).max(128),
});
const named = z.object({ name: z.string().trim().min(2).max(120) });
const uuid = z.uuid();
export const classroomThemeSchema = z.enum([
  'classic-bbb',
  'modular-skyroom',
  'immersive-glass',
  'studio-hybrid',
]);
export type ClassroomTheme = z.infer<typeof classroomThemeSchema>;
export const classroomPermissionsSchema = z
  .object({
    chatEnabled: z.boolean().optional(),
    handRaiseEnabled: z.boolean().optional(),
    studentWhiteboardEnabled: z.boolean().optional(),
    defaultMicrophone: z.boolean().optional(),
    defaultCamera: z.boolean().optional(),
    defaultScreenShare: z.boolean().optional(),
    locked: z.boolean().optional(),
  })
  .strict();
export const userPermissionsPatchSchema = z
  .object({
    expectedRevision: z.number().int().min(0).optional(),
    canChat: z.boolean().nullable().optional(),
    canChatImages: z.boolean().nullable().optional(),
    canSharedNotes: z.boolean().nullable().optional(),
    lockExempt: z.boolean().optional(),
    interactionLocked: z.boolean().optional(),
    canWhiteboard: z.boolean().nullable().optional(),
    canMicrophone: z.boolean().nullable().optional(),
    canCamera: z.boolean().nullable().optional(),
    canScreenShare: z.boolean().nullable().optional(),
    canRaiseHand: z.boolean().nullable().optional(),
    isPresenter: z.boolean().optional(),
    kicked: z.boolean().optional(),
    lowerHand: z.boolean().optional(),
  })
  .strict();
export type UserPermissionsPatch = z.infer<typeof userPermissionsPatchSchema>;
export function resolveUserPermissions(
  roomRow: Record<string, unknown>,
  role: string,
  userPermRow?: Record<string, unknown> | null,
) {
  const settings = formatRoomSettings(roomRow);
  const isStaff = role === 'owner' || role === 'teacher';
  const interactionLocked = !isStaff && Boolean(userPermRow?.interaction_locked);
  const locks = roomLockPolicy(roomRow.locks_json);
  const lockExempt = Boolean(userPermRow?.lock_exempt);
  const denied = (feature: keyof typeof locks) =>
    !isStaff && (interactionLocked || (!lockExempt && locks[feature]));
  const isPresenter = isStaff || (!interactionLocked && Boolean(userPermRow?.is_presenter));
  const toNullableBool = (v: unknown): boolean | null =>
    v === null || v === undefined ? null : Boolean(v);
  const overrides = {
    canChat: toNullableBool(userPermRow?.can_chat),
    canChatImages: toNullableBool(userPermRow?.can_chat_images),
    canSharedNotes: toNullableBool(userPermRow?.can_shared_notes),
    lockExempt,
    interactionLocked,
    canWhiteboard: toNullableBool(userPermRow?.can_whiteboard),
    canMicrophone: toNullableBool(userPermRow?.can_microphone),
    canCamera: toNullableBool(userPermRow?.can_camera),
    canScreenShare: toNullableBool(userPermRow?.can_screen_share),
    canRaiseHand: toNullableBool(userPermRow?.can_raise_hand),
    isPresenter: Boolean(userPermRow?.is_presenter),
    kicked: Boolean(userPermRow?.kicked),
  };
  return {
    interactionLocked,
    canChat: isStaff
      ? true
      : !denied('chat') && (overrides.canChat ?? settings.permissions.chatEnabled),
    canChatImages:
      isStaff ||
      (!denied('chatImages') &&
        !denied('chat') &&
        (overrides.canChat ?? settings.permissions.chatEnabled) &&
        (overrides.canChatImages ?? false)),
    canSharedNotes: isStaff || (!denied('sharedNotes') && (overrides.canSharedNotes ?? true)),
    lockExempt,
    canWhiteboard:
      isStaff ||
      (!denied('whiteboard') &&
        overrides.canWhiteboard !== false &&
        (isPresenter ||
          (overrides.canWhiteboard ?? settings.permissions.studentWhiteboardEnabled))),
    canMicrophone: isStaff
      ? true
      : !denied('microphone') &&
        (overrides.canMicrophone ?? settings.permissions.defaultMicrophone),
    canCamera: isStaff
      ? true
      : !denied('camera') && (overrides.canCamera ?? settings.permissions.defaultCamera),
    canScreenShare:
      isStaff ||
      (!denied('screenShare') &&
        overrides.canScreenShare !== false &&
        (isPresenter || (overrides.canScreenShare ?? settings.permissions.defaultScreenShare))),
    canRaiseHand: isStaff
      ? true
      : !denied('raiseHand') && (overrides.canRaiseHand ?? settings.permissions.handRaiseEnabled),
    isPresenter,
    kicked: !isStaff && overrides.kicked,
    overrides,
  };
}
export function formatRoomSettings(row: Record<string, unknown>) {
  return {
    theme: (typeof row.theme === 'string' &&
    ['classic-bbb', 'modular-skyroom', 'immersive-glass', 'studio-hybrid'].includes(row.theme)
      ? row.theme
      : 'classic-bbb') as ClassroomTheme,
    pinnedNotice: typeof row.pinned_notice === 'string' ? row.pinned_notice : '',
    externalMediaUrl: typeof row.external_media_url === 'string' ? row.external_media_url : '',
    guestEntryEnabled: Boolean(row.guest_entry_enabled),
    guestMaxCapacity: Number(row.guest_max_capacity ?? 20),
    permissions: {
      chatEnabled: row.chat_enabled !== false && row.chat_enabled !== 0,
      handRaiseEnabled: row.hand_raise_enabled !== false && row.hand_raise_enabled !== 0,
      studentWhiteboardEnabled: Boolean(row.student_whiteboard_enabled),
      defaultMicrophone: row.default_microphone !== false && row.default_microphone !== 0,
      defaultCamera: row.default_camera !== false && row.default_camera !== 0,
      defaultScreenShare: row.default_screen_share !== false && row.default_screen_share !== 0,
      locked: Boolean(row.locked),
    },
  };
}

// An explicit user revocation also applies to otherwise collaborative boards.
export function canEditWhiteboard(
  room: Record<string, unknown>,
  role: string,
  teacherOnly: boolean,
) {
  const effective = resolveUserPermissions(
    room,
    role,
    room._userPerm as Record<string, unknown> | undefined,
  );
  if (role === 'owner' || role === 'teacher') return true;
  return (
    effective.canWhiteboard &&
    (effective.isPresenter || !teacherOnly || effective.overrides.canWhiteboard === true)
  );
}
export interface Config {
  redisUrl?: string;
  trustLocalProxy?: boolean;
  presentationsEnabled?: boolean;
  presentationWorker?: boolean;
  origin: string;
  production: boolean;
  mediaUrl: string;
  mediaKey: string;
  mediaSecret: string;
  mediaControl?: MediaControl;
  /** Test harness only: real deployments always run the durable media command worker. */
  mediaWorker?: boolean;
  breakoutWorker?: boolean;
  files?: FileConfig;
}
export async function buildApp(pool: DatabasePool, config: Config) {
  const cache = new OptionalCache(
    config.redisUrl,
    (process.env.DATABASE_URL ?? '') + config.origin,
  );
  if (config.production && config.files?.allowUnscanned)
    throw new Error('Production cannot release unscanned files');
  const media = new MediaService(pool, config);
  const breakouts = new BreakoutService(pool, media);
  media.authorizeLocation = (room, session, user, c) =>
    breakouts.assertMediaLocation(room, session, user, c);
  const app = Fastify({
    trustProxy: config.trustLocalProxy ? ['127.0.0.1', '::1'] : false,
    logger: config.production
      ? {
          serializers: {
            req: (r: { method?: string; url?: string }) => ({
              method: r.method,
              url: r.url?.split('?')[0],
            }),
          },
          redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'],
        }
      : false,
    bodyLimit: 32 * 1024,
  });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  await app.register(cookie);
  app.addHook('onClose', async () => cache.close());
  await app.register(helmet);
  const requestIdentities = new WeakMap<
    object,
    { token: string; at: number; identity: { id: string; email: string; name: string } }
  >();
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    hook: 'preHandler',
    keyGenerator: async (req) => {
      // Authentication endpoints retain IP limits even for signed-in callers.
      if (req.routeOptions.url?.startsWith('/api/v1/auth/')) return 'ip:' + req.ip;
      try {
        return 'user:' + (await user(req)).id;
      } catch {
        return 'ip:' + req.ip;
      }
    },
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: 'Invalid input',
        issues: error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    const e = error as Error & { statusCode?: number; code?: string };
    if (e.message === 'Queue limit reached.')
      return reply
        .header('Retry-After', '1')
        .code(503)
        .send({ error: 'Database temporarily busy' });
    if (e.code === '23505' || e.code === 'ER_DUP_ENTRY')
      return reply.code(409).send({ error: 'Already exists' });
    const status = e.statusCode ?? 500;
    if (status >= 500) req.log.error(error);
    return reply.code(status).send({
      error: status >= 500 && !(error instanceof HttpError) ? 'Internal server error' : e.message,
    });
  });
  app.addHook('onRequest', async (req) => {
    if (
      req.url !== '/api/v1/media/webhook' &&
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.headers.origin !== config.origin
    )
      throw new HttpError(403, 'Origin rejected');
  });
  async function user(req: { cookies: Record<string, string | undefined> }) {
    const token = req.cookies.toaster_session;
    if (!token) throw new HttpError(401, 'Sign in required');
    const cached = requestIdentities.get(req);
    // A WebSocket keeps its upgrade request for heartbeat authorization. Never
    // let that request retain authentication across subsequent heartbeats.
    if (cached?.token === token && Date.now() - cached.at < 100) return cached.identity;
    const result = await pool.query(
      'SELECT u.id,u.email,u.name FROM users u JOIN auth_sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>CURRENT_TIMESTAMP(3)',
      [hashToken(token)],
    );
    if (!result.rows[0]) throw new HttpError(401, 'Session expired');
    const identity = result.rows[0] as { id: string; email: string; name: string };
    requestIdentities.set(req, { token, at: Date.now(), identity });
    return identity;
  }
  async function membership(org: string, uid: string, write = false) {
    const r = await pool.query(
      'SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2',
      [uuid.parse(org), uid],
    );
    if (!r.rows[0] || (write && r.rows[0].role === 'student'))
      throw new HttpError(403, 'Permission denied');
    return r.rows[0].role as string;
  }
  async function roomAccess(id: string, uid: string) {
    const roomId = uuid.parse(id);
    const r = await pool.query('SELECT * FROM classrooms WHERE id=$1', [roomId]);
    if (!r.rows[0]) throw new HttpError(404, 'Classroom not found');
    const role = await membership(r.rows[0].organization_id, uid);
    const isGuest = await assertGuestAccess(pool, r.rows[0], uid);
    if (!isGuest && !(await hasClassroomAccess(pool, roomId, uid, role)))
      throw new HttpError(403, 'Classroom access is not assigned');
    if (r.rows[0].locked && role === 'student')
      throw new HttpError(403, 'Classroom is locked by moderator');
    const userPerm = (
      await pool.query(
        'SELECT * FROM classroom_user_permissions WHERE classroom_id=$1 AND user_id=$2',
        [roomId, uid],
      )
    ).rows[0];
    if (userPerm?.kicked && role === 'student')
      throw new HttpError(403, 'Removed from classroom by moderator');
    await breakouts.assertRoomAccess(id, uid, role);
    return { ...r.rows[0], _userPerm: userPerm ?? null };
  }
  async function audit(
    uid: string,
    org: string,
    action: string,
    id: string,
    c: DatabaseConnection,
    details: Record<string, unknown> = {},
  ) {
    await c.query(
      'INSERT INTO audit_logs(id,actor_id,organization_id,action,resource_id,details) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(), uid, org, action, id, JSON.stringify(details)],
    );
  }
  async function transaction<T>(fn: (c: DatabaseConnection) => Promise<T>) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const v = await fn(c);
      await c.query('COMMIT');
      return v;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/api/v1/connection', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    await pool.query('SELECT 1');
    return { status: 'ready' };
  });
  app.get('/ready', async () => {
    await pool.query('SELECT 1');
    return { status: 'ready' };
  });
  app.post(
    '/api/v1/auth/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const data = credentials
        .extend({
          name: named.shape.name,
          locale: z.enum(['fa', 'en']).optional(),
          timezone: timezone.default('Asia/Tehran'),
          passwordConfirmation: z.string().optional(),
        })
        .refine(
          (d) => d.passwordConfirmation === undefined || d.passwordConfirmation === d.password,
          { path: ['passwordConfirmation'], message: 'Passwords do not match' },
        )
        .parse(req.body);
      const id = randomUUID();
      await transaction(async (c) => {
        const registration = (
          await c.query('SELECT registration_open FROM platform_settings WHERE id=1 FOR UPDATE')
        ).rows[0];
        if (!registration?.registration_open) throw new HttpError(403, 'Registration is closed');
        await c.query(
          'INSERT INTO users(id,email,name,password_hash,locale,timezone) VALUES($1,$2,$3,$4,$5,$6)',
          [
            id,
            data.email,
            data.name,
            await hashPassword(data.password),
            data.locale ?? (await readPlatformOptions(c)).defaultLanguage,
            data.timezone,
          ],
        );
        await securityEvent(c, id, 'account.registered');
      });
      return reply.code(201).send({ id, email: data.email, name: data.name });
    },
  );
  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const data = credentials.extend({ remember: z.boolean().default(true) }).parse(req.body);
      const token = randomBytes(32).toString('hex');
      const signedIn = await transaction(async (c) => {
        const r = await c.query('SELECT * FROM users WHERE email=$1 FOR UPDATE', [data.email]);
        const fallback = '00000000000000000000000000000000:' + '00'.repeat(64);
        const valid = await verify(data.password, r.rows[0]?.password_hash ?? fallback);
        if (!r.rows[0] || !valid) throw new HttpError(401, 'Invalid credentials');
        await c.query(
          'INSERT INTO auth_sessions(token_hash,user_id,expires_at,user_agent,id) VALUES($1,$2,$3,$4,$5)',
          [
            hashToken(token),
            r.rows[0].id,
            new Date(Date.now() + (data.remember ? 86400000 * 7 : 43200000)),
            (req.headers['user-agent'] ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256),
            randomUUID(),
          ],
        );
        await securityEvent(c, r.rows[0].id, 'account.signed_in');
        return { id: r.rows[0].id, name: r.rows[0].name, email: r.rows[0].email };
      });
      reply.setCookie('toaster_session', token, {
        httpOnly: true,
        secure: config.production,
        sameSite: 'strict',
        path: '/',
        ...(data.remember ? { maxAge: 604800 } : {}),
      });
      return {
        ...signedIn,
        isPlatformAdmin: !!(
          await pool.query('SELECT user_id FROM platform_admins WHERE user_id=$1', [signedIn.id])
        ).rowCount,
      };
    },
  );
  app.get('/api/v1/me', async (req) => {
    const u = await user(req);
    return {
      ...u,
      isPlatformAdmin: !!(
        await pool.query('SELECT user_id FROM platform_admins WHERE user_id=$1', [u.id])
      ).rowCount,
    };
  });
  await registerRegistrationControls(app, pool, user);
  await registerPlatformOptions(app, pool, user);
  await registerAccount(app, { pool, user, hashToken, hashPassword, verifyPassword: verify });
  await registerUserPreferences(app, { pool, user });
  app.post('/api/v1/auth/logout', async (req, reply) => {
    if (req.cookies.toaster_session)
      await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1', [
        hashToken(req.cookies.toaster_session),
      ]);
    reply.clearCookie('toaster_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/v1/organizations', async (req) => {
    const u = await user(req);
    return (
      await pool.query(
        'SELECT o.id,o.name,o.default_classroom_theme,m.role FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE m.user_id=$1 ORDER BY o.name',
        [u.id],
      )
    ).rows;
  });
  app.post('/api/v1/organizations', async (req, reply) => {
    const u = await user(req);
    const data = named
      .extend({ defaultClassroomTheme: classroomThemeSchema.optional() })
      .strict()
      .parse(req.body);
    const id = randomUUID();
    const options = await readPlatformOptions(pool);
    if (
      !options.allowOrgCreation &&
      !(await pool.query('SELECT user_id FROM platform_admins WHERE user_id=$1', [u.id])).rows
        .length
    )
      throw new HttpError(403, 'Organization creation is disabled by the platform administrator');
    const theme = data.defaultClassroomTheme ?? options.defaultTheme;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('INSERT INTO organizations(id,name,default_classroom_theme) VALUES($1,$2,$3)', [
        id,
        data.name,
        theme,
      ]);
      await c.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [
        id,
        u.id,
      ]);
      await c.query(
        'INSERT INTO audit_logs(id,actor_id,organization_id,action,resource_id,details) VALUES($1,$2,$3,$4,$3,$5)',
        [
          randomUUID(),
          u.id,
          id,
          'organization.created',
          JSON.stringify({ defaultClassroomTheme: theme }),
        ],
      );
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
    return reply
      .code(201)
      .send({ id, name: data.name, role: 'owner', default_classroom_theme: theme });
  });
  app.post<{ Params: { org: string } }>(
    '/api/v1/organizations/:org/members',
    async (req, reply) => {
      const u = await user(req);
      if ((await membership(req.params.org, u.id)) !== 'owner')
        throw new HttpError(403, 'Owner required');
      const data = z
        .object({
          email: z
            .email()
            .transform((v) => v.toLowerCase())
            .optional(),
          userId: z.uuid().optional(),
          role: z.enum(['teacher', 'student']),
        })
        .strict()
        .refine((value) => Boolean(value.email) !== Boolean(value.userId))
        .parse(req.body);
      if (
        data.userId &&
        !(await pool.query('SELECT user_id FROM platform_admins WHERE user_id=$1', [u.id])).rows
          .length
      )
        throw new HttpError(403, 'Platform administrator required');
      const target = (
        await pool.query(
          data.userId ? 'SELECT id FROM users WHERE id=$1' : 'SELECT id FROM users WHERE email=$1',
          [data.userId ?? data.email],
        )
      ).rows[0];
      if (!target) throw new HttpError(404, 'Account must register first');
      await transaction(async (c) => {
        if (
          data.userId &&
          !(await c.query('SELECT user_id FROM platform_admins WHERE user_id=$1', [u.id])).rows
            .length
        )
          throw new HttpError(403, 'Platform administrator required');
        await c.query('INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3)', [
          req.params.org,
          target.id,
          data.role,
        ]);
        await audit(u.id, req.params.org, 'member.added', target.id, c, { role: data.role });
      });
      return reply.code(201).send({ ok: true });
    },
  );
  app.get<{ Params: { org: string } }>('/api/v1/organizations/:org/classrooms', async (req) => {
    const u = await user(req);
    const role = await membership(req.params.org, u.id);
    const rows = (
      await pool.query(
        role === 'owner'
          ? 'SELECT c.id,c.name,c.theme,c.locked,c.chat_enabled,c.hand_raise_enabled,c.student_whiteboard_enabled,c.default_microphone,c.default_camera,c.default_screen_share,c.created_at,c.enrollment_mode FROM classrooms c LEFT JOIN breakout_rooms b ON b.classroom_id=c.id WHERE c.organization_id=$1 AND b.classroom_id IS NULL ORDER BY c.created_at DESC'
          : "SELECT c.id,c.name,c.theme,c.locked,c.chat_enabled,c.hand_raise_enabled,c.student_whiteboard_enabled,c.default_microphone,c.default_camera,c.default_screen_share,c.created_at,c.enrollment_mode FROM classrooms c LEFT JOIN breakout_rooms b ON b.classroom_id=c.id LEFT JOIN classroom_memberships a ON a.classroom_id=c.id AND a.user_id=$2 LEFT JOIN classroom_user_permissions p ON p.classroom_id=c.id AND p.user_id=$2 WHERE c.organization_id=$1 AND b.classroom_id IS NULL AND ($3='owner' OR ((c.enrollment_mode='organization' OR a.user_id IS NOT NULL) AND (p.kicked IS NULL OR p.kicked=false))) ORDER BY c.created_at DESC",
        role === 'owner' ? [req.params.org] : [req.params.org, u.id, role],
      )
    ).rows;
    return rows.map((row) => ({
      ...row,
      ...formatRoomSettings(row),
    }));
  });
  app.post<{ Params: { org: string } }>(
    '/api/v1/organizations/:org/classrooms',
    async (req, reply) => {
      const u = await user(req);
      if ((await membership(req.params.org, u.id)) !== 'owner')
        throw new HttpError(403, 'Organization owner required');
      const data = named
        .extend({
          theme: classroomThemeSchema.optional(),
          permissions: classroomPermissionsSchema.optional(),
          enrollmentMode: enrollmentSchema.shape.enrollmentMode,
          memberIds: enrollmentSchema.shape.memberIds,
          guestEntryEnabled: z.boolean().optional(),
          guestMaxCapacity: z.number().int().min(1).max(500).optional(),
        })
        .strict()
        .parse(req.body);
      const id = randomUUID();
      const created = await transaction(async (c) => {
        const options = await readPlatformOptions(c);
        // Reject an invalid roster before creating any classroom or audit records.
        if (data.memberIds.length) {
          const members = await c.query(
            'SELECT user_id FROM memberships WHERE organization_id=$1',
            [req.params.org],
          );
          const memberIds = new Set(members.rows.map((member) => member.user_id));
          if (data.memberIds.some((memberId) => !memberIds.has(memberId)))
            throw new HttpError(400, 'Every classroom member must belong to this organization');
        }
        const orgRow = (
          await c.query('SELECT default_classroom_theme FROM organizations WHERE id=$1', [
            req.params.org,
          ])
        ).rows[0];
        const theme: ClassroomTheme =
          data.theme ??
          (orgRow?.default_classroom_theme &&
          ['classic-bbb', 'modular-skyroom', 'immersive-glass', 'studio-hybrid'].includes(
            orgRow.default_classroom_theme,
          )
            ? orgRow.default_classroom_theme
            : 'classic-bbb');
        const perms = {
          chatEnabled: data.permissions?.chatEnabled ?? options.defaultPermissions.chatEnabled,
          handRaiseEnabled:
            data.permissions?.handRaiseEnabled ?? options.defaultPermissions.handRaiseEnabled,
          studentWhiteboardEnabled:
            data.permissions?.studentWhiteboardEnabled ??
            options.defaultPermissions.studentWhiteboardEnabled,
          defaultMicrophone:
            data.permissions?.defaultMicrophone ?? options.defaultPermissions.defaultMicrophone,
          defaultCamera:
            data.permissions?.defaultCamera ?? options.defaultPermissions.defaultCamera,
          defaultScreenShare:
            data.permissions?.defaultScreenShare ?? options.defaultPermissions.defaultScreenShare,
          locked: data.permissions?.locked ?? options.defaultPermissions.locked,
        };
        const guestEntryEnabled = data.guestEntryEnabled ?? false;
        const guestMaxCapacity = data.guestMaxCapacity ?? options.guestMaxCapacity ?? 20;
        await c.query(
          'INSERT INTO classrooms(id,organization_id,name,created_by,theme,chat_enabled,hand_raise_enabled,student_whiteboard_enabled,default_microphone,default_camera,default_screen_share,locked,guest_entry_enabled,guest_max_capacity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
          [
            id,
            req.params.org,
            data.name,
            u.id,
            theme,
            perms.chatEnabled,
            perms.handRaiseEnabled,
            perms.studentWhiteboardEnabled,
            perms.defaultMicrophone,
            perms.defaultCamera,
            perms.defaultScreenShare,
            perms.locked,
            guestEntryEnabled,
            guestMaxCapacity,
          ],
        );
        await c.query('UPDATE classrooms SET locks_json=$1 WHERE id=$2', [
          JSON.stringify(options.defaultLocks),
          id,
        ]);
        await audit(u.id, req.params.org, 'classroom.created', id, c, {
          theme,
          permissions: perms,
          guestEntryEnabled,
          guestMaxCapacity,
        });
        await saveClassroomEnrollment(c, id, req.params.org, {
          enrollmentMode: data.enrollmentMode,
          memberIds: data.memberIds,
        });
        return {
          id,
          name: data.name,
          theme,
          permissions: perms,
          guestEntryEnabled,
          guestMaxCapacity,
        };
      });
      return reply.code(201).send(created);
    },
  );
  app.get<{ Params: { id: string } }>('/api/v1/classrooms/:id', async (req) => {
    const u = await user(req);
    const room = await roomAccess(req.params.id, u.id);
    const context = await breakouts.context(room.id);
    return {
      id: room.id,
      name: room.name,
      ...formatRoomSettings(room),
      ...(context
        ? {
            parent: { id: context.parent_id, name: context.parent_name, groupId: context.group_id },
          }
        : {}),
    };
  });
  app.post<{ Params: { id: string } }>('/api/v1/classrooms/:id/settings', async (req) => {
    const u = await user(req);
    const room = await roomAccess(req.params.id, u.id);
    if ((await membership(room.organization_id, u.id)) !== 'owner')
      throw new HttpError(403, 'Organization owner required');
    const data = z
      .object({
        name: named.shape.name.optional(),
        theme: classroomThemeSchema.optional(),
        permissions: classroomPermissionsSchema.optional(),
        guestEntryEnabled: z.boolean().optional(),
        guestMaxCapacity: z.number().int().min(1).max(500).optional(),
      })
      .strict()
      .parse(req.body);
    const updated = await transaction(async (c) => {
      const current = (await c.query('SELECT * FROM classrooms WHERE id=$1 FOR UPDATE', [room.id]))
        .rows[0];
      if (!current) throw new HttpError(404, 'Classroom not found');
      const currentSettings = formatRoomSettings(current);
      const nextName = data.name ?? current.name;
      const nextTheme = data.theme ?? currentSettings.theme;
      const nextGuestEntryEnabled = data.guestEntryEnabled ?? currentSettings.guestEntryEnabled;
      const nextGuestMaxCapacity = data.guestMaxCapacity ?? currentSettings.guestMaxCapacity;
      const nextPerms = {
        chatEnabled: data.permissions?.chatEnabled ?? currentSettings.permissions.chatEnabled,
        handRaiseEnabled:
          data.permissions?.handRaiseEnabled ?? currentSettings.permissions.handRaiseEnabled,
        studentWhiteboardEnabled:
          data.permissions?.studentWhiteboardEnabled ??
          currentSettings.permissions.studentWhiteboardEnabled,
        defaultMicrophone:
          data.permissions?.defaultMicrophone ?? currentSettings.permissions.defaultMicrophone,
        defaultCamera: data.permissions?.defaultCamera ?? currentSettings.permissions.defaultCamera,
        defaultScreenShare:
          data.permissions?.defaultScreenShare ?? currentSettings.permissions.defaultScreenShare,
        locked: data.permissions?.locked ?? currentSettings.permissions.locked,
      };
      await c.query(
        'UPDATE classrooms SET name=$1,theme=$2,chat_enabled=$3,hand_raise_enabled=$4,student_whiteboard_enabled=$5,default_microphone=$6,default_camera=$7,default_screen_share=$8,locked=$9,guest_entry_enabled=$10,guest_max_capacity=$11 WHERE id=$12',
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
          nextGuestEntryEnabled,
          nextGuestMaxCapacity,
          room.id,
        ],
      );
      await audit(u.id, room.organization_id, 'classroom.settings_updated', room.id, c, {
        name: nextName,
        theme: nextTheme,
        permissions: nextPerms,
        guestEntryEnabled: nextGuestEntryEnabled,
        guestMaxCapacity: nextGuestMaxCapacity,
      });
      return {
        id: room.id,
        name: nextName,
        theme: nextTheme,
        permissions: nextPerms,
        guestEntryEnabled: nextGuestEntryEnabled,
        guestMaxCapacity: nextGuestMaxCapacity,
      };
    });
    (app as unknown as { notifyClassroom: (id: string) => void }).notifyClassroom(room.id);
    return updated;
  });
  app.post<{ Params: { id: string } }>('/api/v1/classrooms/:id/join', async (req) => {
    const u = await user(req);
    const room = await roomAccess(req.params.id, u.id);
    const join = await media.issue(room.id, u);
    return { ...join, room: { id: room.id, name: room.name, ...formatRoomSettings(room) } };
  });
  app.get<{ Params: { id: string }; Querystring: { categoryId?: string } }>(
    '/api/v1/classrooms/:id/messages',
    { config: { rateLimit: { max: 900, timeWindow: '1 minute' } } },
    async (req) => {
      const u = await user(req);
      const room = await roomAccess(req.params.id, u.id);
      const { categoryId } = z
        .object({ categoryId: z.union([z.literal('public'), z.uuid()]).optional() })
        .strict()
        .parse(req.query);
      const options = await readPlatformOptions(pool);
      const values: unknown[] = [req.params.id];
      const categoryFilter =
        categoryId === undefined
          ? ''
          : categoryId === 'public'
            ? ' AND m.category_id IS NULL'
            : ' AND m.category_id=$2';
      if (categoryId && categoryId !== 'public') values.push(categoryId);
      const rows = await cache.read<Record<string, unknown>[]>(
        'chat:' +
          room.id +
          ':' +
          String(room.chat_revision) +
          ':' +
          options.chatHistoryLimit +
          ':' +
          (categoryId ?? 'all'),
        async () =>
          (
            await pool.query(
              'SELECT m.id,m.body,m.user_id,m.category_id,m.image_file_id,m.created_at FROM messages m WHERE m.classroom_id=$1' +
                categoryFilter +
                ' ORDER BY m.created_at DESC,m.id DESC LIMIT ' +
                options.chatHistoryLimit,
              values,
            )
          ).rows.reverse(),
      );
      if (!rows.length) return rows;
      // Profile names and roles are deliberately fresh, even for cached messages.
      const ids = [...new Set(rows.map((row) => String(row.user_id)))];
      const authors = (
        await pool.query(
          'SELECT u.id,u.name,m.role FROM users u LEFT JOIN memberships m ON m.user_id=u.id AND m.organization_id=$1 WHERE u.id IN (' +
            ids.map((_, index) => '$' + (index + 2)).join(',') +
            ')',
          [room.organization_id, ...ids],
        )
      ).rows;
      const people = new Map(authors.map((author) => [author.id, author]));
      return rows.map((row) => ({
        ...row,
        name: people.get(row.user_id)?.name ?? '',
        role: people.get(row.user_id)?.role ?? null,
      }));
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/v1/classrooms/:id/messages',
    { config: { rateLimit: { max: 180, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const u = await user(req);
      const room = await roomAccess(req.params.id, u.id);
      const role = await membership(room.organization_id, u.id);
      const effective = resolveUserPermissions(room, role, room._userPerm);
      if (!effective.canChat) throw new HttpError(403, 'Chat is disabled by moderator');
      const data = z
        .object({
          body: z.string().trim().max(2000),
          categoryId: z.uuid().nullable().optional(),
          imageFileId: z.uuid().optional(),
          clientMessageId: z.uuid().optional(),
        })
        .strict()
        .refine((data) => Boolean(data.body || data.imageFileId))
        .parse(req.body);
      const id = randomUUID();
      const createdAt = new Date();
      const receipt = await transaction(async (c) => {
        await assertPublicChat(c, room.id);
        const authorization = await classroomAuthorization(c, room.id, u.id);
        const currentPermissions = resolveUserPermissions(
          authorization.room,
          authorization.role,
          authorization.room._userPerm,
        );
        const platformOptions = await readPlatformOptions(c);
        if (data.body.length > platformOptions.chatMessageMaxLength)
          throw new HttpError(400, 'Message exceeds the platform length limit');
        if (!currentPermissions.canChat) throw new HttpError(403, 'Chat is disabled by moderator');
        const digest = createHash('sha256')
          .update(JSON.stringify([data.body, data.categoryId ?? null, data.imageFileId ?? null]))
          .digest('hex');
        if (data.clientMessageId) {
          await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [u.id]);
          await c.query(
            'DELETE FROM chat_send_receipts WHERE classroom_id=$1 AND user_id=$2 AND created_at<$3',
            [room.id, u.id, new Date(Date.now() - 86400000)],
          );
          const prior = (
            await c.query(
              'SELECT message_id,digest FROM chat_send_receipts WHERE classroom_id=$1 AND user_id=$2 AND client_message_id=$3',
              [room.id, u.id, data.clientMessageId],
            )
          ).rows[0];
          if (prior) {
            if (prior.digest !== digest)
              throw new HttpError(409, 'Message request ID was already used for different content');
            return { id: prior.message_id, replayed: true };
          }
        }
        if (data.imageFileId) {
          if (!currentPermissions.canChatImages)
            throw new HttpError(403, 'Image messages are disabled by moderator');
          const file = (
            await c.query(
              'SELECT classroom_id,organization_id,uploaded_by,purpose,status,media_type,byte_size FROM files WHERE id=$1 FOR UPDATE',
              [data.imageFileId],
            )
          ).rows[0];
          if (
            !file ||
            file.classroom_id !== room.id ||
            file.organization_id !== room.organization_id ||
            file.purpose !== 'chat' ||
            file.status !== 'ready' ||
            !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.media_type)
          )
            throw new HttpError(404, 'Image not available');
          if (authorization.role === 'student' && file.uploaded_by !== u.id)
            throw new HttpError(403, 'Forbidden');
          if (Number(file.byte_size) > platformOptions.chatImageMaxMiB * 1024 * 1024)
            throw new HttpError(400, 'Image exceeds the platform size limit');
        }
        if (data.categoryId) {
          const category = (
            await c.query(
              'SELECT id FROM chat_categories WHERE id=$1 AND classroom_id=$2 FOR UPDATE',
              [data.categoryId, room.id],
            )
          ).rows[0];
          if (!category) throw new HttpError(404, 'Not found');
        }
        await c.query(
          'INSERT INTO messages(id,classroom_id,user_id,body,category_id,image_file_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            id,
            room.id,
            u.id,
            data.body,
            data.categoryId ?? null,
            data.imageFileId ?? null,
            createdAt,
          ],
        );
        await c.query('UPDATE classrooms SET chat_revision=chat_revision+1 WHERE id=$1', [room.id]);
        if (data.clientMessageId)
          await c.query(
            'INSERT INTO chat_send_receipts(classroom_id,user_id,client_message_id,message_id,digest) VALUES($1,$2,$3,$4,$5)',
            [room.id, u.id, data.clientMessageId, id, digest],
          );
        return {
          id,
          replayed: false,
          role: authorization.role,
        };
      });
      (
        app as unknown as {
          notifyClassroom: (id: string, type?: string, payload?: Record<string, unknown>) => void;
        }
      ).notifyClassroom(
        req.params.id,
        'chat_changed',
        receipt.replayed
          ? undefined
          : {
              message: {
                id,
                body: data.body,
                user_id: u.id,
                category_id: data.categoryId ?? null,
                image_file_id: data.imageFileId ?? null,
                created_at: createdAt.toISOString(),
                name: u.name,
                role: receipt.role ?? null,
              },
            },
      );
      return reply.code(201).send({ id: receipt.id, replayed: receipt.replayed });
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/v1/classrooms/:id/messages/clear',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const u = await user(req);
      const room = await roomAccess(req.params.id, u.id);
      await membership(room.organization_id, u.id, true);
      await transaction(async (c) => {
        await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [room.id]);
        const authorization = await classroomAuthorization(c, room.id, u.id);
        if (!['owner', 'teacher'].includes(authorization.role))
          throw new HttpError(403, 'Forbidden');
        await c.query('DELETE FROM messages WHERE classroom_id=$1', [room.id]);
        await c.query('UPDATE classrooms SET chat_revision=chat_revision+1 WHERE id=$1', [room.id]);
        await audit(u.id, room.organization_id, 'chat.cleared', room.id, c);
      });
      (app as unknown as { notifyClassroom: (id: string, type?: string) => void }).notifyClassroom(
        room.id,
        'chat_changed',
      );
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string; messageId: string } }>(
    '/api/v1/classrooms/:id/messages/:messageId/edit',
    { config: { rateLimit: { max: 180, timeWindow: '1 minute' } } },
    async (req) => {
      const u = await user(req);
      const room = await roomAccess(req.params.id, u.id);
      const role = await membership(room.organization_id, u.id);
      const data = z
        .object({ body: z.string().trim().max(2000), expectedBody: z.string().max(2000) })
        .strict()
        .parse(req.body);
      const messageId = uuid.parse(req.params.messageId);
      await transaction(async (c) => {
        await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [room.id]);
        const message = (
          await c.query(
            'SELECT user_id,body,image_file_id FROM messages WHERE id=$1 AND classroom_id=$2 FOR UPDATE',
            [messageId, room.id],
          )
        ).rows[0];
        if (!message) throw new HttpError(404, 'Not found');
        if (!data.body && !message.image_file_id) throw new HttpError(400, 'Invalid input');
        const authorization = await classroomAuthorization(c, room.id, u.id);
        if (data.body.length > (await readPlatformOptions(c)).chatMessageMaxLength)
          throw new HttpError(400, 'Message exceeds the platform length limit');
        if (message.user_id !== u.id && !['owner', 'teacher'].includes(authorization.role))
          throw new HttpError(403, 'Forbidden');
        if (
          !resolveUserPermissions(
            authorization.room,
            authorization.role,
            authorization.room._userPerm,
          ).canChat
        )
          throw new HttpError(403, 'Chat is disabled by moderator');
        if (message.body !== data.expectedBody)
          throw new HttpError(409, 'Message changed; reload before editing');
        await assertPublicChat(c, room.id);
        await c.query('UPDATE messages SET body=$1 WHERE id=$2 AND classroom_id=$3', [
          data.body,
          messageId,
          room.id,
        ]);
        await c.query('UPDATE classrooms SET chat_revision=chat_revision+1 WHERE id=$1', [room.id]);
        await audit(u.id, room.organization_id, 'chat.message_edited', messageId, c);
      });
      (app as unknown as { notifyClassroom: (id: string, type?: string) => void }).notifyClassroom(
        room.id,
        'chat_changed',
      );
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string; messageId: string } }>(
    '/api/v1/classrooms/:id/messages/:messageId/delete',
    { config: { rateLimit: { max: 180, timeWindow: '1 minute' } } },
    async (req) => {
      const u = await user(req);
      const room = await roomAccess(req.params.id, u.id);
      const role = await membership(room.organization_id, u.id);
      const messageId = uuid.parse(req.params.messageId);
      await transaction(async (c) => {
        await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [room.id]);
        const message = (
          await c.query('SELECT user_id FROM messages WHERE id=$1 AND classroom_id=$2 FOR UPDATE', [
            messageId,
            room.id,
          ])
        ).rows[0];
        if (!message) throw new HttpError(404, 'Not found');
        const authorization = await classroomAuthorization(c, room.id, u.id);
        if (message.user_id !== u.id && !['owner', 'teacher'].includes(authorization.role))
          throw new HttpError(403, 'Forbidden');
        await c.query('DELETE FROM messages WHERE id=$1 AND classroom_id=$2', [messageId, room.id]);
        await c.query('UPDATE classrooms SET chat_revision=chat_revision+1 WHERE id=$1', [room.id]);
        await audit(u.id, room.organization_id, 'chat.message_deleted', messageId, c);
      });
      (app as unknown as { notifyClassroom: (id: string, type?: string) => void }).notifyClassroom(
        room.id,
        'chat_changed',
      );
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string } }>('/api/v1/classrooms/:id/notice', async (req) => {
    const u = await user(req);
    const room = await roomAccess(req.params.id, u.id);
    await membership(room.organization_id, u.id, true);
    const data = z
      .object({
        pinnedNotice: z.string().trim().max(500).optional(),
        externalMediaUrl: z
          .string()
          .trim()
          .max(500)
          .refine((v) => {
            if (v === '') return true;
            try {
              return ['http:', 'https:'].includes(new URL(v).protocol);
            } catch {
              return false;
            }
          }, 'Invalid media URL')
          .optional(),
      })
      .strict()
      .parse(req.body);
    const updated = await transaction(async (c) => {
      const current = (await c.query('SELECT * FROM classrooms WHERE id=$1 FOR UPDATE', [room.id]))
        .rows[0];
      const nextNotice = data.pinnedNotice ?? current.pinned_notice ?? '';
      const nextMediaUrl = data.externalMediaUrl ?? current.external_media_url ?? '';
      await c.query('UPDATE classrooms SET pinned_notice=$1,external_media_url=$2 WHERE id=$3', [
        nextNotice,
        nextMediaUrl,
        room.id,
      ]);
      await audit(u.id, room.organization_id, 'classroom.notice_updated', room.id, c, {
        pinnedNotice: nextNotice,
        externalMediaUrl: nextMediaUrl,
      });
      return { pinnedNotice: nextNotice, externalMediaUrl: nextMediaUrl };
    });
    (app as unknown as { notifyClassroom: (id: string) => void }).notifyClassroom(room.id);
    return updated;
  });
  app.get<{ Params: { id: string } }>('/api/v1/classrooms/:id/user-permissions', async (req) => {
    const u = await user(req);
    const room = await roomAccess(req.params.id, u.id);
    await membership(room.organization_id, u.id, true);
    const [members, perms] = await Promise.all([
      pool.query(
        "SELECT u.id,u.name,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN classroom_memberships a ON a.classroom_id=$2 AND a.user_id=u.id WHERE m.organization_id=$1 AND ($3='organization' OR m.role='owner' OR a.user_id IS NOT NULL) ORDER BY u.name",
        [room.organization_id, room.id, room.enrollment_mode],
      ),
      pool.query('SELECT * FROM classroom_user_permissions WHERE classroom_id=$1', [room.id]),
    ]);
    const permMap = new Map(perms.rows.map((row) => [row.user_id as string, row]));
    const list = members.rows.map((m) => {
      const effective = resolveUserPermissions(room, m.role, permMap.get(m.id));
      return {
        userId: m.id,
        revision: Number(permMap.get(m.id)?.revision ?? 0),
        name: m.name,
        email: m.email,
        role: m.role,
        ...effective,
        effective,
      };
    });
    return { members: list };
  });
  app.post<{ Params: { id: string; userId: string } }>(
    '/api/v1/classrooms/:id/user-permissions/:userId',
    async (req) => {
      const u = await user(req);
      const room = await roomAccess(req.params.id, u.id);
      const actorRole = await membership(room.organization_id, u.id, true);
      const targetId = uuid.parse(req.params.userId);
      const targetRole = await membership(room.organization_id, targetId);
      if (actorRole !== 'owner' && targetRole !== 'student')
        throw new HttpError(403, 'Teachers can only moderate students');
      if (!(await hasClassroomAccess(pool, room.id, targetId, targetRole)))
        throw new HttpError(403, 'Classroom access is not assigned');
      const data = userPermissionsPatchSchema.parse(req.body);
      const result = await transaction(async (c) => {
        const currentRoom = (
          await c.query('SELECT * FROM classrooms WHERE id=$1 FOR UPDATE', [room.id])
        ).rows[0];
        const actor = await classroomAuthorization(c, room.id, u.id);
        const target = (
          await c.query(
            'SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE',
            [room.organization_id, targetId],
          )
        ).rows[0];
        if (!target || !['owner', 'teacher', 'student'].includes(target.role))
          throw new HttpError(403, 'Forbidden');
        if (
          !['owner', 'teacher'].includes(actor.role) ||
          (actor.role !== 'owner' && target.role !== 'student')
        )
          throw new HttpError(403, 'Forbidden');
        if (!(await hasClassroomAccess(c, room.id, targetId, target.role)))
          throw new HttpError(403, 'Classroom access is not assigned');
        if (data.interactionLocked && target.role !== 'student')
          throw new HttpError(400, 'Only students can be interaction locked');
        const existing = (
          await c.query(
            'SELECT * FROM classroom_user_permissions WHERE classroom_id=$1 AND user_id=$2 FOR UPDATE',
            [room.id, targetId],
          )
        ).rows[0];
        if (
          data.expectedRevision !== undefined &&
          Number(existing?.revision ?? 0) !== data.expectedRevision
        )
          throw new HttpError(409, 'Participant permissions changed; refresh before saving');
        const next = {
          can_shared_notes:
            data.canSharedNotes !== undefined
              ? data.canSharedNotes
              : (existing?.can_shared_notes ?? null),
          lock_exempt:
            data.lockExempt !== undefined ? data.lockExempt : Boolean(existing?.lock_exempt),
          can_chat: data.canChat !== undefined ? data.canChat : (existing?.can_chat ?? null),
          can_chat_images:
            data.canChatImages !== undefined
              ? data.canChatImages
              : (existing?.can_chat_images ?? null),
          interaction_locked:
            data.interactionLocked !== undefined
              ? data.interactionLocked
              : Boolean(existing?.interaction_locked),
          can_whiteboard:
            data.canWhiteboard !== undefined
              ? data.canWhiteboard
              : (existing?.can_whiteboard ?? null),
          can_microphone:
            data.canMicrophone !== undefined
              ? data.canMicrophone
              : (existing?.can_microphone ?? null),
          can_camera:
            data.canCamera !== undefined ? data.canCamera : (existing?.can_camera ?? null),
          can_screen_share:
            data.canScreenShare !== undefined
              ? data.canScreenShare
              : (existing?.can_screen_share ?? null),
          can_raise_hand:
            data.canRaiseHand !== undefined
              ? data.canRaiseHand
              : (existing?.can_raise_hand ?? null),
          is_presenter:
            data.isPresenter !== undefined ? data.isPresenter : Boolean(existing?.is_presenter),
          kicked: data.kicked !== undefined ? data.kicked : Boolean(existing?.kicked),
        };
        await c.query(
          sqlDialect(
            c,
            'INSERT INTO classroom_user_permissions(classroom_id,user_id,can_chat,can_whiteboard,can_microphone,can_camera,can_screen_share,can_raise_hand,is_presenter,kicked,can_chat_images,interaction_locked,can_shared_notes,lock_exempt,revision,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,CURRENT_TIMESTAMP(3)) ON CONFLICT(classroom_id,user_id) DO UPDATE SET can_chat=EXCLUDED.can_chat,can_whiteboard=EXCLUDED.can_whiteboard,can_microphone=EXCLUDED.can_microphone,can_camera=EXCLUDED.can_camera,can_screen_share=EXCLUDED.can_screen_share,can_raise_hand=EXCLUDED.can_raise_hand,is_presenter=EXCLUDED.is_presenter,kicked=EXCLUDED.kicked,can_chat_images=EXCLUDED.can_chat_images,interaction_locked=EXCLUDED.interaction_locked,can_shared_notes=EXCLUDED.can_shared_notes,lock_exempt=EXCLUDED.lock_exempt,revision=classroom_user_permissions.revision+1,updated_at=CURRENT_TIMESTAMP(3)',
            'INSERT INTO classroom_user_permissions(classroom_id,user_id,can_chat,can_whiteboard,can_microphone,can_camera,can_screen_share,can_raise_hand,is_presenter,kicked,can_chat_images,interaction_locked,can_shared_notes,lock_exempt,revision,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,CURRENT_TIMESTAMP(3)) AS incoming ON DUPLICATE KEY UPDATE can_chat=incoming.can_chat,can_whiteboard=incoming.can_whiteboard,can_microphone=incoming.can_microphone,can_camera=incoming.can_camera,can_screen_share=incoming.can_screen_share,can_raise_hand=incoming.can_raise_hand,is_presenter=incoming.is_presenter,kicked=incoming.kicked,can_chat_images=incoming.can_chat_images,interaction_locked=incoming.interaction_locked,can_shared_notes=incoming.can_shared_notes,lock_exempt=incoming.lock_exempt,revision=classroom_user_permissions.revision+1,updated_at=CURRENT_TIMESTAMP(3)',
          ),
          [
            room.id,
            targetId,
            next.can_chat,
            next.can_whiteboard,
            next.can_microphone,
            next.can_camera,
            next.can_screen_share,
            next.can_raise_hand,
            next.is_presenter,
            next.kicked,
            next.can_chat_images,
            next.interaction_locked,
            next.can_shared_notes,
            next.lock_exempt,
          ],
        );
        const resolved = resolveUserPermissions(currentRoom, targetRole, next);
        const mediaResolved = resolveUserPermissions(
          { ...currentRoom, locks_json: null },
          targetRole,
          next,
        );
        const activeSession = (
          await c.query('SELECT id FROM classroom_sessions WHERE active_key=$1 FOR UPDATE', [
            room.id,
          ])
        ).rows[0];
        if (activeSession && (data.lowerHand || resolved.kicked)) {
          await c.query('DELETE FROM hand_raises WHERE session_id=$1 AND user_id=$2', [
            activeSession.id,
            targetId,
          ]);
        }
        if (activeSession && media.control) {
          await c.query(
            sqlDialect(
              c,
              'INSERT INTO media_permissions(session_id,user_id,microphone,camera,screen_share,blocked) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id,user_id) DO UPDATE SET microphone=EXCLUDED.microphone,camera=EXCLUDED.camera,screen_share=EXCLUDED.screen_share,blocked=EXCLUDED.blocked,version=media_permissions.version+1',
              'INSERT INTO media_permissions(session_id,user_id,microphone,camera,screen_share,blocked) VALUES($1,$2,$3,$4,$5,$6) AS incoming ON DUPLICATE KEY UPDATE microphone=incoming.microphone,camera=incoming.camera,screen_share=incoming.screen_share,blocked=incoming.blocked,version=media_permissions.version+1',
            ),
            [
              activeSession.id,
              targetId,
              mediaResolved.canMicrophone,
              mediaResolved.canCamera,
              mediaResolved.canScreenShare,
              resolved.kicked,
            ],
          );
          const pRow = (
            await c.query(
              'SELECT version FROM media_permissions WHERE session_id=$1 AND user_id=$2',
              [activeSession.id, targetId],
            )
          ).rows[0];
          await c.query(
            'INSERT INTO media_commands(id,session_id,user_id,kind,payload) VALUES($1,$2,$3,$4,$5)',
            [
              randomUUID(),
              activeSession.id,
              targetId,
              resolved.kicked ? 'remove' : 'permissions',
              JSON.stringify({ version: pRow.version }),
            ],
          );
        }
        await audit(u.id, room.organization_id, 'classroom.user_permissions_updated', targetId, c, {
          classroomId: room.id,
          ...data,
        });
        return {
          userId: targetId,
          revision: Number(existing?.revision ?? 0) + 1,
          ...resolved,
          effective: resolved,
        };
      });
      (app as unknown as { notifyClassroom: (id: string) => void }).notifyClassroom(room.id);
      return result;
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/v1/classrooms/:id/user-permissions-bulk',
    async (req) => {
      const u = await user(req);
      const room = await roomAccess(req.params.id, u.id);
      await membership(room.organization_id, u.id, true);
      const data = z
        .object({
          canChat: z.boolean().nullable().optional(),
          canChatImages: z.boolean().nullable().optional(),
          canSharedNotes: z.boolean().nullable().optional(),
          lockExempt: z.boolean().optional(),
          interactionLocked: z.boolean().optional(),
          canWhiteboard: z.boolean().nullable().optional(),
          canMicrophone: z.boolean().nullable().optional(),
          canCamera: z.boolean().nullable().optional(),
          canScreenShare: z.boolean().nullable().optional(),
          canRaiseHand: z.boolean().nullable().optional(),
          locked: z.boolean().optional(),
          resetOverrides: z.boolean().optional(),
          clearHands: z.boolean().optional(),
        })
        .strict()
        .parse(req.body);
      await transaction(async (c) => {
        const currentRoom = (
          await c.query('SELECT * FROM classrooms WHERE id=$1 FOR UPDATE', [room.id])
        ).rows[0];
        if (!currentRoom) throw new HttpError(404, 'Classroom not found');
        const actor = await classroomAuthorization(c, room.id, u.id);
        if (!['owner', 'teacher'].includes(actor.role)) throw new HttpError(403, 'Forbidden');
        if (data.locked !== undefined) {
          await c.query('UPDATE classrooms SET locked=$1 WHERE id=$2', [data.locked, room.id]);
          currentRoom.locked = data.locked;
        }
        const activeSession = (
          await c.query('SELECT id FROM classroom_sessions WHERE active_key=$1 FOR UPDATE', [
            room.id,
          ])
        ).rows[0];
        if (activeSession && data.clearHands) {
          await c.query('DELETE FROM hand_raises WHERE session_id=$1', [activeSession.id]);
        }
        if (data.resetOverrides) {
          await c.query(
            'DELETE FROM classroom_user_permissions WHERE classroom_id=$1 AND kicked=FALSE',
            [room.id],
          );
        }
        const hasPermPatch =
          data.canSharedNotes !== undefined ||
          data.lockExempt !== undefined ||
          data.canChatImages !== undefined ||
          data.interactionLocked !== undefined ||
          data.canChat !== undefined ||
          data.canWhiteboard !== undefined ||
          data.canMicrophone !== undefined ||
          data.canCamera !== undefined ||
          data.canScreenShare !== undefined ||
          data.canRaiseHand !== undefined;
        if (hasPermPatch) {
          const students = (
            await c.query(
              "SELECT m.user_id FROM memberships m LEFT JOIN classroom_memberships a ON a.classroom_id=$2 AND a.user_id=m.user_id WHERE m.organization_id=$1 AND m.role='student' AND ($3='organization' OR a.user_id IS NOT NULL)",
              [room.organization_id, room.id, currentRoom.enrollment_mode],
            )
          ).rows;
          for (const s of students) {
            const targetId = s.user_id as string;
            const existing = (
              await c.query(
                'SELECT * FROM classroom_user_permissions WHERE classroom_id=$1 AND user_id=$2 FOR UPDATE',
                [room.id, targetId],
              )
            ).rows[0];
            const next = {
              can_shared_notes:
                data.canSharedNotes !== undefined
                  ? data.canSharedNotes
                  : (existing?.can_shared_notes ?? null),
              lock_exempt:
                data.lockExempt !== undefined ? data.lockExempt : Boolean(existing?.lock_exempt),
              can_chat: data.canChat !== undefined ? data.canChat : (existing?.can_chat ?? null),
              can_chat_images:
                data.canChatImages !== undefined
                  ? data.canChatImages
                  : (existing?.can_chat_images ?? null),
              interaction_locked:
                data.interactionLocked !== undefined
                  ? data.interactionLocked
                  : Boolean(existing?.interaction_locked),
              can_whiteboard:
                data.canWhiteboard !== undefined
                  ? data.canWhiteboard
                  : (existing?.can_whiteboard ?? null),
              can_microphone:
                data.canMicrophone !== undefined
                  ? data.canMicrophone
                  : (existing?.can_microphone ?? null),
              can_camera:
                data.canCamera !== undefined ? data.canCamera : (existing?.can_camera ?? null),
              can_screen_share:
                data.canScreenShare !== undefined
                  ? data.canScreenShare
                  : (existing?.can_screen_share ?? null),
              can_raise_hand:
                data.canRaiseHand !== undefined
                  ? data.canRaiseHand
                  : (existing?.can_raise_hand ?? null),
              is_presenter: Boolean(existing?.is_presenter),
              kicked: Boolean(existing?.kicked),
            };
            await c.query(
              sqlDialect(
                c,
                'INSERT INTO classroom_user_permissions(classroom_id,user_id,can_chat,can_whiteboard,can_microphone,can_camera,can_screen_share,can_raise_hand,is_presenter,kicked,can_chat_images,interaction_locked,can_shared_notes,lock_exempt,revision,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,CURRENT_TIMESTAMP(3)) ON CONFLICT(classroom_id,user_id) DO UPDATE SET can_chat=EXCLUDED.can_chat,can_whiteboard=EXCLUDED.can_whiteboard,can_microphone=EXCLUDED.can_microphone,can_camera=EXCLUDED.can_camera,can_screen_share=EXCLUDED.can_screen_share,can_raise_hand=EXCLUDED.can_raise_hand,is_presenter=EXCLUDED.is_presenter,kicked=EXCLUDED.kicked,can_chat_images=EXCLUDED.can_chat_images,interaction_locked=EXCLUDED.interaction_locked,can_shared_notes=EXCLUDED.can_shared_notes,lock_exempt=EXCLUDED.lock_exempt,revision=classroom_user_permissions.revision+1,updated_at=CURRENT_TIMESTAMP(3)',
                'INSERT INTO classroom_user_permissions(classroom_id,user_id,can_chat,can_whiteboard,can_microphone,can_camera,can_screen_share,can_raise_hand,is_presenter,kicked,can_chat_images,interaction_locked,can_shared_notes,lock_exempt,revision,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,CURRENT_TIMESTAMP(3)) AS incoming ON DUPLICATE KEY UPDATE can_chat=incoming.can_chat,can_whiteboard=incoming.can_whiteboard,can_microphone=incoming.can_microphone,can_camera=incoming.can_camera,can_screen_share=incoming.can_screen_share,can_raise_hand=incoming.can_raise_hand,is_presenter=incoming.is_presenter,kicked=incoming.kicked,can_chat_images=incoming.can_chat_images,interaction_locked=incoming.interaction_locked,can_shared_notes=incoming.can_shared_notes,lock_exempt=incoming.lock_exempt,revision=classroom_user_permissions.revision+1,updated_at=CURRENT_TIMESTAMP(3)',
              ),
              [
                room.id,
                targetId,
                next.can_chat,
                next.can_whiteboard,
                next.can_microphone,
                next.can_camera,
                next.can_screen_share,
                next.can_raise_hand,
                next.is_presenter,
                next.kicked,
                next.can_chat_images,
                next.interaction_locked,
                next.can_shared_notes,
                next.lock_exempt,
              ],
            );
            const resolved = resolveUserPermissions(currentRoom, 'student', next);
            const mediaResolved = resolveUserPermissions(
              { ...currentRoom, locks_json: null },
              'student',
              next,
            );
            if (activeSession && media.control) {
              await c.query(
                sqlDialect(
                  c,
                  'INSERT INTO media_permissions(session_id,user_id,microphone,camera,screen_share,blocked) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id,user_id) DO UPDATE SET microphone=EXCLUDED.microphone,camera=EXCLUDED.camera,screen_share=EXCLUDED.screen_share,blocked=EXCLUDED.blocked,version=media_permissions.version+1',
                  'INSERT INTO media_permissions(session_id,user_id,microphone,camera,screen_share,blocked) VALUES($1,$2,$3,$4,$5,$6) AS incoming ON DUPLICATE KEY UPDATE microphone=incoming.microphone,camera=incoming.camera,screen_share=incoming.screen_share,blocked=incoming.blocked,version=media_permissions.version+1',
                ),
                [
                  activeSession.id,
                  targetId,
                  mediaResolved.canMicrophone,
                  mediaResolved.canCamera,
                  mediaResolved.canScreenShare,
                  resolved.kicked,
                ],
              );
              const pRow = (
                await c.query(
                  'SELECT version FROM media_permissions WHERE session_id=$1 AND user_id=$2',
                  [activeSession.id, targetId],
                )
              ).rows[0];
              await c.query(
                'INSERT INTO media_commands(id,session_id,user_id,kind,payload) VALUES($1,$2,$3,$4,$5)',
                [
                  randomUUID(),
                  activeSession.id,
                  targetId,
                  resolved.kicked ? 'remove' : 'permissions',
                  JSON.stringify({ version: pRow.version }),
                ],
              );
            }
          }
        }
        await audit(
          u.id,
          room.organization_id,
          'classroom.user_permissions_bulk_updated',
          room.id,
          c,
          data,
        );
      });
      (app as unknown as { notifyClassroom: (id: string) => void }).notifyClassroom(room.id);
      return { ok: true };
    },
  );
  await registerTeaching(app, {
    pool,
    origin: config.origin,
    user,
    roomAccess,
    membership,
    enqueueMediaEnd: (c, id) => media.enqueueEnd(c, id),
    assertSessionControl: async (id) => {
      if (await breakouts.context(id))
        throw new HttpError(403, 'Manage breakout sessions from the main classroom');
    },
    closeBreakoutsForParent: (c, id, actor) => breakouts.closeForParent(c, id, actor),
  });
  await registerAttendance(
    app,
    { pool, origin: config.origin, user, roomAccess, membership },
    config.mediaKey,
    config.mediaSecret,
  );
  await registerMedia(
    app,
    { pool, origin: config.origin, user, roomAccess, membership },
    media,
    config.mediaWorker !== false,
  );
  await registerBreakouts(
    app,
    { pool, origin: config.origin, user, roomAccess, membership },
    breakouts,
    config.breakoutWorker !== false,
  );
  await registerFiles(
    app,
    { pool, origin: config.origin, user, roomAccess, membership },
    config.files ?? {},
  );
  await registerPresentations(
    app,
    { pool, origin: config.origin, user, roomAccess, membership },
    config.files ?? {},
    config.presentationsEnabled ?? false,
    config.presentationWorker !== false,
  );
  await registerBoards(app, { pool, origin: config.origin, user, roomAccess, membership });
  await registerPrivateChat(app, { pool, origin: config.origin, user, roomAccess, membership });
  await registerClassroomDownloads(app, {
    pool,
    origin: config.origin,
    user,
    roomAccess,
    membership,
  });
  await registerAnnotationPages(app, { pool, origin: config.origin, user, roomAccess, membership });
  await registerChatCategories(app, { pool, origin: config.origin, user, roomAccess, membership });
  await registerGeoGebra(app, { pool, origin: config.origin, user, roomAccess, membership });
  await registerSandbox(app, { pool, origin: config.origin, user, roomAccess, membership });
  await registerClassroomWorkspace(
    app,
    { pool, origin: config.origin, user, roomAccess, membership },
    config.presentationsEnabled ?? false,
  );
  await registerClassroomLocks(
    app,
    { pool, origin: config.origin, user, roomAccess, membership },
    (c, id) => media.enqueueClassPolicies(c, id),
  );
  await registerAdmin(app, { pool, origin: config.origin, user, roomAccess, membership });
  await registerClassroomAccess(app, { pool, origin: config.origin, user, roomAccess, membership });
  await registerGuest(app, {
    pool,
    production: process.env.NODE_ENV === 'production',
    user,
    roomAccess,
    membership,
  });
  return app;
}
