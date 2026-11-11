import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DatabasePool } from './database.js';
import type { TeachingContext } from './teaching.js';
import { classroomAuthorization } from './classroom-access.js';
import { resolveUserPermissions } from './app.js';
import { transaction, audit } from './db.js';
import { fail } from './errors.js';
type Query = Pick<DatabasePool, 'query'>;
export type DownloadKind = 'file' | 'board' | 'presentation';
const kindSchema = z.enum(['file', 'board', 'presentation']);
export async function downloadAuthority(c: Query, roomId: string, userId: string) {
  const auth = await classroomAuthorization(c, roomId, userId),
    p = resolveUserPermissions(auth.room, auth.role, auth.room._userPerm);
  return (
    ['owner', 'teacher'].includes(auth.role) || (p.isPresenter && !p.interactionLocked && !p.kicked)
  );
}
export async function downloadTarget(c: Query, roomId: string, kind: DownloadKind, id: string) {
  z.uuid().parse(id);
  const result =
    kind === 'file'
      ? await c.query(
          "SELECT id FROM files WHERE id=$1 AND classroom_id=$2 AND purpose='resource' AND status<>'deleted'",
          [id, roomId],
        )
      : kind === 'board'
        ? await c.query(
            "SELECT id,board_book_id FROM collaborative_documents WHERE id=$1 AND classroom_id=$2 AND kind='board'",
            [id, roomId],
          )
        : await c.query(
            "SELECT id FROM presentations WHERE id=$1 AND classroom_id=$2 AND status<>'deleted'",
            [id, roomId],
          );
  const row = result.rows[0];
  if (!row) fail(404, 'Download target not found');
  return kind === 'board' ? ((row.board_book_id ?? row.id) as string) : (row.id as string);
}
export async function readDownloadPolicy(c: Query, roomId: string, kind: DownloadKind, id: string) {
  const row = (
    await c.query(
      'SELECT enabled,revision FROM classroom_download_policies WHERE classroom_id=$1 AND target_kind=$2 AND target_id=$3',
      [roomId, kind, id],
    )
  ).rows[0];
  return { enabled: row ? !!row.enabled : true, revision: Number(row?.revision ?? 0) };
}
export async function assertBoardDownload(
  c: Query,
  roomId: string,
  userId: string,
  documentId: string,
) {
  const manager = await downloadAuthority(c, roomId, userId),
    root = await downloadTarget(c, roomId, 'board', documentId),
    policy = await readDownloadPolicy(c, roomId, 'board', root);
  if (!manager && !policy.enabled) fail(403, 'Downloads are disabled by the presenter');
  return { targetId: root, ...policy, canManage: manager };
}
/** Rendering assets stay readable. Original files and PDFs always pass fresh
 * policy checks, including raw/base64/range/HEAD transport variants. */
export async function assertClassroomFileDownload(
  c: Query,
  roomId: string,
  userId: string,
  file: { id: string; purpose: string; media_type: string | null },
  documentId?: string,
) {
  // Scope has already authorized classroom viewing. Derived rendering assets
  // and chat thumbnails do not need additional download-policy database reads.
  if (file.purpose !== 'resource' && file.media_type !== 'application/pdf') return;
  if (await downloadAuthority(c, roomId, userId)) return;
  const requireEnabled = async (kind: DownloadKind, id: string) => {
    if (!(await readDownloadPolicy(c, roomId, kind, id)).enabled)
      fail(403, 'Downloads are disabled by the presenter');
  };
  if (file.purpose === 'resource') await requireEnabled('file', file.id);
  if (file.media_type !== 'application/pdf' && file.purpose !== 'resource') return;
  const sources = (
    await c.query(
      'SELECT id,board_book_id FROM collaborative_documents WHERE classroom_id=$1 AND pdf_source_file_id=$2',
      [roomId, file.id],
    )
  ).rows;
  const selected =
    documentId && sources.some((d) => d.id === documentId)
      ? sources.filter((d) => d.id === documentId)
      : sources;
  for (const d of selected) await requireEnabled('board', d.board_book_id ?? d.id);
  const presentations = (
    await c.query(
      "SELECT DISTINCT p.id,p.source_file_id FROM presentations p LEFT JOIN presentation_assets a ON a.presentation_id=p.id WHERE p.classroom_id=$1 AND p.status<>'deleted' AND (p.source_file_id=$2 OR (a.file_id=$2 AND a.page_number=0))",
      [roomId, file.id],
    )
  ).rows;
  for (const p of presentations) {
    await requireEnabled('presentation', p.id);
    await requireEnabled('file', p.source_file_id);
  }
}
export async function registerClassroomDownloads(app: FastifyInstance, ctx: TeachingContext) {
  const base = '/api/v1/classrooms/:id/downloads';
  app.get<{ Params: { id: string } }>(
    base,
    { config: { rateLimit: { max: 360, timeWindow: '1 minute' } } },
    async (req) => {
      const u = await ctx.user(req),
        id = z.uuid().parse(req.params.id),
        canManage = await downloadAuthority(ctx.pool, id, u.id);
      const items = (
        await ctx.pool.query(
          'SELECT target_kind,target_id,enabled,revision FROM classroom_download_policies WHERE classroom_id=$1',
          [id],
        )
      ).rows.map((r) => ({
        kind: r.target_kind,
        targetId: r.target_id,
        enabled: !!r.enabled,
        revision: Number(r.revision),
      }));
      return { canManage, defaultEnabled: true, items };
    },
  );
  app.post<{ Params: { id: string } }>(
    base,
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const u = await ctx.user(req),
        id = z.uuid().parse(req.params.id),
        data = z
          .object({
            kind: kindSchema,
            targetId: z.uuid(),
            enabled: z.boolean(),
            expectedRevision: z.number().int().min(0),
          })
          .strict()
          .parse(req.body);
      const result = await transaction(ctx.pool, async (c) => {
        await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [id]);
        if (!(await downloadAuthority(c, id, u.id)))
          fail(403, 'Only the presenter can change download access');
        const targetId = await downloadTarget(c, id, data.kind, data.targetId),
          current = await readDownloadPolicy(c, id, data.kind, targetId);
        if (current.revision !== data.expectedRevision)
          fail(409, 'Download permissions changed; refresh before saving');
        const revision = current.revision + 1;
        if (current.revision)
          await c.query(
            'UPDATE classroom_download_policies SET enabled=$1,revision=$2,updated_by=$3,updated_at=CURRENT_TIMESTAMP(3) WHERE classroom_id=$4 AND target_kind=$5 AND target_id=$6',
            [data.enabled, revision, u.id, id, data.kind, targetId],
          );
        else
          await c.query(
            'INSERT INTO classroom_download_policies(classroom_id,target_kind,target_id,enabled,revision,updated_by) VALUES($1,$2,$3,$4,$5,$6)',
            [id, data.kind, targetId, data.enabled, revision, u.id],
          );
        const auth = await classroomAuthorization(c, id, u.id);
        await audit(
          c,
          u.id,
          auth.room.organization_id,
          'classroom.download_access_changed',
          targetId,
          { kind: data.kind, enabled: data.enabled, revision },
        );
        return { kind: data.kind, targetId, enabled: data.enabled, revision };
      });
      (app as unknown as { notifyClassroom: (id: string, type: string) => void }).notifyClassroom(
        id,
        'downloads_changed',
      );
      return result;
    },
  );
  app.post<{ Params: { id: string } }>(
    base + '/authorize',
    { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } },
    async (req) => {
      const u = await ctx.user(req),
        id = z.uuid().parse(req.params.id),
        data = z
          .object({ targetId: z.uuid(), format: z.enum(['pdf', 'png', 'svg']) })
          .strict()
          .parse(req.body);
      const result = await assertBoardDownload(ctx.pool, id, u.id, data.targetId);
      return { ...result, format: data.format };
    },
  );
}
