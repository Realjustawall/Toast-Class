import { sqlDialect } from './database.js';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import type { DatabasePool, DatabaseConnection } from './database.js';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { create as disposition } from 'content-disposition';
import { z } from 'zod';
import { fail, HttpError } from './errors.js';
import { transaction, audit } from './db.js';
import { fileName, inspectFile } from './file-validation.js';
import type { ObjectStorage } from './object-storage.js';
import type { FileScanner } from './antivirus.js';
import type { TeachingContext } from './teaching.js';
import { classroomAuthorization } from './classroom-access.js';
import { resolveUserPermissions } from './app.js';
import { assertClassroomFileDownload } from './classroom-downloads.js';
import { assertPublicChat } from './private-chat.js';
import { readPlatformOptions, assertPlatformFeature } from './platform-options.js';

export interface FileConfig {
  storage?: ObjectStorage;
  scanner?: FileScanner;
  allowUnscanned?: boolean;
  maxUploadBytes?: number;
  worker?: boolean;
}
type Scope = { orgId: string; roomId: string | null; userId: string; role: string };
type StoredFile = {
  id: string;
  organization_id: string;
  classroom_id: string | null;
  folder_id: string | null;
  name: string;
  original_name: string;
  object_key: string;
  byte_size: string | number;
  sha256: string | null;
  media_type: string | null;
  status: string;
  purpose: string;
  scan_status: string;
  failure_code: string | null;
  scan_attempts: number;
  scan_claim: string | null;
  scan_claimed_until: Date | null;
  cleanup_attempts: number;
  next_cleanup_at: Date;
  delete_reason: string | null;
  uploaded_by: string;
  created_at: Date;
  updated_at: Date;
};
const visibleFile = (file: StoredFile) => ({
  id: file.id,
  name: file.name,
  originalName: file.original_name,
  folderId: file.folder_id,
  byteSize: Number(file.byte_size),
  mediaType: file.media_type,
  status: file.status,
  scanStatus: file.scan_status,
  failureCode: file.failure_code,
  createdAt: file.created_at,
});
const tempFile = () => join(tmpdir(), 'toaster-upload-' + randomUUID());
const activeStatuses = "('uploading','quarantined','ready','deleting')";

export class FileService {
  readonly maxBytes: number;
  constructor(
    readonly pool: DatabasePool,
    readonly config: FileConfig,
  ) {
    this.maxBytes = z
      .number()
      .int()
      .min(1)
      .max(100 * 1024 * 1024)
      .parse(config.maxUploadBytes ?? 25 * 1024 * 1024);
  }
  requireStorage() {
    if (!this.config.storage) fail(503, 'File storage is not configured');
    return this.config.storage;
  }
  canScan() {
    return !!this.config.scanner || !!this.config.allowUnscanned;
  }
  async usage(orgId: string, c: Pick<DatabasePool, 'query'> = this.pool) {
    const organization = (
      await c.query('SELECT storage_quota_bytes FROM organizations WHERE id=$1', [orgId])
    ).rows[0];
    if (!organization) fail(404, 'Organization not found');
    const used = (
      await c.query(
        `SELECT COALESCE(SUM(byte_size),0) AS used FROM files WHERE organization_id=$1 AND status IN ${activeStatuses}`,
        [orgId],
      )
    ).rows[0].used;
    const reserved = (
      await c.query(
        'SELECT COALESCE(SUM(reserved_bytes),0) AS used FROM presentations WHERE organization_id=$1',
        [orgId],
      )
    ).rows[0].used;
    return {
      usedBytes: String(BigInt(used) + BigInt(reserved)),
      quotaBytes: String(organization.storage_quota_bytes),
    };
  }
  async lock(c: DatabaseConnection, orgId: string) {
    await c.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [orgId]);
  }
  async folder(c: Pick<DatabasePool, 'query'>, scope: Scope, folderId: string | null) {
    if (!folderId) return;
    const folder = (
      await c.query('SELECT * FROM file_folders WHERE id=$1 AND organization_id=$2', [
        folderId,
        scope.orgId,
      ])
    ).rows[0];
    if (!folder || folder.classroom_id !== scope.roomId)
      fail(404, 'Folder not found in this scope');
  }
  async file(
    scope: Scope,
    id: string,
    c: Pick<DatabasePool, 'query'> = this.pool,
    documentId?: string,
  ) {
    const file = (
      await c.query('SELECT * FROM files WHERE id=$1 AND organization_id=$2', [
        z.uuid().parse(id),
        scope.orgId,
      ])
    ).rows[0] as StoredFile | undefined;
    const referencedBackground =
      documentId &&
      scope.roomId &&
      file &&
      ['board', 'resource'].includes(file.purpose) &&
      file.status === 'ready'
        ? (
            await c.query(
              'SELECT d.id FROM collaborative_documents d LEFT JOIN board_assets a ON a.document_id=d.id AND a.file_id=$3 WHERE d.id=$1 AND d.classroom_id=$2 AND (d.background_file_id=$3 OR d.pdf_source_file_id=$3 OR a.file_id IS NOT NULL)',
              [z.uuid().parse(documentId), scope.roomId, id],
            )
          ).rows.length > 0
        : false;
    if (
      !file ||
      (file.classroom_id !== scope.roomId && !referencedBackground) ||
      file.status === 'deleted' ||
      (scope.role === 'student' && file.status !== 'ready')
    )
      fail(404, 'File not found');
    if (file.purpose === 'presentation') {
      const publication = (
        await c.query(
          'SELECT p.status,p.generation,a.generation AS asset_generation FROM presentation_assets a JOIN presentations p ON p.id=a.presentation_id WHERE a.file_id=$1 AND p.organization_id=$2',
          [file.id, scope.orgId],
        )
      ).rows[0];
      if (
        !publication ||
        publication.status !== 'ready' ||
        publication.generation !== publication.asset_generation
      )
        fail(404, 'Presentation output is not published');
    }
    return file;
  }
  async resourceFile(scope: Scope, id: string, c: Pick<DatabasePool, 'query'> = this.pool) {
    const file = await this.file(scope, id, c);
    if (file.purpose !== 'resource') fail(404, 'Resource file not found');
    return file;
  }
  async folderTree(
    c: Pick<DatabasePool, 'query'>,
    scope: Scope,
    id: string,
    parentId: string | null,
    isNew = false,
  ) {
    const rows = (
      await c.query(
        'SELECT id,parent_id FROM file_folders WHERE organization_id=$1 AND (classroom_id=$2 OR (classroom_id IS NULL AND $2 IS NULL)) LIMIT 1001',
        [scope.orgId, scope.roomId],
      )
    ).rows;
    if (rows.length > 1000 || (isNew && rows.length >= 1000)) fail(409, 'Folder limit exceeded');
    const parents = new Map<string, string | null>(rows.map((row) => [row.id, row.parent_id]));
    parents.set(id, parentId);
    for (const start of parents.keys()) {
      let current: string | null = start,
        depth = 0;
      const seen = new Set<string>();
      while (current) {
        if (seen.has(current)) fail(409, 'Folder move would create a cycle');
        seen.add(current);
        if (++depth > 32) fail(400, 'Folder nesting limit exceeded');
        current = parents.get(current) ?? null;
      }
    }
  }
  async reserve(
    scope: Scope,
    name: string,
    size: number,
    folderId: string | null,
    purpose: 'resource' | 'chat' | 'board' = 'resource',
  ) {
    const id = randomUUID(),
      key = randomUUID();
    await transaction(this.pool, async (c) => {
      await this.lock(c, scope.orgId);
      await this.folder(c, scope, folderId);
      const usage = await this.usage(scope.orgId, c);
      if (BigInt(usage.usedBytes) + BigInt(size) > BigInt(usage.quotaBytes))
        fail(409, 'Organization storage quota exceeded');
      await c.query(
        "INSERT INTO files(id,organization_id,classroom_id,folder_id,name,original_name,object_key,byte_size,status,scan_status,uploaded_by,purpose) VALUES($1,$2,$3,$4,$5,$5,$6,$7,'uploading','pending',$8,$9)",
        [id, scope.orgId, scope.roomId, folderId, name, key, size, scope.userId, purpose],
      );
      await audit(c, scope.userId, scope.orgId, 'file.upload_reserved', id, { byteSize: size });
    });
    return { id, key };
  }
  async abandon(id: string, orgId: string, putStarted: boolean) {
    await transaction(this.pool, async (c) => {
      await this.lock(c, orgId);
      await c.query(
        "UPDATE files SET status=$1,failure_code='upload_failed',delete_reason='upload_failed',updated_at=CURRENT_TIMESTAMP(3) WHERE id=$2 AND status='uploading'",
        [putStarted ? 'deleting' : 'failed', id],
      );
    });
  }
  async scan(id: string) {
    const storage = this.requireStorage();
    if (!this.canScan()) return false;
    const claim = randomUUID();
    const file = await transaction(this.pool, async (c) => {
      const row = (await c.query('SELECT * FROM files WHERE id=$1 FOR UPDATE', [id])).rows[0] as
        StoredFile | undefined;
      if (
        !row ||
        row.status !== 'quarantined' ||
        row.scan_attempts >= 5 ||
        (row.scan_claimed_until && new Date(row.scan_claimed_until).getTime() > Date.now())
      )
        return;
      await c.query(
        'UPDATE files SET scan_claim=$1,scan_claimed_until=$2,scan_attempts=scan_attempts+1 WHERE id=$3',
        [claim, new Date(Date.now() + 180000), id],
      );
      return row;
    });
    if (!file) return false;
    const path = tempFile();
    let verdict: 'clean' | 'infected' | 'unscanned' | 'error' = 'error';
    try {
      if (this.config.scanner) {
        let bytes = 0;
        const hash = createHash('sha256');
        await pipeline(
          await storage.get(file.object_key),
          new Transform({
            transform(chunk: Buffer, _encoding, done) {
              bytes += chunk.length;
              if (bytes > Number(file.byte_size)) {
                done(new Error('Stored content exceeds its declared size'));
                return;
              }
              hash.update(chunk);
              done(null, chunk);
            },
          }),
          createWriteStream(path, { flags: 'wx', mode: 0o600 }),
          { signal: AbortSignal.timeout(120000) },
        );
        if (bytes !== Number(file.byte_size) || hash.digest('hex') !== file.sha256)
          throw new Error('Stored content integrity check failed');
        verdict = await this.config.scanner.scan(path);
      } else verdict = 'unscanned';
    } catch {
      verdict = 'error';
    } finally {
      await unlink(path).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    await transaction(this.pool, async (c) => {
      await this.lock(c, file.organization_id);
      const current = (await c.query('SELECT * FROM files WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (current.status !== 'quarantined' || current.scan_claim !== claim) return;
      const status =
        verdict === 'clean' || verdict === 'unscanned'
          ? 'ready'
          : verdict === 'infected'
            ? 'deleting'
            : 'quarantined';
      await c.query(
        'UPDATE files SET status=$1,scan_status=$2,failure_code=$3,scan_claim=NULL,scan_claimed_until=NULL,next_scan_at=$4,delete_reason=$5,updated_at=CURRENT_TIMESTAMP(3) WHERE id=$6',
        [
          status,
          verdict,
          verdict === 'error' ? 'scanner_unavailable' : verdict === 'infected' ? 'infected' : null,
          new Date(Date.now() + Math.min(60000, 1000 * 2 ** file.scan_attempts)),
          verdict === 'infected' ? 'infected' : null,
          id,
        ],
      );
      await audit(c, null, file.organization_id, 'file.scan_completed', id, { verdict });
    });
    return true;
  }
  async sweep() {
    const storage = this.requireStorage();
    const changed: string[] = [];
    // Retain attached images. Abandoned uploads expire under the same row lock
    // that message publication takes, so cleanup cannot race a successful send.
    const abandoned = (
      await this.pool.query(
        "SELECT id,organization_id FROM files WHERE purpose IN ('chat','board') AND status IN ('ready','quarantined') AND created_at<$1 ORDER BY created_at LIMIT 5",
        [new Date(Date.now() - 86400000)],
      )
    ).rows;
    for (const candidate of abandoned)
      await transaction(this.pool, async (c) => {
        await this.lock(c, candidate.organization_id);
        const file = (await c.query('SELECT * FROM files WHERE id=$1 FOR UPDATE', [candidate.id]))
          .rows[0] as StoredFile;
        if (
          !file ||
          !['ready', 'quarantined'].includes(file.status) ||
          new Date(file.created_at).getTime() >= Date.now() - 86400000
        )
          return;
        if (
          (await c.query('SELECT id FROM messages WHERE image_file_id=$1 LIMIT 1', [file.id]))
            .rowCount
        )
          return;
        if (
          (
            await c.query(
              'SELECT id FROM collaborative_documents WHERE background_file_id=$1 LIMIT 1',
              [file.id],
            )
          ).rowCount
        )
          return;
        if (
          (
            await c.query('SELECT document_id FROM board_assets WHERE file_id=$1 LIMIT 1', [
              file.id,
            ])
          ).rows.length
        )
          return;
        if (
          (
            await c.query('SELECT stamp_id FROM annotation_stamp_assets WHERE file_id=$1 LIMIT 1', [
              file.id,
            ])
          ).rows.length
        )
          return;
        await c.query(
          "UPDATE files SET status='deleting',delete_reason='upload_expired',next_cleanup_at=CURRENT_TIMESTAMP(3),updated_at=CURRENT_TIMESTAMP(3) WHERE id=$1",
          [file.id],
        );
      });
    const candidates = (
      await this.pool.query(
        "SELECT id,organization_id FROM files WHERE (status='deleting' AND cleanup_attempts<8 AND next_cleanup_at<=CURRENT_TIMESTAMP(3)) OR (status='uploading' AND updated_at<$1) ORDER BY updated_at LIMIT 5",
        [new Date(Date.now() - 600000)],
      )
    ).rows;
    for (const candidate of candidates)
      await transaction(this.pool, async (c) => {
        await this.lock(c, candidate.organization_id);
        const file = (await c.query('SELECT * FROM files WHERE id=$1 FOR UPDATE', [candidate.id]))
          .rows[0] as StoredFile;
        if (
          file.status !== 'deleting' &&
          !(
            file.status === 'uploading' && new Date(file.updated_at).getTime() < Date.now() - 600000
          )
        )
          return;
        if (file.cleanup_attempts >= 8 || new Date(file.next_cleanup_at).getTime() > Date.now())
          return;
        try {
          await storage.delete(file.object_key);
          const status =
            file.scan_status === 'infected'
              ? 'rejected'
              : file.delete_reason === 'upload_failed' ||
                  file.delete_reason === 'upload_expired' ||
                  file.status === 'uploading'
                ? 'failed'
                : 'deleted';
          await c.query(
            'UPDATE files SET status=$1,cleanup_attempts=cleanup_attempts+1,failure_code=$2,updated_at=CURRENT_TIMESTAMP(3) WHERE id=$3',
            [
              status,
              status === 'rejected' ? 'infected' : status === 'failed' ? 'upload_failed' : null,
              file.id,
            ],
          );
          await audit(c, null, file.organization_id, 'file.blob_removed', file.id);
        } catch {
          await c.query(
            "UPDATE files SET status='deleting',cleanup_attempts=cleanup_attempts+1,failure_code='storage_cleanup_failed',delete_reason=$1,next_cleanup_at=$2,updated_at=CURRENT_TIMESTAMP(3) WHERE id=$3",
            [
              file.delete_reason ?? 'upload_expired',
              new Date(Date.now() + Math.min(60000, 1000 * 2 ** file.cleanup_attempts)),
              file.id,
            ],
          );
        }
        if (file.classroom_id) changed.push(file.classroom_id);
      });
    if (this.canScan()) {
      const scans = (
        await this.pool.query(
          "SELECT id,classroom_id FROM files WHERE status='quarantined' AND scan_attempts<5 AND next_scan_at<=CURRENT_TIMESTAMP(3) AND (scan_claimed_until IS NULL OR scan_claimed_until<=CURRENT_TIMESTAMP(3)) ORDER BY created_at LIMIT 5",
        )
      ).rows;
      for (const row of scans)
        if (await this.scan(row.id)) if (row.classroom_id) changed.push(row.classroom_id);
    }
    return changed;
  }
}

export async function registerFiles(
  app: FastifyInstance,
  ctx: TeachingContext,
  config: FileConfig,
) {
  const service = new FileService(ctx.pool, config);
  const { pool, user, roomAccess, membership } = ctx;
  await app.register(multipart, {
    limits: { files: 1, fields: 0, parts: 1, fileSize: service.maxBytes, headerPairs: 50 },
    throwFileSizeLimit: true,
  });
  const notify = (id: string | null) => {
    if (id) (app as unknown as { notifyClassroom: (id: string) => void }).notifyClassroom(id);
  };
  let timer: ReturnType<typeof setInterval> | undefined, work: Promise<unknown> | undefined;
  app.addHook('onReady', async () => {
    if (config.storage && config.worker !== false)
      timer = setInterval(() => {
        if (!work)
          work = service
            .sweep()
            .then((ids) => ids.forEach(notify))
            .catch((error) => app.log.error({ err: error }, 'File background processing failed'))
            .finally(() => {
              work = undefined;
            });
      }, 5000);
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await work;
    config.storage?.close?.();
  });
  async function scope(
    req: { cookies: Record<string, string | undefined> },
    id: string,
    isRoom: boolean,
    write = false,
  ): Promise<Scope> {
    const u = await user(req);
    if (isRoom) {
      const room = await roomAccess(z.uuid().parse(id), u.id);
      return {
        orgId: room.organization_id,
        roomId: room.id,
        userId: u.id,
        role: await membership(room.organization_id, u.id, write),
      };
    }
    return {
      orgId: z.uuid().parse(id),
      roomId: null,
      userId: u.id,
      role: await membership(id, u.id, write),
    };
  }
  for (const isRoom of [true, false]) {
    const prefix = '/api/v1/' + (isRoom ? 'classrooms' : 'organizations') + '/:id';
    type Params = { id: string; file: string; folder: string };
    app.get<{
      Params: Params;
      Querystring: { folderId?: string; search?: string; before?: string };
    }>(prefix + '/files', async (req) => {
      const access = await scope(req, req.params.id, isRoom);
      const query = z
        .object({
          folderId: z.uuid().optional(),
          search: z.string().max(100).optional(),
          before: z.uuid().optional(),
        })
        .parse(req.query);
      const folderId = query.folderId ?? null;
      await service.folder(pool, access, folderId);
      const cursor = query.before ? await service.resourceFile(access, query.before) : undefined;
      if (cursor && cursor.folder_id !== folderId)
        fail(400, 'Cursor belongs to a different folder');
      const pattern = '%' + (query.search ?? '').replace(/[\\%_]/g, '\\$&') + '%';
      const rows = (
        await pool.query(
          sqlDialect(
            pool,
            "SELECT * FROM files WHERE purpose='resource' AND organization_id=$1 AND (classroom_id=$2 OR (classroom_id IS NULL AND $2 IS NULL)) AND (folder_id=$3 OR (folder_id IS NULL AND $3 IS NULL)) AND status<>'deleted' AND ($4=false OR status='ready') AND name ILIKE $5 AND ($6::timestamptz IS NULL OR created_at<$6 OR (created_at=$6 AND id<$7)) ORDER BY created_at DESC,id DESC LIMIT 101",
            "SELECT * FROM files WHERE purpose='resource' AND organization_id=$1 AND (classroom_id=$2 OR (classroom_id IS NULL AND $2 IS NULL)) AND (folder_id=$3 OR (folder_id IS NULL AND $3 IS NULL)) AND status<>'deleted' AND ($4=false OR status='ready') AND name COLLATE utf8mb4_0900_as_ci LIKE $5 AND ($6 IS NULL OR created_at<$6 OR (created_at=$6 AND id<$7)) ORDER BY created_at DESC,id DESC LIMIT 101",
          ),
          [
            access.orgId,
            access.roomId,
            folderId,
            access.role === 'student',
            pattern,
            cursor?.created_at ?? null,
            cursor?.id ?? null,
          ],
        )
      ).rows as StoredFile[];
      const folders = (
        await pool.query(
          'SELECT id,name,parent_id AS "parentId" FROM file_folders WHERE organization_id=$1 AND (classroom_id=$2 OR (classroom_id IS NULL AND $2 IS NULL)) ORDER BY name,id LIMIT 1000',
          [access.orgId, access.roomId],
        )
      ).rows;
      return {
        enabled: !!config.storage,
        canUpload: access.role !== 'student' && !!config.storage && service.canScan(),
        files: rows.slice(0, 100).map(visibleFile),
        nextCursor: rows.length > 100 ? rows[99].id : null,
        folders,
        usage: await service.usage(access.orgId),
        maxUploadBytes: service.maxBytes,
        role: access.role,
      };
    });
    app.post<{
      Params: Params;
      Querystring: {
        folderId?: string;
        chatImage?: string;
        boardImage?: string;
        annotationImage?: string;
      };
    }>(
      prefix + '/files',
      {
        config: {
          rateLimit: {
            max: (req) => {
              const q = req.query as {
                boardImage?: string;
                annotationImage?: string;
                chatImage?: string;
              };
              return q.chatImage === '1'
                ? 30
                : q.boardImage === '1'
                  ? 120
                  : q.annotationImage === '1'
                    ? 60
                    : 10;
            },
            keyGenerator: async (req) => {
              const q = req.query as {
                boardImage?: string;
                annotationImage?: string;
                chatImage?: string;
              };
              return (
                'upload:' +
                (await user(req)).id +
                ':' +
                (q.chatImage === '1'
                  ? 'chat'
                  : q.boardImage === '1'
                    ? 'pdf'
                    : q.annotationImage === '1'
                      ? 'annotation'
                      : 'resource')
              );
            },
            timeWindow: '1 minute',
          },
        },
      },
      async (req, reply) => {
        const chatImage = z.literal('1').optional().parse(req.query.chatImage) !== undefined;
        const annotationImage =
          z.literal('1').optional().parse(req.query.annotationImage) !== undefined;
        const boardImage =
          z.literal('1').optional().parse(req.query.boardImage) !== undefined || annotationImage;
        if (chatImage && boardImage) fail(400, 'Choose one image purpose');
        if (boardImage && !isRoom) fail(400, 'Board images require a classroom');
        if (chatImage && !isRoom) fail(400, 'Chat images require a classroom');
        const access = await scope(req, req.params.id, isRoom, !chatImage && !annotationImage);
        const checkImagePermission = async (c: Pick<DatabasePool, 'query'> = pool) => {
          if (!chatImage && !boardImage) return;
          if (chatImage) await assertPublicChat(c, access.roomId!);
          const current = await classroomAuthorization(c, access.roomId!, access.userId);
          if (boardImage) {
            if (!annotationImage) await assertPlatformFeature(c, 'pdfImportEnabled');
            const permissions = resolveUserPermissions(
              current.room,
              current.role,
              current.room._userPerm,
            );
            if (
              !['owner', 'teacher'].includes(current.role) &&
              !(annotationImage && permissions.canWhiteboard)
            )
              fail(403, 'Forbidden');
            return;
          }
          if (
            !resolveUserPermissions(current.room, current.role, current.room._userPerm)
              .canChatImages
          )
            fail(403, 'Image messages are disabled by moderator');
        };
        await checkImagePermission();
        const storage = service.requireStorage();
        if (!service.canScan()) fail(503, 'A malware scanner must be configured before uploading');
        const size = z.coerce
          .number()
          .int()
          .min(1)
          .max(
            chatImage || boardImage
              ? Math.min(
                  service.maxBytes,
                  (chatImage ? (await readPlatformOptions(pool)).chatImageMaxMiB : 5) * 1024 * 1024,
                )
              : service.maxBytes,
          )
          .parse(req.headers['x-toaster-file-size']);
        const folderId = z.uuid().optional().parse(req.query.folderId) ?? null;
        if ((chatImage || boardImage) && folderId)
          fail(400, 'Chat images cannot use resource folders');
        const path = tempFile();
        let reserved: { id: string; key: string } | undefined,
          putStarted = false;
        try {
          let received = 0,
            mediaType = '',
            sha256 = '';
          for await (const part of req.parts({ limits: { fileSize: size } })) {
            if (part.type !== 'file' || reserved) fail(400, 'Upload exactly one file');
            const name = fileName.parse(part.filename);
            reserved = await service.reserve(
              access,
              name,
              size,
              folderId,
              chatImage ? 'chat' : boardImage ? 'board' : 'resource',
            );
            const hash = createHash('sha256');
            await pipeline(
              part.file,
              new Transform({
                transform(chunk: Buffer, _encoding, done) {
                  received += chunk.length;
                  if (received > size) {
                    done(new HttpError(413, 'Upload exceeds declared size'));
                    return;
                  }
                  hash.update(chunk);
                  done(null, chunk);
                },
              }),
              createWriteStream(path, { flags: 'wx', mode: 0o600 }),
              { signal: AbortSignal.timeout(60000) },
            );
            if (part.file.truncated) fail(413, 'Upload exceeds declared size');
            if (received !== size) fail(400, 'Uploaded size does not match the declaration');
            mediaType = await inspectFile(path, name);
            if (
              (chatImage || boardImage) &&
              !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mediaType)
            )
              fail(400, 'Choose a PNG, JPEG, WebP or GIF image');
            sha256 = hash.digest('hex');
          }
          if (!reserved) fail(400, 'Upload exactly one file');
          await checkImagePermission();
          putStarted = true;
          await storage.put(reserved.key, path, size, mediaType);
          await transaction(pool, async (c) => {
            await service.lock(c, access.orgId);
            await checkImagePermission(c);
            const current = (
              await c.query('SELECT status FROM files WHERE id=$1 FOR UPDATE', [reserved!.id])
            ).rows[0];
            if (current.status !== 'uploading') fail(409, 'Upload reservation expired');
            await c.query(
              "UPDATE files SET status='quarantined',media_type=$1,sha256=$2,updated_at=CURRENT_TIMESTAMP(3) WHERE id=$3",
              [mediaType, sha256, reserved!.id],
            );
            await audit(c, access.userId, access.orgId, 'file.uploaded', reserved!.id, {
              byteSize: size,
              mediaType,
            });
          });
          await service.scan(reserved.id);
          notify(access.roomId);
          return reply.code(201).send(visibleFile(await service.file(access, reserved.id)));
        } catch (error) {
          if (reserved) await service.abandon(reserved.id, access.orgId, putStarted);
          throw error;
        } finally {
          await unlink(path).catch((error) => {
            if (error.code !== 'ENOENT')
              app.log.error({ err: error }, 'Temporary upload cleanup failed');
          });
        }
      },
    );
    app.post<{ Params: Params }>(prefix + '/files/:file/copy', async (req, reply) => {
      const access = await scope(req, req.params.id, isRoom, true);
      const storage = service.requireStorage();
      if (!service.canScan()) fail(503, 'Malware scanner unavailable');
      const source = await service.resourceFile(access, req.params.file);
      if (source.status !== 'ready' || !source.sha256 || !source.media_type)
        fail(409, 'Only ready files can be copied');
      const data = z
        .object({ name: fileName.optional(), folderId: z.uuid().nullable().optional() })
        .parse(req.body);
      const size = Number(source.byte_size);
      if (size > service.maxBytes) fail(413, 'File exceeds the configured size limit');
      const reserved = await service.reserve(
        access,
        data.name ?? source.name,
        size,
        data.folderId === undefined ? source.folder_id : data.folderId,
      );
      const path = tempFile();
      let putStarted = false;
      try {
        let bytes = 0;
        const hash = createHash('sha256');
        await pipeline(
          await storage.get(source.object_key),
          new Transform({
            transform(chunk: Buffer, _encoding, done) {
              bytes += chunk.length;
              if (bytes > size) {
                done(new Error('Stored content size mismatch'));
                return;
              }
              hash.update(chunk);
              done(null, chunk);
            },
          }),
          createWriteStream(path, { flags: 'wx', mode: 0o600 }),
          { signal: AbortSignal.timeout(120000) },
        );
        if (bytes !== size || hash.digest('hex') !== source.sha256)
          fail(503, 'Stored content integrity check failed');
        putStarted = true;
        await storage.put(reserved.key, path, size, source.media_type);
        await transaction(pool, async (c) => {
          await service.lock(c, access.orgId);
          const current = (
            await c.query('SELECT status FROM files WHERE id=$1 FOR UPDATE', [reserved.id])
          ).rows[0];
          if (current.status !== 'uploading') fail(409, 'Copy reservation expired');
          await c.query(
            "UPDATE files SET status='quarantined',original_name=$1,media_type=$2,sha256=$3,source_file_id=$4,updated_at=CURRENT_TIMESTAMP(3) WHERE id=$5",
            [source.original_name, source.media_type, source.sha256, source.id, reserved.id],
          );
          await audit(c, access.userId, access.orgId, 'file.copied', reserved.id, {
            sourceFileId: source.id,
          });
        });
        await service.scan(reserved.id);
        notify(access.roomId);
        return reply.code(201).send(visibleFile(await service.file(access, reserved.id)));
      } catch (error) {
        await service.abandon(reserved.id, access.orgId, putStarted);
        throw error;
      } finally {
        await unlink(path).catch((error) => {
          if (error.code !== 'ENOENT')
            app.log.error({ err: error }, 'Temporary copy cleanup failed');
        });
      }
    });
    app.get<{ Params: Params }>(
      prefix + '/files/:file/status',
      { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
      async (req) => {
        const access = await scope(req, req.params.id, isRoom);
        const file = (
          await pool.query('SELECT * FROM files WHERE id=$1 AND organization_id=$2', [
            z.uuid().parse(req.params.file),
            access.orgId,
          ])
        ).rows[0] as StoredFile | undefined;
        if (
          !file ||
          file.classroom_id !== access.roomId ||
          (access.role === 'student' && file.uploaded_by !== access.userId)
        )
          fail(404, 'File not found');
        return { id: file.id, status: file.status, scanStatus: file.scan_status };
      },
    );
    app.get<{
      Params: Params;
      Querystring: { documentId?: string; raw?: string; encoding?: string };
    }>(
      prefix + '/files/:file/content',
      { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const access = await scope(req, req.params.id, isRoom);
        const documentId = z.uuid().optional().parse(req.query.documentId);
        const raw = z.literal('1').optional().parse(req.query.raw) === '1';
        const encoded = z.literal('base64').optional().parse(req.query.encoding) === 'base64';
        const file = await service.file(access, req.params.file, pool, documentId);
        if (access.roomId)
          await assertClassroomFileDownload(pool, access.roomId, access.userId, file, documentId);
        if (file.status !== 'ready') fail(409, 'File is not available for download');
        let range: { start: number; end: number } | undefined;
        const size = Number(file.byte_size);
        if (encoded && (file.media_type !== 'application/pdf' || size > 20 * 1024 * 1024))
          fail(413, 'Encoded PDF exceeds the limit');
        if (encoded && req.headers.range) fail(416, 'Encoded PDF transport requires the full file');
        if (req.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!match || (!match[1] && !match[2]))
            return reply
              .code(416)
              .header('Content-Range', 'bytes */' + size)
              .send();
          const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
          const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            start >= size ||
            end < start
          )
            return reply
              .code(416)
              .header('Content-Range', 'bytes */' + size)
              .send();
          range = { start, end };
        }
        let stream;
        try {
          stream = await service.requireStorage().get(file.object_key, range);
        } catch {
          fail(503, 'File storage unavailable');
        }
        reply
          .header('Content-Disposition', raw || encoded ? 'inline' : disposition(file.name))
          .header(
            'Content-Type',
            encoded
              ? 'text/plain; charset=us-ascii'
              : raw
                ? 'application/octet-stream'
                : (file.media_type ?? 'application/octet-stream'),
          )
          .header('Cache-Control', 'private, no-store')
          .header('Content-Security-Policy', "default-src 'none'; sandbox")
          .header('Accept-Ranges', 'bytes')
          .header(
            'Content-Length',
            encoded ? Math.ceil(size / 3) * 4 : range ? range.end - range.start + 1 : size,
          );
        if (range)
          reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
        let received = 0;
        const expected = range ? range.end - range.start + 1 : size;
        const bounded = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            received += chunk.length;
            if (received > expected) {
              done(new HttpError(503, 'Stored content exceeds its declared size'));
              return;
            }
            done(null, chunk);
          },
          flush(done) {
            done(
              received === expected
                ? undefined
                : new HttpError(503, 'Stored content is incomplete'),
            );
          },
        });
        if (encoded) {
          let tail = Buffer.alloc(0);
          const encoder = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              const value = tail.length ? Buffer.concat([tail, chunk]) : chunk,
                length = value.length - (value.length % 3);
              tail = Buffer.from(value.subarray(length));
              done(null, value.subarray(0, length).toString('base64'));
            },
            flush(done) {
              done(null, tail.length ? tail.toString('base64') : undefined);
            },
          });
          void pipeline(stream, bounded, encoder).catch(() => {});
          return reply.send(encoder);
        }
        void pipeline(stream, bounded).catch(() => {});
        return reply.send(bounded);
      },
    );
    app.post<{ Params: Params }>(prefix + '/files/:file/update', async (req) => {
      const access = await scope(req, req.params.id, isRoom, true);
      const data = z
        .object({ name: fileName.optional(), folderId: z.uuid().nullable().optional() })
        .refine((v) => v.name !== undefined || v.folderId !== undefined)
        .parse(req.body);
      await transaction(pool, async (c) => {
        await service.lock(c, access.orgId);
        const file = await service.resourceFile(access, req.params.file, c);
        if (['uploading', 'deleting'].includes(file.status))
          fail(409, 'File processing is in progress');
        const folderId = data.folderId === undefined ? file.folder_id : data.folderId;
        await service.folder(c, access, folderId);
        await c.query(
          'UPDATE files SET name=$1,folder_id=$2,updated_at=CURRENT_TIMESTAMP(3) WHERE id=$3',
          [data.name ?? file.name, folderId, file.id],
        );
        await audit(c, access.userId, access.orgId, 'file.updated', file.id);
      });
      notify(access.roomId);
      return { ok: true };
    });
    app.post<{ Params: Params }>(prefix + '/files/:file/delete', async (req) => {
      const access = await scope(req, req.params.id, isRoom, true);
      await transaction(pool, async (c) => {
        await service.lock(c, access.orgId);
        const file = await service.resourceFile(access, req.params.file, c);
        if (
          (
            await c.query(
              'SELECT id FROM collaborative_documents WHERE pdf_source_file_id=$1 LIMIT 1',
              [file.id],
            )
          ).rows.length
        )
          fail(409, 'File is used by a PDF document');
        if (
          (
            await c.query(
              "SELECT id FROM presentations WHERE source_file_id=$1 AND status IN ('queued','processing','scanning','ready') LIMIT 1",
              [file.id],
            )
          ).rowCount
        )
          fail(409, 'File is used by a presentation; delete the presentation first');
        if (file.status === 'uploading') fail(409, 'Upload is in progress');
        await c.query(
          "UPDATE files SET status=$1,delete_reason=COALESCE(delete_reason,'user'),cleanup_attempts=0,next_cleanup_at=CURRENT_TIMESTAMP(3),updated_at=CURRENT_TIMESTAMP(3) WHERE id=$2",
          [['failed', 'rejected'].includes(file.status) ? 'deleted' : 'deleting', file.id],
        );
        await audit(c, access.userId, access.orgId, 'file.delete_requested', file.id);
      });
      notify(access.roomId);
      return { ok: true };
    });
    app.post<{ Params: Params }>(prefix + '/files/:file/retry-scan', async (req) => {
      const access = await scope(req, req.params.id, isRoom, true);
      if (!service.canScan()) fail(503, 'Malware scanner unavailable');
      const id = z.uuid().parse(req.params.file);
      await transaction(pool, async (c) => {
        await service.lock(c, access.orgId);
        const file = await service.resourceFile(access, id, c);
        if (file.status !== 'quarantined') fail(409, 'File is not quarantined');
        if (file.scan_claimed_until && new Date(file.scan_claimed_until).getTime() > Date.now())
          fail(409, 'Scanning is in progress');
        await c.query(
          "UPDATE files SET scan_attempts=0,scan_status='pending',failure_code=NULL,next_scan_at=CURRENT_TIMESTAMP(3) WHERE id=$1",
          [id],
        );
        await audit(c, access.userId, access.orgId, 'file.scan_retried', id);
      });
      await service.scan(id);
      notify(access.roomId);
      return { ok: true };
    });
    app.post<{ Params: Params }>(prefix + '/file-folders', async (req, reply) => {
      const access = await scope(req, req.params.id, isRoom, true);
      const data = z
        .object({ name: fileName, parentId: z.uuid().nullable().default(null) })
        .parse(req.body);
      const id = randomUUID();
      await transaction(pool, async (c) => {
        await service.lock(c, access.orgId);
        await service.folder(c, access, data.parentId);
        await service.folderTree(c, access, id, data.parentId, true);
        await c.query(
          'INSERT INTO file_folders(id,organization_id,classroom_id,parent_id,name,created_by) VALUES($1,$2,$3,$4,$5,$6)',
          [id, access.orgId, access.roomId, data.parentId, data.name, access.userId],
        );
        await audit(c, access.userId, access.orgId, 'folder.created', id);
      });
      notify(access.roomId);
      return reply.code(201).send({ id });
    });
    app.post<{ Params: Params }>(prefix + '/file-folders/:folder/update', async (req) => {
      const access = await scope(req, req.params.id, isRoom, true);
      const id = z.uuid().parse(req.params.folder);
      const data = z
        .object({ name: fileName.optional(), parentId: z.uuid().nullable().optional() })
        .refine((v) => v.name !== undefined || v.parentId !== undefined)
        .parse(req.body);
      await transaction(pool, async (c) => {
        await service.lock(c, access.orgId);
        await service.folder(c, access, id);
        if (data.parentId !== undefined) {
          await service.folder(c, access, data.parentId);
          await service.folderTree(c, access, id, data.parentId);
          let current = data.parentId,
            depth = 0;
          while (current) {
            if (current === id) fail(409, 'Folder move would create a cycle');
            if (++depth > 32) fail(400, 'Folder nesting limit exceeded');
            current =
              (await c.query('SELECT parent_id FROM file_folders WHERE id=$1', [current])).rows[0]
                ?.parent_id ?? null;
          }
        }
        const folder = (await c.query('SELECT * FROM file_folders WHERE id=$1', [id])).rows[0];
        await c.query('UPDATE file_folders SET name=$1,parent_id=$2 WHERE id=$3', [
          data.name ?? folder.name,
          data.parentId === undefined ? folder.parent_id : data.parentId,
          id,
        ]);
        await audit(c, access.userId, access.orgId, 'folder.updated', id);
      });
      notify(access.roomId);
      return { ok: true };
    });
    app.post<{ Params: Params }>(prefix + '/file-folders/:folder/delete', async (req) => {
      const access = await scope(req, req.params.id, isRoom, true);
      const id = z.uuid().parse(req.params.folder);
      await transaction(pool, async (c) => {
        await service.lock(c, access.orgId);
        await service.folder(c, access, id);
        if (
          (await c.query("SELECT id FROM files WHERE folder_id=$1 AND status<>'deleted'", [id]))
            .rowCount ||
          (await c.query('SELECT id FROM file_folders WHERE parent_id=$1', [id])).rowCount
        )
          fail(409, 'Folder must be empty');
        await c.query('UPDATE files SET folder_id=NULL WHERE folder_id=$1', [id]);
        await c.query('DELETE FROM file_folders WHERE id=$1', [id]);
        await audit(c, access.userId, access.orgId, 'folder.deleted', id);
      });
      notify(access.roomId);
      return { ok: true };
    });
  }
  return service;
}
