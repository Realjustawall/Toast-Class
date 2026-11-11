import { sqlDialect } from './database.js';
import { hasClassroomAccess } from './classroom-access.js';
import { resolveUserPermissions } from './app.js';
import { fail } from './errors.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DatabasePool, DatabaseConnection } from './database.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessToken, TokenVerifier, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import WebSocket from 'ws';
import type { TeachingContext } from './teaching.js';

export type MediaPolicy = {
  microphone: boolean;
  camera: boolean;
  screen_share: boolean;
  blocked: boolean;
  version: number;
};
const defaultPolicy: MediaPolicy = {
  microphone: true,
  camera: true,
  screen_share: true,
  blocked: false,
  version: 0,
};
function defaultRoomPolicy(row?: Record<string, unknown>): MediaPolicy {
  if (!row || !['owner', 'teacher', 'student'].includes(String(row.role)))
    return { microphone: false, camera: false, screen_share: false, blocked: true, version: 0 };
  const effective = resolveUserPermissions(row, String(row.role), row);
  return {
    microphone: effective.canMicrophone,
    camera: effective.canCamera,
    screen_share: effective.canScreenShare,
    blocked: effective.kicked || (row.role === 'student' && Boolean(row.locked)),
    version: 0,
  };
}
function boundPolicy(base: MediaPolicy, explicit?: MediaPolicy): MediaPolicy {
  if (!explicit) return base;
  return {
    microphone: Boolean(base.microphone && explicit.microphone),
    camera: Boolean(base.camera && explicit.camera),
    screen_share: Boolean(base.screen_share && explicit.screen_share),
    blocked: Boolean(base.blocked || explicit.blocked),
    version: Number(explicit.version),
  };
}
export type MediaParticipant = {
  identity: string;
  name: string;
  microphoneMuted: boolean;
  cameraMuted: boolean;
  screenSharing: boolean;
  policy: MediaPolicy;
};
export interface MediaControl {
  deleteRoom: (room: string) => Promise<void>;
  removeParticipant: (room: string, identity: string) => Promise<void>;
  applyPolicy: (
    room: string,
    identity: string,
    policy: MediaPolicy,
    metadata: string,
  ) => Promise<void>;
  participants: (room: string) => Promise<Omit<MediaParticipant, 'policy'>[]>;
}
export interface MediaConfig {
  origin: string;
  mediaUrl: string;
  mediaKey: string;
  mediaSecret: string;
  mediaControl?: MediaControl;
}

export const mediaRoomName = (sessionId: string) => 'toaster-' + sessionId;
export function allowedSources(policy: MediaPolicy) {
  if (policy.blocked) return [];
  return [
    policy.microphone ? TrackSource.MICROPHONE : null,
    policy.camera ? TrackSource.CAMERA : null,
    policy.screen_share ? TrackSource.SCREEN_SHARE : null,
    policy.screen_share ? TrackSource.SCREEN_SHARE_AUDIO : null,
  ].filter((s): s is TrackSource => s !== null);
}
function missing(error: unknown) {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'not_found'
  );
}
export function livekitControl(config: MediaConfig): MediaControl {
  const client = new RoomServiceClient(
    config.mediaUrl.replace(/^ws/, 'http'),
    config.mediaKey,
    config.mediaSecret,
    { requestTimeout: 5 },
  );
  return {
    async deleteRoom(room) {
      try {
        await client.deleteRoom(room);
      } catch (e) {
        if (!missing(e)) throw e;
      }
    },
    async removeParticipant(room, id) {
      try {
        await client.removeParticipant(room, id);
      } catch (e) {
        if (!missing(e)) throw e;
      }
    },
    async applyPolicy(room, id, policy, metadata) {
      try {
        const participant = await client.getParticipant(room, id);
        const sources = allowedSources(policy);
        for (const track of participant.tracks)
          if (!sources.includes(track.source))
            await client.mutePublishedTrack(room, id, track.sid, true);
        await client.updateParticipant(room, id, {
          metadata,
          permission: {
            canPublish: sources.length > 0,
            canPublishSources: sources,
            canSubscribe: true,
            canPublishData: false,
            canUpdateMetadata: false,
          },
        });
      } catch (e) {
        if (!missing(e)) throw e;
      }
    },
    async participants(room) {
      try {
        return (await client.listParticipants(room)).map((p) => ({
          identity: p.identity,
          name: p.name,
          microphoneMuted: !p.tracks.some((t) => t.source === TrackSource.MICROPHONE && !t.muted),
          cameraMuted: !p.tracks.some((t) => t.source === TrackSource.CAMERA && !t.muted),
          screenSharing: p.tracks.some((t) => t.source === TrackSource.SCREEN_SHARE && !t.muted),
        }));
      } catch (e) {
        if (missing(e)) return [];
        throw e;
      }
    },
  };
}
export class MediaService {
  authorizeLocation?: (
    classroomId: string,
    sessionId: string,
    userId: string,
    c: Pick<DatabasePool, 'query'>,
  ) => Promise<void>;
  readonly control: MediaControl | null;
  constructor(
    readonly pool: DatabasePool,
    readonly config: MediaConfig,
  ) {
    this.control =
      config.mediaControl ??
      (config.mediaKey && config.mediaSecret.length >= 32 ? livekitControl(config) : null);
  }
  async policy(
    sessionId: string,
    userId: string,
    c: Pick<DatabasePool, 'query'> = this.pool,
  ): Promise<MediaPolicy> {
    const explicit = (
      await c.query(
        'SELECT microphone,camera,screen_share,blocked,version FROM media_permissions WHERE session_id=$1 AND user_id=$2',
        [sessionId, userId],
      )
    ).rows[0];
    const roomDefaults = (
      await c.query(
        'SELECT c.*,m.role,p.can_microphone,p.can_camera,p.can_screen_share,p.is_presenter,p.kicked,p.interaction_locked,p.lock_exempt FROM classroom_sessions s JOIN classrooms c ON c.id=s.classroom_id LEFT JOIN memberships m ON m.organization_id=c.organization_id AND m.user_id=$2 LEFT JOIN classroom_user_permissions p ON p.classroom_id=c.id AND p.user_id=$2 WHERE s.id=$1',
        [sessionId, userId],
      )
    ).rows[0];
    return boundPolicy(defaultRoomPolicy(roomDefaults), explicit);
  }
  /** Two bounded queries for a roster instead of two queries per participant. */
  async policies(sessionId: string, userIds: string[]) {
    const result = new Map<string, MediaPolicy>();
    const unique = [...new Set(userIds)];
    // Chunk large SFU rosters so statement size and temporary allocations stay bounded.
    for (let offset = 0; offset < unique.length; offset += 800) {
      const ids = unique.slice(offset, offset + 800);
      const bindings = ids.map((_, index) => '$' + (index + 2)).join(',');
      const explicit = await this.pool.query(
        `SELECT user_id,microphone,camera,screen_share,blocked,version FROM media_permissions WHERE session_id=$1 AND user_id IN (${bindings})`,
        [sessionId, ...ids],
      );
      const defaults = await this.pool.query(
        `SELECT c.*,m.user_id,m.role,p.can_microphone,p.can_camera,p.can_screen_share,p.is_presenter,p.kicked,p.interaction_locked,p.lock_exempt FROM classroom_sessions s JOIN classrooms c ON c.id=s.classroom_id JOIN memberships m ON m.organization_id=c.organization_id LEFT JOIN classroom_user_permissions p ON p.classroom_id=c.id AND p.user_id=m.user_id WHERE s.id=$1 AND m.user_id IN (${bindings})`,
        [sessionId, ...ids],
      );
      for (const id of ids) result.set(id, defaultRoomPolicy());
      for (const row of defaults.rows) result.set(row.user_id, defaultRoomPolicy(row));
      for (const { user_id, ...policy } of explicit.rows)
        result.set(user_id, boundPolicy(result.get(user_id)!, policy as MediaPolicy));
    }
    return result;
  }
  async enqueueClassPolicies(c: DatabaseConnection, classroomId: string) {
    if (!this.control) return;
    const session = (
      await c.query('SELECT id FROM classroom_sessions WHERE active_key=$1 FOR UPDATE', [
        classroomId,
      ])
    ).rows[0];
    if (!session) return;
    const users = (
      await c.query(
        "SELECT m.user_id FROM media_permissions p JOIN memberships m ON m.user_id=p.user_id JOIN classrooms r ON r.organization_id=m.organization_id WHERE r.id=$1 AND p.session_id=$2 AND m.role='student'",
        [classroomId, session.id],
      )
    ).rows;
    for (const user of users) {
      await c.query(
        sqlDialect(
          c,
          'INSERT INTO media_permissions(session_id,user_id,microphone,camera,screen_share,blocked) VALUES($1,$2,true,true,true,false) ON CONFLICT(session_id,user_id) DO UPDATE SET version=media_permissions.version+1',
          'INSERT INTO media_permissions(session_id,user_id,microphone,camera,screen_share,blocked) VALUES($1,$2,true,true,true,false) ON DUPLICATE KEY UPDATE version=media_permissions.version+1',
        ),
        [session.id, user.user_id],
      );
      const row = (
        await c.query('SELECT version FROM media_permissions WHERE session_id=$1 AND user_id=$2', [
          session.id,
          user.user_id,
        ])
      ).rows[0];
      await c.query(
        "INSERT INTO media_commands(id,session_id,user_id,kind,payload) VALUES($1,$2,$3,'permissions',$4)",
        [randomUUID(), session.id, user.user_id, JSON.stringify({ version: row.version })],
      );
    }
  }
  async issue(classroomId: string, user: { id: string; name: string }) {
    if (!this.control) fail(503, 'Media service is not configured');
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const session = (
        await c.query('SELECT id FROM classroom_sessions WHERE active_key=$1 FOR UPDATE', [
          classroomId,
        ])
      ).rows[0];
      if (!session) fail(409, 'A teacher must start the session first');
      await this.authorizeLocation?.(classroomId, session.id, user.id, c);
      const policy = await this.policy(session.id, user.id, c);
      if (policy.blocked) fail(403, 'Media access blocked by moderator');
      // Keep a durable roster of issued grants, including SDK clients without a UI socket.
      await c.query(
        sqlDialect(
          c,
          'INSERT INTO media_permissions(session_id,user_id,microphone,camera,screen_share,blocked,version) VALUES($1,$2,true,true,true,false,0) ON CONFLICT(session_id,user_id) DO NOTHING',
          'INSERT INTO media_permissions(session_id,user_id,microphone,camera,screen_share,blocked,version) VALUES($1,$2,true,true,true,false,0) ON DUPLICATE KEY UPDATE session_id=media_permissions.session_id',
        ),
        [session.id, user.id],
      );
      const token = new AccessToken(this.config.mediaKey, this.config.mediaSecret, {
        identity: user.id,
        name: user.name,
        ttl: 120,
        metadata: JSON.stringify({
          classroomId,
          sessionId: session.id,
          policyVersion: policy.version,
        }),
      });
      const sources = allowedSources(policy);
      token.addGrant({
        roomJoin: true,
        room: mediaRoomName(session.id),
        canPublish: sources.length > 0,
        canPublishSources: sources,
        canSubscribe: true,
        canPublishData: false,
        canUpdateOwnMetadata: false,
      });
      const signed = await token.toJwt();
      await c.query('COMMIT');
      const publicUrl = new URL('/api/v1/media/signal', this.config.origin);
      publicUrl.protocol = publicUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      return { token: signed, url: publicUrl.toString(), sessionId: session.id, policy };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async enqueueEnd(c: DatabaseConnection, sessionId: string) {
    if (!this.control) return;
    await c.query(
      "INSERT INTO media_commands(id,session_id,kind,payload) VALUES($1,$2,'delete_room',$3)",
      [randomUUID(), sessionId, JSON.stringify({})],
    );
  }
  /** One database-locked command, with the session lock held through its bounded SFU call. */
  async processOne() {
    if (!this.control) return false;
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const cmd = (
        await c.query(
          "SELECT * FROM media_commands WHERE status='pending' AND next_attempt_at<=CURRENT_TIMESTAMP(3) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
        )
      ).rows[0];
      if (!cmd) {
        await c.query('COMMIT');
        return false;
      }
      const session = (
        await c.query('SELECT * FROM classroom_sessions WHERE id=$1 FOR UPDATE', [cmd.session_id])
      ).rows[0];
      try {
        const room = mediaRoomName(session.id);
        if (cmd.kind === 'delete_room') await this.control.deleteRoom(room);
        else if (cmd.kind === 'remove' && cmd.payload.reason === 'enrollment_revoked') {
          const member = (
            await c.query(
              'SELECT m.role FROM memberships m JOIN classrooms r ON r.organization_id=m.organization_id WHERE r.id=$1 AND m.user_id=$2',
              [session.classroom_id, cmd.user_id],
            )
          ).rows[0];
          if (
            !member ||
            !(await hasClassroomAccess(c, session.classroom_id, cmd.user_id, member.role))
          )
            await this.control.removeParticipant(room, cmd.user_id);
        } else if (cmd.kind === 'remove' && cmd.payload.reason === 'breakout_move') {
          const location = (
            await c.query(
              'SELECT a.revision,g.status,g.ends_at FROM breakout_assignments a JOIN breakout_groups g ON g.id=a.group_id WHERE a.group_id=$1 AND a.user_id=$2',
              [cmd.payload.groupId, cmd.user_id],
            )
          ).rows[0];
          if (
            location?.revision === cmd.payload.revision &&
            location.status === 'active' &&
            new Date(location.ends_at).getTime() > Date.now()
          )
            await this.control.removeParticipant(room, cmd.user_id);
        } else {
          const policy = await this.policy(session.id, cmd.user_id, c);
          if (cmd.payload.version === policy.version) {
            if (cmd.kind === 'remove' || policy.blocked)
              await this.control.removeParticipant(room, cmd.user_id);
            else if (!session.ended_at)
              await this.control.applyPolicy(
                room,
                cmd.user_id,
                policy,
                JSON.stringify({
                  classroomId: session.classroom_id,
                  sessionId: session.id,
                  policyVersion: policy.version,
                }),
              );
          }
        }
        await c.query(
          "UPDATE media_commands SET status='succeeded',attempts=attempts+1,last_error=NULL,completed_at=CURRENT_TIMESTAMP(3) WHERE id=$1",
          [cmd.id],
        );
      } catch {
        const attempts = cmd.attempts + 1;
        await c.query(
          'UPDATE media_commands SET status=$1,attempts=$2,last_error=$3,next_attempt_at=$4 WHERE id=$5',
          [
            attempts >= 8 ? 'failed' : 'pending',
            attempts,
            'SFU command failed; check connectivity and media service health',
            new Date(Date.now() + Math.min(60000, 1000 * 2 ** (attempts - 1))),
            cmd.id,
          ],
        );
      }
      await c.query('COMMIT');
      return true;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
}

export async function registerMedia(
  app: FastifyInstance,
  ctx: TeachingContext,
  service: MediaService,
  runWorker = true,
) {
  const { pool, user, roomAccess, membership } = ctx;
  let processing = false;
  let activeDrain: Promise<void> | undefined;
  const drain = async () => {
    if (processing) return;
    processing = true;
    try {
      for (let i = 0; i < 10; i++) if (!(await service.processOne())) break;
    } finally {
      processing = false;
    }
  };
  const schedule = () => {
    if (!activeDrain)
      activeDrain = drain().finally(() => {
        activeDrain = undefined;
      });
    return activeDrain;
  };
  let worker: ReturnType<typeof setInterval> | undefined;
  app.addHook('onReady', async () => {
    if (service.control && runWorker)
      worker = setInterval(
        () =>
          void schedule().catch((e) => app.log.error({ err: e }, 'Media command worker failed')),
        1000,
      );
  });
  app.addHook('onClose', async () => {
    clearInterval(worker);
    await activeDrain;
  });
  async function authorized(req: FastifyRequest) {
    if (!service.control) fail(503, 'Media service is not configured');
    if ((req.headers.upgrade || req.headers.origin) && req.headers.origin !== service.config.origin)
      fail(403, 'Origin rejected');
    const u = await user(req);
    const url = new URL(req.url, service.config.origin);
    const raw = url.searchParams.get('access_token');
    if (!raw || raw.length > 16384) fail(401, 'Media token required');
    let claims;
    try {
      claims = await new TokenVerifier(service.config.mediaKey, service.config.mediaSecret).verify(
        raw,
        0,
      );
    } catch {
      fail(401, 'Invalid media token');
    }
    if (claims.sub !== u.id || !claims.video?.roomJoin) fail(403, 'Media identity mismatch');
    let metadata;
    try {
      metadata = z
        .object({
          classroomId: z.uuid(),
          sessionId: z.uuid(),
          policyVersion: z.number().int().min(0),
        })
        .parse(JSON.parse(claims.metadata ?? ''));
    } catch {
      fail(403, 'Invalid media scope');
    }
    await roomAccess(metadata.classroomId, u.id);
    const session = (
      await pool.query('SELECT id FROM classroom_sessions WHERE id=$1 AND active_key=$2', [
        metadata.sessionId,
        metadata.classroomId,
      ])
    ).rows[0];
    if (!session || claims.video.room !== mediaRoomName(session.id))
      fail(403, 'Media session ended');
    await service.authorizeLocation?.(metadata.classroomId, session.id, u.id, pool);
    const policy = await service.policy(session.id, u.id);
    if (policy.blocked || metadata.policyVersion !== policy.version)
      fail(403, 'Media permission revoked');
  }
  for (const path of ['/rtc', '/rtc/v1']) {
    app.get(
      '/api/v1/media/signal' + path,
      { websocket: true, preValidation: authorized },
      (client, req) => {
        const target = new URL(
          req.url.replace('/api/v1/media/signal', ''),
          service.config.mediaUrl.replace(/^http/, 'ws'),
        );
        const upstream = new WebSocket(target, { handshakeTimeout: 8000, maxPayload: 1024 * 1024 });
        const queue: { data: Buffer; binary: boolean }[] = [];
        let queuedBytes = 0;
        client.on('message', (data, binary) => {
          const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes, { binary });
          else if (upstream.readyState === WebSocket.CONNECTING) {
            queuedBytes += bytes.length;
            if (queuedBytes > 1024 * 1024) {
              client.close(1009, 'Signaling queue limit');
              upstream.terminate();
            } else queue.push({ data: bytes, binary });
          }
        });
        upstream.on('open', () => {
          for (const m of queue) upstream.send(m.data, { binary: m.binary });
          queue.length = 0;
          queuedBytes = 0;
        });
        upstream.on('message', (data, binary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
        });
        upstream.on('error', () => {
          if (client.readyState === WebSocket.OPEN) client.close(1011, 'Media server unavailable');
        });
        client.on('error', () => upstream.terminate());
        upstream.on('close', () => {
          if (client.readyState === WebSocket.OPEN) client.close(1000, 'Media signaling closed');
        });
        client.on('close', () => upstream.terminate());
      },
    );
    app.get(
      '/api/v1/media/signal' + path + '/validate',
      { preValidation: authorized },
      async (req, reply) => {
        const target = new URL(
          req.url.replace('/api/v1/media/signal', ''),
          service.config.mediaUrl.replace(/^ws/, 'http'),
        );
        const response = await fetch(target, { signal: AbortSignal.timeout(5000) });
        return reply
          .code(response.status)
          .type('text/plain')
          .send(await response.text());
      },
    );
  }
  app.get<{ Params: { id: string } }>('/api/v1/classrooms/:id/participants', async (req) => {
    const u = await user(req);
    const room = await roomAccess(req.params.id, u.id);
    const session = (
      await pool.query('SELECT id FROM classroom_sessions WHERE active_key=$1', [room.id])
    ).rows[0];
    if (!session) return { participants: [], commands: [], restrictions: [] };
    if (!service.control) fail(503, 'Media service is not configured');
    const role = await membership(room.organization_id, u.id);
    const roles = new Map(
      (
        await pool.query('SELECT user_id,role FROM memberships WHERE organization_id=$1', [
          room.organization_id,
        ])
      ).rows.map((member) => [member.user_id, member.role]),
    );
    let participants;
    try {
      participants = await service.control.participants(mediaRoomName(session.id));
    } catch {
      fail(503, 'Media service unavailable');
    }
    const valid = participants.filter((p) => z.uuid().safeParse(p.identity).success);
    const policies = await service.policies(
      session.id,
      valid.map((p) => p.identity),
    );
    const result = valid.map((p) => ({
      ...p,
      canModerate: role === 'owner' || (role === 'teacher' && roles.get(p.identity) === 'student'),
      policy: policies.get(p.identity)!,
    }));
    return {
      participants: result,
      restrictions:
        role === 'student'
          ? []
          : (
              await pool.query(
                "SELECT p.user_id,u.name,p.microphone,p.camera,p.screen_share,p.blocked,p.version FROM media_permissions p JOIN users u ON u.id=p.user_id JOIN memberships m ON m.user_id=p.user_id AND m.organization_id=$2 WHERE p.session_id=$1 AND ($3='owner' OR m.role='student')",
                [session.id, room.organization_id, role],
              )
            ).rows,
      commands:
        role === 'student'
          ? []
          : (
              await pool.query(
                'SELECT id,kind,status,attempts,last_error FROM media_commands WHERE session_id=$1 ORDER BY created_at DESC LIMIT 20',
                [session.id],
              )
            ).rows,
    };
  });
  app.get<{ Params: { id: string } }>('/api/v1/classrooms/:id/media-commands', async (req) => {
    const u = await user(req);
    const room = await roomAccess(req.params.id, u.id);
    await membership(room.organization_id, u.id, true);
    return (
      await pool.query(
        'SELECT c.id,c.kind,c.status,c.attempts,c.last_error,c.session_id FROM media_commands c JOIN classroom_sessions s ON s.id=c.session_id LEFT JOIN breakout_rooms b ON b.session_id=s.id LEFT JOIN breakout_groups g ON g.id=b.group_id LEFT JOIN classroom_sessions parent ON parent.id=g.parent_session_id WHERE s.classroom_id=$1 OR parent.classroom_id=$1 ORDER BY c.created_at DESC LIMIT 50',
        [room.id],
      )
    ).rows;
  });
  app.post<{ Params: { id: string; command: string } }>(
    '/api/v1/classrooms/:id/media-commands/:command/retry',
    async (req) => {
      const u = await user(req);
      const room = await roomAccess(req.params.id, u.id);
      await membership(room.organization_id, u.id, true);
      const commandId = z.uuid().parse(req.params.command);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const command = (
          await c.query(
            'SELECT c.id,c.status,s.classroom_id FROM media_commands c JOIN classroom_sessions s ON s.id=c.session_id WHERE c.id=$1 FOR UPDATE',
            [commandId],
          )
        ).rows[0];
        if (!command) fail(404, 'Media command not found');
        if (command.classroom_id !== room.id) {
          const parent = (
            await c.query(
              'SELECT s.classroom_id FROM breakout_rooms b JOIN breakout_groups g ON g.id=b.group_id JOIN classroom_sessions s ON s.id=g.parent_session_id WHERE b.classroom_id=$1',
              [command.classroom_id],
            )
          ).rows[0];
          if (parent?.classroom_id !== room.id) fail(404, 'Media command not found');
        }
        if (command.status !== 'failed') fail(409, 'Only failed media commands can retry');
        await c.query(
          "UPDATE media_commands SET status='pending',attempts=0,next_attempt_at=CURRENT_TIMESTAMP(3),last_error=NULL WHERE id=$1",
          [commandId],
        );
        await c.query(
          'INSERT INTO audit_logs(id,actor_id,organization_id,action,resource_id) VALUES($1,$2,$3,$4,$5)',
          [randomUUID(), u.id, room.organization_id, 'media.command_retried', commandId],
        );
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
      if (runWorker) void schedule().catch((e) => app.log.error({ err: e }, 'Media retry failed'));
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string; userId: string } }>(
    '/api/v1/classrooms/:id/participants/:userId/permissions',
    async (req, reply) => {
      const u = await user(req);
      const room = await roomAccess(req.params.id, u.id);
      const actorRole = await membership(room.organization_id, u.id, true);
      const targetId = z.uuid().parse(req.params.userId);
      const targetRole = await membership(room.organization_id, targetId);
      if (actorRole !== 'owner' && targetRole !== 'student')
        fail(403, 'Teachers can only moderate students');
      if (!(await hasClassroomAccess(pool, room.id, targetId, targetRole)))
        fail(403, 'Classroom access is not assigned');
      if (!service.control) fail(503, 'Media service is not configured');
      const data = z
        .object({
          microphone: z.boolean(),
          camera: z.boolean(),
          screenShare: z.boolean(),
          blocked: z.boolean(),
        })
        .strict()
        .parse(req.body);
      const c = await pool.connect();
      const commandId = randomUUID();
      try {
        await c.query('BEGIN');
        const session = (
          await c.query('SELECT id FROM classroom_sessions WHERE active_key=$1 FOR UPDATE', [
            room.id,
          ])
        ).rows[0];
        if (!session) fail(409, 'No active session');
        await c.query(
          sqlDialect(
            c,
            'INSERT INTO media_permissions(session_id,user_id,microphone,camera,screen_share,blocked) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id,user_id) DO UPDATE SET microphone=EXCLUDED.microphone,camera=EXCLUDED.camera,screen_share=EXCLUDED.screen_share,blocked=EXCLUDED.blocked,version=media_permissions.version+1',
            'INSERT INTO media_permissions(session_id,user_id,microphone,camera,screen_share,blocked) VALUES($1,$2,$3,$4,$5,$6) AS incoming ON DUPLICATE KEY UPDATE microphone=incoming.microphone,camera=incoming.camera,screen_share=incoming.screen_share,blocked=incoming.blocked,version=media_permissions.version+1',
          ),
          [session.id, targetId, data.microphone, data.camera, data.screenShare, data.blocked],
        );
        const policy = (
          await c.query(
            'SELECT version FROM media_permissions WHERE session_id=$1 AND user_id=$2',
            [session.id, targetId],
          )
        ).rows[0];
        await c.query(
          'INSERT INTO media_commands(id,session_id,user_id,kind,payload) VALUES($1,$2,$3,$4,$5)',
          [
            commandId,
            session.id,
            targetId,
            data.blocked ? 'remove' : 'permissions',
            JSON.stringify({ version: policy.version }),
          ],
        );
        await c.query(
          'INSERT INTO audit_logs(id,actor_id,organization_id,action,resource_id) VALUES($1,$2,$3,$4,$5)',
          [randomUUID(), u.id, room.organization_id, 'media.permissions_changed', targetId],
        );
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
      (app as unknown as { notifyClassroom: (id: string) => void }).notifyClassroom(room.id);
      if (runWorker)
        void schedule().catch((e) => app.log.error({ err: e }, 'Media command dispatch failed'));
      return reply.code(202).send({ commandId, status: 'pending' });
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/v1/classrooms/:id/participants/mute-all',
    async (req, reply) => {
      const u = await user(req);
      const room = await roomAccess(req.params.id, u.id);
      await membership(room.organization_id, u.id, true);
      if (!service.control) fail(503, 'Media service is not configured');
      const data = z
        .object({
          microphone: z.boolean().default(false),
          camera: z.boolean().optional(),
          screenShare: z.boolean().optional(),
        })
        .strict()
        .parse(req.body ?? {});
      const c = await pool.connect();
      let affected = 0;
      try {
        await c.query('BEGIN');
        const session = (
          await c.query('SELECT id FROM classroom_sessions WHERE active_key=$1 FOR UPDATE', [
            room.id,
          ])
        ).rows[0];
        if (!session) fail(409, 'No active session');
        const students = (
          await c.query(
            "SELECT user_id FROM memberships WHERE organization_id=$1 AND role='student'",
            [room.organization_id],
          )
        ).rows;
        for (const s of students) {
          if (!(await hasClassroomAccess(c, room.id, s.user_id, 'student'))) continue;
          const current = await service.policy(session.id, s.user_id, c);
          const nextMic = data.microphone;
          const nextCam = data.camera ?? current.camera;
          const nextScreen = data.screenShare ?? current.screen_share;
          await c.query(
            sqlDialect(
              c,
              'INSERT INTO media_permissions(session_id,user_id,microphone,camera,screen_share,blocked) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id,user_id) DO UPDATE SET microphone=EXCLUDED.microphone,camera=EXCLUDED.camera,screen_share=EXCLUDED.screen_share,version=media_permissions.version+1',
              'INSERT INTO media_permissions(session_id,user_id,microphone,camera,screen_share,blocked) VALUES($1,$2,$3,$4,$5,$6) AS incoming ON DUPLICATE KEY UPDATE microphone=incoming.microphone,camera=incoming.camera,screen_share=incoming.screen_share,version=media_permissions.version+1',
            ),
            [session.id, s.user_id, nextMic, nextCam, nextScreen, current.blocked],
          );
          const policyRow = (
            await c.query(
              'SELECT version FROM media_permissions WHERE session_id=$1 AND user_id=$2',
              [session.id, s.user_id],
            )
          ).rows[0];
          await c.query(
            "INSERT INTO media_commands(id,session_id,user_id,kind,payload) VALUES($1,$2,$3,'permissions',$4)",
            [randomUUID(), session.id, s.user_id, JSON.stringify({ version: policyRow.version })],
          );
          affected++;
        }
        await c.query(
          'INSERT INTO audit_logs(id,actor_id,organization_id,action,resource_id,details) VALUES($1,$2,$3,$4,$5,$6)',
          [
            randomUUID(),
            u.id,
            room.organization_id,
            'media.muted_all',
            room.id,
            JSON.stringify({ microphone: data.microphone, camera: data.camera, affected }),
          ],
        );
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
      (app as unknown as { notifyClassroom: (id: string) => void }).notifyClassroom(room.id);
      if (runWorker)
        void schedule().catch((e) => app.log.error({ err: e }, 'Media command dispatch failed'));
      return reply.code(202).send({ ok: true, affected });
    },
  );
}
