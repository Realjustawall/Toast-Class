import type { FastifyInstance } from 'fastify';
import type { DatabasePool, DatabaseConnection } from './database.js';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { z } from 'zod';
import { audit, transaction } from './db.js';
import { fail } from './errors.js';
import { fileName } from './file-validation.js';
import { FileService, type FileConfig } from './files.js';
import type { TeachingContext } from './teaching.js';

export const CONVERSION_OUTPUT_LIMIT = 100 * 1024 * 1024;
export const presentationExtensions = new Set([
  'pdf',
  'doc',
  'docx',
  'ppt',
  'pptx',
  'txt',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
]);
export type PresentationJob = {
  id: string;
  organization_id: string;
  classroom_id: string;
  source_file_id: string;
  name: string;
  status: string;
  generation: string;
  claim: string | null;
  claimed_until: Date | null;
  reserved_bytes: string;
  page_count: number | null;
  attempts: number;
  failure_code: string | null;
  created_by: string;
  created_at: Date;
};
const dto = (p: PresentationJob) => ({
  id: p.id,
  name: p.name,
  status: p.status,
  pageCount: p.page_count,
  failureCode: p.failure_code,
  attempts: p.attempts,
  sourceFileId: p.source_file_id,
  createdAt: p.created_at,
});

export class PresentationService {
  readonly files: FileService;
  constructor(
    readonly pool: DatabasePool,
    readonly fileConfig: FileConfig,
  ) {
    this.files = new FileService(pool, fileConfig);
  }
  async job(id: string, c: Pick<DatabasePool, 'query'> = this.pool) {
    const job = (await c.query('SELECT * FROM presentations WHERE id=$1', [id])).rows[0] as
      PresentationJob | undefined;
    if (!job) fail(404, 'Presentation not found');
    return job;
  }
  async reserve(c: DatabaseConnection, org: string) {
    const usage = await this.files.usage(org, c);
    if (BigInt(usage.usedBytes) + BigInt(CONVERSION_OUTPUT_LIMIT) > BigInt(usage.quotaBytes))
      fail(409, 'Insufficient storage quota for document conversion');
  }
  async request(
    room: { id: string; organization_id: string },
    userId: string,
    fileId: string,
    name?: string,
  ) {
    this.files.requireStorage();
    const id = randomUUID(),
      generation = randomUUID();
    await transaction(this.pool, async (c) => {
      await this.files.lock(c, room.organization_id);
      const source = (
        await c.query('SELECT * FROM files WHERE id=$1 AND organization_id=$2', [
          fileId,
          room.organization_id,
        ])
      ).rows[0];
      if (
        !source ||
        (source.classroom_id && source.classroom_id !== room.id) ||
        source.purpose !== 'resource'
      )
        fail(404, 'Source file not found');
      if (source.status !== 'ready') fail(409, 'Source file is not available for conversion');
      if (!presentationExtensions.has(extname(source.original_name).slice(1).toLowerCase()))
        fail(400, 'Unsupported presentation source');
      if (
        (
          await c.query(
            "SELECT id FROM presentations WHERE classroom_id=$1 AND source_file_id=$2 AND status IN ('queued','processing','scanning')",
            [room.id, fileId],
          )
        ).rowCount
      )
        fail(409, 'This source is already being converted');
      await this.reserve(c, room.organization_id);
      await c.query(
        "INSERT INTO presentations(id,organization_id,classroom_id,source_file_id,name,status,generation,reserved_bytes,created_by) VALUES($1,$2,$3,$4,$5,'queued',$6,$7,$8)",
        [
          id,
          room.organization_id,
          room.id,
          fileId,
          name ?? source.name,
          generation,
          CONVERSION_OUTPUT_LIMIT,
          userId,
        ],
      );
      await audit(c, userId, room.organization_id, 'presentation.requested', id, {
        sourceFileId: fileId,
      });
    });
    return id;
  }
  async cleanup(
    c: DatabaseConnection,
    p: PresentationJob,
    status: 'failed' | 'deleting',
    code: string | null,
  ) {
    await c.query(
      'UPDATE presentations SET status=$1,failure_code=$2,claim=NULL,claimed_until=NULL,reserved_bytes=0,updated_at=CURRENT_TIMESTAMP(3) WHERE id=$3',
      [status, code, p.id],
    );
    const assets = (
      await c.query('SELECT file_id FROM presentation_assets WHERE presentation_id=$1', [p.id])
    ).rows;
    for (const a of assets)
      await c.query(
        "UPDATE files SET status='deleting',delete_reason='user',cleanup_attempts=0,next_cleanup_at=CURRENT_TIMESTAMP(3),updated_at=CURRENT_TIMESTAMP(3) WHERE id=$1 AND status IN ('uploading','quarantined','ready','deleting')",
        [a.file_id],
      );
    await c.query(
      'UPDATE session_presentations SET presentation_id=NULL,page_number=NULL,independent_view=false,revision=revision+1,updated_at=CURRENT_TIMESTAMP(3) WHERE presentation_id=$1',
      [p.id],
    );
  }
  async claimNext() {
    const candidates = (
      await this.pool.query(
        "SELECT id,organization_id FROM presentations WHERE status='queued' ORDER BY created_at,id LIMIT 10",
      )
    ).rows;
    for (const candidate of candidates) {
      const claimed = await transaction(this.pool, async (c) => {
        const organization = await c.query(
          'SELECT id FROM organizations WHERE id=$1 FOR UPDATE SKIP LOCKED',
          [candidate.organization_id],
        );
        if (!organization.rowCount) return null;
        const selected = (
          await c.query(
            "SELECT * FROM presentations WHERE id=$1 AND status='queued' FOR UPDATE SKIP LOCKED",
            [candidate.id],
          )
        ).rows[0] as PresentationJob | undefined;
        if (!selected) return null;
        const claim = randomUUID();
        await c.query(
          "UPDATE presentations SET status='processing',claim=$1,claimed_until=$2,attempts=attempts+1,updated_at=CURRENT_TIMESTAMP(3) WHERE id=$3",
          [claim, new Date(Date.now() + 180000), selected.id],
        );
        await audit(c, null, selected.organization_id, 'presentation.processing', selected.id);
        return this.job(selected.id, c);
      });
      if (claimed) return claimed;
    }
    return null;
  }
  async heartbeat(job: PresentationJob) {
    return !!(
      await this.pool.query(
        "UPDATE presentations SET claimed_until=$1 WHERE id=$2 AND claim=$3 AND generation=$4 AND status='processing' AND claimed_until>CURRENT_TIMESTAMP(3)",
        [new Date(Date.now() + 180000), job.id, job.claim, job.generation],
      )
    ).rowCount;
  }
  private async fenced(c: DatabaseConnection, job: PresentationJob) {
    await this.files.lock(c, job.organization_id);
    await c.query('SELECT id FROM presentations WHERE id=$1 FOR UPDATE', [job.id]);
    const current = await this.job(job.id, c);
    if (
      current.status !== 'processing' ||
      current.claim !== job.claim ||
      current.generation !== job.generation ||
      !current.claimed_until ||
      new Date(current.claimed_until).getTime() <= Date.now()
    )
      fail(409, 'Conversion lease is no longer owned');
    return current;
  }
  async stageAsset(
    job: PresentationJob,
    asset: { page: number; byteSize: number; sha256: string; width?: number; height?: number },
    put: (key: string) => Promise<void>,
  ) {
    const data = z
      .object({
        page: z.number().int().min(0).max(200),
        byteSize: z.number().int().positive().max(CONVERSION_OUTPUT_LIMIT),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        width: z.number().int().min(1).max(1600).optional(),
        height: z.number().int().min(1).max(1600).optional(),
      })
      .parse(asset);
    if (data.page > 0 && (!data.width || !data.height)) fail(400, 'Raster dimensions are required');
    if (data.page === 0 && (data.width || data.height))
      fail(400, 'PDF assets do not have raster dimensions');
    const id = randomUUID(),
      key = randomUUID();
    await transaction(this.pool, async (c) => {
      const current = await this.fenced(c, job);
      if (BigInt(data.byteSize) > BigInt(current.reserved_bytes))
        fail(409, 'Converted output exceeds its storage reservation');
      const name =
        data.page === 0 ? 'document.pdf' : 'page-' + String(data.page).padStart(4, '0') + '.png';
      await c.query(
        "INSERT INTO files(id,organization_id,classroom_id,name,original_name,object_key,byte_size,sha256,media_type,status,scan_status,purpose,uploaded_by,source_file_id) VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,'uploading','pending','presentation',$9,$10)",
        [
          id,
          job.organization_id,
          job.classroom_id,
          name,
          key,
          data.byteSize,
          data.sha256,
          data.page === 0 ? 'application/pdf' : 'image/png',
          job.created_by,
          job.source_file_id,
        ],
      );
      await c.query(
        'INSERT INTO presentation_assets(presentation_id,organization_id,generation,file_id,page_number,width,height) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          job.id,
          job.organization_id,
          job.generation,
          id,
          data.page,
          data.width ?? null,
          data.height ?? null,
        ],
      );
      await c.query(
        'UPDATE presentations SET reserved_bytes=reserved_bytes-$1,updated_at=CURRENT_TIMESTAMP(3) WHERE id=$2',
        [data.byteSize, job.id],
      );
    });
    try {
      await put(key);
      await transaction(this.pool, async (c) => {
        await this.fenced(c, job);
        const result = await c.query(
          "UPDATE files SET status='quarantined',updated_at=CURRENT_TIMESTAMP(3) WHERE id=$1 AND status='uploading'",
          [id],
        );
        if (!result.rowCount) fail(409, 'Converted output is no longer pending');
      });
      return id;
    } catch (error) {
      // Persist the exact key even when an upload's outcome was uncertain.
      // Re-enter deletion after a late fenced-out write, including a prior cleanup.
      await this.pool.query(
        "UPDATE files SET status='deleting',delete_reason='user',cleanup_attempts=0,next_cleanup_at=CURRENT_TIMESTAMP(3),updated_at=CURRENT_TIMESTAMP(3) WHERE id=$1",
        [id],
      );
      throw error;
    }
  }
  async complete(job: PresentationJob, pageCount: number) {
    z.number().int().min(1).max(200).parse(pageCount);
    await transaction(this.pool, async (c) => {
      await this.fenced(c, job);
      const assets = (
        await c.query(
          'SELECT a.page_number,f.status FROM presentation_assets a JOIN files f ON f.id=a.file_id WHERE a.presentation_id=$1 AND a.generation=$2 ORDER BY a.page_number',
          [job.id, job.generation],
        )
      ).rows;
      if (
        assets.length !== pageCount + 1 ||
        assets.some(
          (a, index) => a.page_number !== index || !['quarantined', 'ready'].includes(a.status),
        )
      )
        fail(409, 'Converted output set is incomplete');
      await c.query(
        "UPDATE presentations SET status='scanning',page_count=$1,claim=NULL,claimed_until=NULL,reserved_bytes=0,updated_at=CURRENT_TIMESTAMP(3) WHERE id=$2",
        [pageCount, job.id],
      );
    });
  }
  async failed(job: PresentationJob, code: string) {
    const allowed = new Set([
      'conversion_timeout',
      'converter_unavailable',
      'document_processing_failed',
      'document_conversion_failed',
      'invalid_input',
      'input_integrity_failed',
      'invalid_pdf_output',
      'invalid_page_output',
      'output_size_limit',
      'page_count_limit',
      'unsupported_document',
      'output_integrity_failed',
      'worker_lease_expired',
    ]);
    await transaction(this.pool, async (c) => {
      await this.files.lock(c, job.organization_id);
      await c.query('SELECT id FROM presentations WHERE id=$1 FOR UPDATE', [job.id]);
      const current = await this.job(job.id, c);
      if (
        current.status !== 'processing' ||
        current.claim !== job.claim ||
        current.generation !== job.generation
      )
        return;
      const failure = allowed.has(code) ? code : 'document_processing_failed';
      await this.cleanup(c, current, 'failed', failure);
      await audit(c, null, job.organization_id, 'presentation.failed', job.id, { code: failure });
    });
  }
  async maintenance() {
    const changed = new Set<string>();
    const candidates = (
      await this.pool.query(
        "SELECT id,organization_id FROM presentations WHERE status IN ('processing','scanning','deleting') ORDER BY created_at LIMIT 50",
      )
    ).rows;
    for (const row of candidates)
      await transaction(this.pool, async (c) => {
        await this.files.lock(c, row.organization_id);
        await c.query('SELECT id FROM presentations WHERE id=$1 FOR UPDATE', [row.id]);
        const p = await this.job(row.id, c);
        if (
          p.status === 'processing' &&
          p.claimed_until &&
          new Date(p.claimed_until).getTime() < Date.now()
        ) {
          await this.cleanup(c, p, 'failed', 'worker_lease_expired');
          changed.add(p.classroom_id);
          await audit(c, null, p.organization_id, 'presentation.failed', p.id, {
            code: 'worker_lease_expired',
          });
        } else if (p.status === 'scanning' || p.status === 'deleting') {
          const all = (
            await c.query(
              'SELECT f.status,f.failure_code,f.scan_status,f.scan_attempts,f.scan_claimed_until,a.generation FROM presentation_assets a JOIN files f ON f.id=a.file_id WHERE a.presentation_id=$1',
              [p.id],
            )
          ).rows;
          if (
            p.status === 'deleting' &&
            all.every((a) => ['deleted', 'rejected', 'failed'].includes(a.status))
          ) {
            await c.query(
              "UPDATE presentations SET status='deleted',updated_at=CURRENT_TIMESTAMP(3) WHERE id=$1",
              [p.id],
            );
            changed.add(p.classroom_id);
          } else if (p.status === 'scanning') {
            const current = all.filter((a) => a.generation === p.generation);
            if (
              current.some(
                (a) =>
                  ['rejected', 'failed', 'deleting', 'deleted'].includes(a.status) ||
                  (a.status === 'quarantined' &&
                    a.scan_attempts >= 5 &&
                    (!a.scan_claimed_until ||
                      new Date(a.scan_claimed_until).getTime() <= Date.now())),
              )
            ) {
              await this.cleanup(c, p, 'failed', 'output_scan_failed');
              changed.add(p.classroom_id);
              await audit(c, null, p.organization_id, 'presentation.failed', p.id, {
                code: 'output_scan_failed',
              });
            } else if (
              current.length === (p.page_count ?? 0) + 1 &&
              current.every((a) => a.status === 'ready')
            ) {
              await c.query(
                "UPDATE presentations SET status='ready',updated_at=CURRENT_TIMESTAMP(3) WHERE id=$1",
                [p.id],
              );
              changed.add(p.classroom_id);
              await audit(c, null, p.organization_id, 'presentation.ready', p.id, {
                pageCount: p.page_count,
              });
            }
          }
        }
      });
    return [...changed];
  }
}

export async function registerPresentations(
  app: FastifyInstance,
  ctx: TeachingContext,
  fileConfig: FileConfig,
  enabled: boolean,
  worker = true,
) {
  const { pool, user, roomAccess, membership } = ctx,
    service = new PresentationService(pool, fileConfig);
  const notify = (id: string, type = 'changed', payload?: Record<string, unknown>) =>
    (
      app as unknown as {
        notifyClassroom: (id: string, type?: string, payload?: Record<string, unknown>) => void;
      }
    ).notifyClassroom(id, type, payload);
  let timer: ReturnType<typeof setInterval> | undefined, work: Promise<unknown> | undefined;
  app.addHook('onReady', async () => {
    if (worker)
      timer = setInterval(() => {
        if (!work)
          work = service
            .maintenance()
            .then((ids) => ids.forEach((id) => notify(id)))
            .catch((e) => app.log.error({ err: e }, 'Presentation maintenance failed'))
            .finally(() => {
              work = undefined;
            });
      }, 5000);
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await work;
  });
  const base = '/api/v1/classrooms/:id/presentations';
  type Params = { id: string; presentation: string };
  async function access(
    req: { cookies: Record<string, string | undefined> },
    id: string,
    write = false,
  ) {
    const u = await user(req),
      room = await roomAccess(z.uuid().parse(id), u.id),
      role = await membership(room.organization_id, u.id, write);
    return { u, room, role };
  }
  async function scoped(id: string, room: string, c: Pick<DatabasePool, 'query'> = pool) {
    const p = await service.job(z.uuid().parse(id), c);
    if (p.classroom_id !== room || p.status === 'deleted') fail(404, 'Presentation not found');
    return p;
  }
  app.get<{ Params: Params }>(base, async (req) => {
    const a = await access(req, req.params.id);
    const rows = (
      await pool.query(
        "SELECT * FROM presentations WHERE classroom_id=$1 AND status<>'deleted' AND ($2=false OR status='ready') ORDER BY created_at DESC LIMIT 100",
        [a.room.id, a.role === 'student'],
      )
    ).rows;
    const current = (
      await pool.query(
        'SELECT s.id AS active_session_id,p.* FROM classroom_sessions s LEFT JOIN session_presentations p ON p.session_id=s.id WHERE s.active_key=$1',
        [a.room.id],
      )
    ).rows[0];
    return {
      enabled,
      canManage: a.role !== 'student',
      presentations: rows.map(dto),
      revision: current?.revision ?? 0,
      sessionId: current?.active_session_id ?? null,
      current: current?.presentation_id
        ? {
            presentationId: current.presentation_id,
            page: current.page_number,
            independentView: current.independent_view,
          }
        : null,
    };
  });
  app.post<{ Params: Params }>(base, async (req, reply) => {
    const a = await access(req, req.params.id, true);
    if (!enabled) fail(503, 'Document conversion is not configured');
    const data = z.object({ fileId: z.uuid(), name: fileName.optional() }).parse(req.body);
    const id = await service.request(a.room, a.u.id, data.fileId, data.name);
    notify(a.room.id);
    return reply.code(202).send(dto(await service.job(id)));
  });
  app.get<{ Params: Params }>(base + '/:presentation', async (req) => {
    const a = await access(req, req.params.id),
      p = await scoped(req.params.presentation, a.room.id);
    if (p.status !== 'ready' && a.role === 'student') fail(404, 'Presentation not found');
    const assets =
      p.status === 'ready'
        ? (
            await pool.query(
              'SELECT a.file_id,a.page_number,a.width,a.height FROM presentation_assets a WHERE a.presentation_id=$1 AND a.generation=$2 ORDER BY a.page_number',
              [p.id, p.generation],
            )
          ).rows
        : [];
    const source = (
      await pool.query(
        "SELECT id,classroom_id FROM files WHERE id=$1 AND organization_id=$2 AND status='ready'",
        [p.source_file_id, p.organization_id],
      )
    ).rows[0];
    return {
      ...dto(p),
      originalUrl: source
        ? '/api/v1/' +
          (source.classroom_id
            ? 'classrooms/' + source.classroom_id
            : 'organizations/' + p.organization_id) +
          '/files/' +
          source.id +
          '/content'
        : null,
      assets: assets.map((v) => ({
        fileId: v.file_id,
        page: v.page_number,
        width: v.width,
        height: v.height,
      })),
    };
  });
  app.post<{ Params: Params }>(base + '/:presentation/retry', async (req) => {
    const a = await access(req, req.params.id, true);
    if (!enabled) fail(503, 'Document conversion is not configured');
    await transaction(pool, async (c) => {
      await service.files.lock(c, a.room.organization_id);
      await c.query('SELECT id FROM presentations WHERE id=$1 FOR UPDATE', [
        z.uuid().parse(req.params.presentation),
      ]);
      const p = await scoped(req.params.presentation, a.room.id, c);
      if (p.status !== 'failed') fail(409, 'Only failed conversions can be retried');
      const remaining = (
        await c.query(
          "SELECT f.id FROM presentation_assets a JOIN files f ON f.id=a.file_id WHERE a.presentation_id=$1 AND f.status IN ('uploading','quarantined','ready','deleting')",
          [p.id],
        )
      ).rowCount;
      if (remaining) fail(409, 'Output cleanup must complete before retry');
      await service.reserve(c, a.room.organization_id);
      await c.query(
        "UPDATE presentations SET status='queued',generation=$1,attempts=0,failure_code=NULL,page_count=NULL,reserved_bytes=$2,updated_at=CURRENT_TIMESTAMP(3) WHERE id=$3",
        [randomUUID(), CONVERSION_OUTPUT_LIMIT, p.id],
      );
      await audit(c, a.u.id, a.room.organization_id, 'presentation.retried', p.id);
    });
    notify(a.room.id);
    return { ok: true };
  });
  app.post<{ Params: Params }>(base + '/:presentation/delete', async (req) => {
    const a = await access(req, req.params.id, true);
    await transaction(pool, async (c) => {
      await service.files.lock(c, a.room.organization_id);
      await c.query('SELECT id FROM presentations WHERE id=$1 FOR UPDATE', [
        z.uuid().parse(req.params.presentation),
      ]);
      const p = await scoped(req.params.presentation, a.room.id, c);
      if (p.status === 'processing')
        fail(409, 'Wait for document processing to finish before deletion');
      await service.cleanup(c, p, 'deleting', null);
      await audit(c, a.u.id, a.room.organization_id, 'presentation.deleted', p.id);
    });
    notify(a.room.id);
    return { ok: true };
  });
  app.post<{ Params: Params }>(base + '/control', async (req) => {
    const a = await access(req, req.params.id, true);
    const data = z
      .discriminatedUnion('action', [
        z.object({
          action: z.literal('show'),
          sessionId: z.uuid(),
          presentationId: z.uuid(),
          page: z.number().int().min(1).max(200),
          independentView: z.boolean(),
          expectedRevision: z.number().int().min(0),
        }),
        z.object({
          action: z.literal('hide'),
          sessionId: z.uuid(),
          expectedRevision: z.number().int().min(0),
        }),
      ])
      .parse(req.body);
    const nextRevision = await transaction(pool, async (c) => {
      // Lock organization then session in the same order as presentation deletion.
      await service.files.lock(c, a.room.organization_id);
      const session = (
        await c.query('SELECT * FROM classroom_sessions WHERE active_key=$1 FOR UPDATE', [
          a.room.id,
        ])
      ).rows[0];
      if (!session) fail(409, 'No active session');
      if (session.id !== data.sessionId)
        fail(409, 'Classroom session changed; refresh and try again');
      const previous = (
        await c.query('SELECT * FROM session_presentations WHERE session_id=$1', [session.id])
      ).rows[0];
      if ((previous?.revision ?? 0) !== data.expectedRevision)
        fail(409, 'Presentation changed; refresh and try again');
      if (data.action === 'hide') {
        if (previous)
          await c.query(
            'UPDATE session_presentations SET presentation_id=NULL,page_number=NULL,independent_view=false,revision=revision+1,changed_by=$1,updated_at=CURRENT_TIMESTAMP(3) WHERE session_id=$2',
            [a.u.id, session.id],
          );
        else
          await c.query(
            'INSERT INTO session_presentations(session_id,classroom_id,presentation_id,page_number,changed_by) VALUES($1,$2,NULL,NULL,$3)',
            [session.id, a.room.id, a.u.id],
          );
      } else {
        const p = await scoped(data.presentationId, a.room.id, c);
        if (p.status !== 'ready') fail(409, 'Presentation is not ready');
        if (data.page > (p.page_count ?? 0)) fail(400, 'Page does not exist');
        if (previous)
          await c.query(
            'UPDATE session_presentations SET presentation_id=$1,page_number=$2,independent_view=$3,revision=revision+1,changed_by=$4,updated_at=CURRENT_TIMESTAMP(3) WHERE session_id=$5',
            [p.id, data.page, data.independentView, a.u.id, session.id],
          );
        else
          await c.query(
            'INSERT INTO session_presentations(session_id,classroom_id,presentation_id,page_number,independent_view,changed_by) VALUES($1,$2,$3,$4,$5,$6)',
            [session.id, a.room.id, p.id, data.page, data.independentView, a.u.id],
          );
      }
      await audit(
        c,
        a.u.id,
        a.room.organization_id,
        'presentation.controlled',
        data.action === 'show' ? data.presentationId : a.room.id,
        { action: data.action },
      );
      return (previous?.revision ?? 0) + 1;
    });
    notify(a.room.id, 'presentation_changed', {
      revision: nextRevision,
      current:
        data.action === 'show'
          ? {
              presentationId: data.presentationId,
              page: data.page,
              independentView: data.independentView,
            }
          : null,
    });
    return { ok: true };
  });
}
