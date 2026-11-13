import type { FastifyInstance } from 'fastify';
import type { TeachingContext } from './teaching.js';
import type { DatabasePool } from './database.js';
import { classroomAuthorization } from './classroom-access.js';
import { resolveUserPermissions } from './app.js';
import { transaction, audit } from './db.js';
import { fail } from './errors.js';
import { sqlDialect } from './database.js';
import { z } from 'zod';
import { assertPlatformFeature } from './platform-options.js';

export async function readClassroomWorkspace(c: Pick<DatabasePool, 'query'>, id: string) {
  const row = (await c.query('SELECT * FROM classroom_workspace WHERE classroom_id=$1', [id]))
    .rows[0];
  if (row)
    return {
      kind: row.kind,
      documentId: row.document_id,
      geogebraId: row.geogebra_id,
      sandboxId: row.sandbox_id ?? null,
      geoPerspective: row.geo_perspective,
      revision: Number(row.revision),
      updatedBy: row.updated_by,
    };
  const document = (
    await c.query(
      "SELECT id FROM collaborative_documents WHERE classroom_id=$1 AND kind='board' AND board_book_id IS NULL ORDER BY created_at,id LIMIT 1",
      [id],
    )
  ).rows[0];
  return {
    kind: 'document',
    documentId: document?.id ?? null,
    geogebraId: null,
    sandboxId: null,
    geoPerspective: '1',
    revision: 0,
    updatedBy: null,
  };
}
export async function registerClassroomWorkspace(
  app: FastifyInstance,
  ctx: TeachingContext,
  presentationsEnabled = false,
) {
  const base = '/api/v1/classrooms/:id/workspace';
  app.get<{ Params: { id: string } }>(base, async (req) => {
    const u = await ctx.user(req);
    await ctx.roomAccess(z.uuid().parse(req.params.id), u.id);
    return readClassroomWorkspace(ctx.pool, req.params.id);
  });
  app.post<{ Params: { id: string } }>(base, async (req) => {
    const u = await ctx.user(req),
      room = await ctx.roomAccess(z.uuid().parse(req.params.id), u.id);
    const data = z
      .object({
        kind: z.enum(['document', 'geogebra', 'presentation', 'sandbox']),
        documentId: z.uuid().nullable().optional(),
        geogebraId: z.uuid().nullable().optional(),
        sandboxId: z.uuid().nullable().optional(),
        geoPerspective: z.enum(['1', '2', '3', '4', '5', '6']).optional(),
        expectedRevision: z.number().int().min(0),
      })
      .strict()
      .parse(req.body);
    const result = await transaction(ctx.pool, async (c) => {
      await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [room.id]);
      const auth = await classroomAuthorization(c, room.id, u.id),
        effective = resolveUserPermissions(auth.room, auth.role, auth.room._userPerm);
      if (!['owner', 'teacher'].includes(auth.role) && !effective.isPresenter)
        fail(403, 'Only the presenter can change the shared workspace');
      const current = await readClassroomWorkspace(c, room.id);
      if (current.revision !== data.expectedRevision)
        fail(409, 'Shared workspace changed; refresh before switching');
      if (data.kind === 'document') {
        if (!data.documentId || data.geogebraId || data.sandboxId)
          fail(400, 'Choose a classroom document');
        if (
          !(
            await c.query(
              'SELECT id FROM collaborative_documents WHERE id=$1 AND classroom_id=$2 AND page_archived=false',
              [data.documentId, room.id],
            )
          ).rows.length
        )
          fail(404, 'Document not found');
      } else if (data.kind === 'geogebra') {
        await assertPlatformFeature(c, 'geoEnabled');
        if (data.documentId || data.sandboxId) fail(400, 'Invalid shared workspace');
        if (
          data.geogebraId &&
          !(
            await c.query('SELECT id FROM geogebra_documents WHERE id=$1 AND classroom_id=$2', [
              data.geogebraId,
              room.id,
            ])
          ).rows.length
        )
          fail(404, 'Worksheet not found');
      } else if (data.kind === 'sandbox') {
        if (data.documentId || data.geogebraId) fail(400, 'Invalid shared workspace');
        if (
          data.sandboxId &&
          !(
            await c.query('SELECT id FROM sandbox_boards WHERE id=$1 AND classroom_id=$2', [
              data.sandboxId,
              room.id,
            ])
          ).rows.length
        )
          fail(404, 'Sandbox board not found');
      } else {
        if (!presentationsEnabled) fail(403, 'Presentation conversion is unavailable');
        if (data.documentId || data.geogebraId || data.sandboxId)
          fail(400, 'Invalid shared workspace');
      }
      const next = {
        kind: data.kind,
        documentId: data.kind === 'document' ? data.documentId! : null,
        geogebraId: data.kind === 'geogebra' ? (data.geogebraId ?? null) : null,
        sandboxId: data.kind === 'sandbox' ? (data.sandboxId ?? null) : null,
        geoPerspective: data.geoPerspective ?? current.geoPerspective,
        revision: current.revision + 1,
        updatedBy: u.id,
      };
      await c.query(
        sqlDialect(
          c,
          'INSERT INTO classroom_workspace(classroom_id,kind,document_id,geogebra_id,sandbox_id,geo_perspective,revision,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(classroom_id) DO UPDATE SET kind=EXCLUDED.kind,document_id=EXCLUDED.document_id,geogebra_id=EXCLUDED.geogebra_id,sandbox_id=EXCLUDED.sandbox_id,geo_perspective=EXCLUDED.geo_perspective,revision=EXCLUDED.revision,updated_by=EXCLUDED.updated_by,updated_at=CURRENT_TIMESTAMP(3)',
          'INSERT INTO classroom_workspace(classroom_id,kind,document_id,geogebra_id,sandbox_id,geo_perspective,revision,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) AS incoming ON DUPLICATE KEY UPDATE kind=incoming.kind,document_id=incoming.document_id,geogebra_id=incoming.geogebra_id,sandbox_id=incoming.sandbox_id,geo_perspective=incoming.geo_perspective,revision=incoming.revision,updated_by=incoming.updated_by,updated_at=CURRENT_TIMESTAMP(3)',
        ),
        [
          room.id,
          next.kind,
          next.documentId,
          next.geogebraId,
          next.sandboxId,
          next.geoPerspective,
          next.revision,
          u.id,
        ],
      );
      await audit(c, u.id, room.organization_id, 'classroom.workspace_changed', room.id, next);
      return next;
    });
    (app as unknown as { notifyClassroom: (id: string, type: string) => void }).notifyClassroom(
      room.id,
      'workspace_changed',
    );
    return result;
  });
}
