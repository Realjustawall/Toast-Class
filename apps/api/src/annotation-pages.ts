import type { FastifyInstance } from 'fastify';
import type { TeachingContext } from './teaching.js';
import { transaction, audit } from './db.js';
import { classroomAuthorization } from './classroom-access.js';
import { resolveUserPermissions } from './app.js';
import { fail } from './errors.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { saveBoardVersion } from './board-history.js';
import { assertPlatformFeature } from './platform-options.js';
import { validateBoard } from './board-schema.js';

export async function registerAnnotationPages(app: FastifyInstance, ctx: TeachingContext) {
  const base = '/api/v1/classrooms/:id/documents/:doc';
  const notify = (id: string, type: string) =>
    (app as unknown as { notifyClassroom: (id: string, type: string) => void }).notifyClassroom(
      id,
      type,
    );
  app.get<{ Params: { id: string } }>('/api/v1/classrooms/:id/annotation-stamps', async (req) => {
    const u = await ctx.user(req);
    await ctx.roomAccess(z.uuid().parse(req.params.id), u.id);
    return (
      await ctx.pool.query(
        'SELECT id,name,elements_json FROM annotation_stamps WHERE classroom_id=$1 AND user_id=$2 ORDER BY created_at,id',
        [req.params.id, u.id],
      )
    ).rows.map((row) => ({ id: row.id, name: row.name, elements: JSON.parse(row.elements_json) }));
  });
  app.post<{ Params: { id: string } }>('/api/v1/classrooms/:id/annotation-stamps', async (req) => {
    const u = await ctx.user(req),
      roomId = z.uuid().parse(req.params.id),
      data = z
        .object({
          name: z.string().trim().min(1).max(80),
          elements: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
        })
        .strict()
        .parse(req.body),
      id = randomUUID();
    await transaction(ctx.pool, async (c) => {
      await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [roomId]);
      const auth = await classroomAuthorization(c, roomId, u.id);
      if (!resolveUserPermissions(auth.room, auth.role, auth.room._userPerm).canWhiteboard)
        fail(403, 'Board is read only');
      const doc = new Y.Doc();
      try {
        const elements = doc.getMap('elements');
        for (const element of data.elements) {
          if (typeof element.id !== 'string' || elements.has(element.id))
            fail(400, 'Invalid annotation stamp');
          elements.set(element.id, element);
          if (
            element.type === 'image' &&
            !(
              await c.query(
                "SELECT id FROM files WHERE id=$1 AND classroom_id=$2 AND organization_id=$3 AND purpose='board' AND status='ready'",
                [element.fileId, roomId, auth.room.organization_id],
              )
            ).rows.length
          )
            fail(403, 'Annotation image is unavailable');
        }
        validateBoard(doc);
      } finally {
        doc.destroy();
      }
      if (
        Number(
          (
            await c.query(
              'SELECT COUNT(*) AS count FROM annotation_stamps WHERE classroom_id=$1 AND user_id=$2',
              [roomId, u.id],
            )
          ).rows[0].count,
        ) >= 20
      )
        fail(409, 'Stamp library limit reached');
      await c.query(
        'INSERT INTO annotation_stamps(id,classroom_id,user_id,name,elements_json) VALUES($1,$2,$3,$4,$5)',
        [id, roomId, u.id, data.name, JSON.stringify(data.elements)],
      );
      for (const fileId of new Set(
        data.elements
          .filter((element) => element.type === 'image')
          .map((element) => element.fileId),
      ))
        await c.query('INSERT INTO annotation_stamp_assets(stamp_id,file_id) VALUES($1,$2)', [
          id,
          fileId,
        ]);
    });
    return { id };
  });
  app.post<{ Params: { id: string; stamp: string } }>(
    '/api/v1/classrooms/:id/annotation-stamps/:stamp/delete',
    async (req) => {
      const u = await ctx.user(req);
      await ctx.roomAccess(z.uuid().parse(req.params.id), u.id);
      await ctx.pool.query(
        'DELETE FROM annotation_stamps WHERE id=$1 AND classroom_id=$2 AND user_id=$3',
        [z.uuid().parse(req.params.stamp), req.params.id, u.id],
      );
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string; doc: string } }>(base + '/page-action', async (req) => {
    const user = await ctx.user(req),
      id = z.uuid().parse(req.params.id),
      docId = z.uuid().parse(req.params.doc);
    const action = z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('rename'), name: z.string().trim().min(1).max(120) }).strict(),
        z.object({ kind: z.literal('bookmark'), label: z.string().trim().max(120) }).strict(),
        z.object({ kind: z.literal('archive'), archived: z.boolean() }).strict(),
        z.object({ kind: z.literal('duplicate') }).strict(),
        z.object({ kind: z.literal('rotate'), clockwise: z.boolean() }).strict(),
        z.object({ kind: z.literal('reorder'), ids: z.array(z.uuid()).min(1).max(100) }).strict(),
      ])
      .parse(req.body);
    const result = await transaction(ctx.pool, async (c) => {
      await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [id]);
      const auth = await classroomAuthorization(c, id, user.id),
        permissions = resolveUserPermissions(auth.room, auth.role, auth.room._userPerm);
      if (!permissions.isPresenter || !permissions.canWhiteboard)
        fail(403, 'Only the presenter can manage pages');
      const page = (
        await c.query(
          "SELECT * FROM collaborative_documents WHERE id=$1 AND classroom_id=$2 AND kind='board' AND board_format='excalidraw' FOR UPDATE",
          [docId, id],
        )
      ).rows[0];
      if (!page) fail(404, 'Page not found');
      const rootId = page.board_book_id ?? page.id;
      const pages = (
        await c.query(
          'SELECT * FROM collaborative_documents WHERE id=$1 OR board_book_id=$1 ORDER BY board_page_index,id FOR UPDATE',
          [rootId],
        )
      ).rows;
      let selectedId = page.id;
      if (action.kind === 'rename')
        await c.query('UPDATE collaborative_documents SET name=$1 WHERE id=$2', [
          action.name,
          page.id,
        ]);
      if (action.kind === 'bookmark')
        await c.query('UPDATE collaborative_documents SET page_bookmark=$1 WHERE id=$2', [
          action.label,
          page.id,
        ]);
      if (action.kind === 'reorder') {
        if (
          new Set(action.ids).size !== pages.length ||
          action.ids.length !== pages.length ||
          pages.some((row) => !action.ids.includes(row.id))
        )
          fail(400, 'Choose every page exactly once');
        await c.query(
          'UPDATE collaborative_documents SET board_page_index=board_page_index+1000000 WHERE id=$1 OR board_book_id=$1',
          [rootId],
        );
        for (const [index, key] of action.ids.entries())
          await c.query('UPDATE collaborative_documents SET board_page_index=$1 WHERE id=$2', [
            index + 1,
            key,
          ]);
      }
      if (action.kind === 'archive') {
        const remaining = pages.filter((row) => row.id !== page.id && !row.page_archived);
        if (action.archived && !remaining.length) fail(409, 'Keep at least one visible page');
        await c.query('UPDATE collaborative_documents SET page_archived=$1 WHERE id=$2', [
          action.archived,
          page.id,
        ]);
        if (action.archived) {
          selectedId = remaining[0].id;
          await c.query(
            'UPDATE classroom_workspace SET document_id=$1,revision=revision+1,updated_by=$2,updated_at=CURRENT_TIMESTAMP(3) WHERE classroom_id=$3 AND document_id=$4',
            [selectedId, user.id, id, page.id],
          );
        }
      }
      if (action.kind === 'duplicate') {
        if (pages.length >= 100) fail(409, 'Board page limit reached');
        selectedId = randomUUID();
        const index = Math.max(...pages.map((row) => Number(row.board_page_index))) + 1;
        await c.query(
          "INSERT INTO collaborative_documents(id,classroom_id,kind,name,teacher_only,created_by,board_format,board_book_id,board_page_index,background_file_id,background_width,background_height,page_rotation,pdf_source_file_id,pdf_source_page) VALUES($1,$2,'board',$3,$4,$5,'excalidraw',$6,$7,$8,$9,$10,$11,$12,$13)",
          [
            selectedId,
            id,
            (page.name + ' · 2').slice(0, 120),
            page.teacher_only,
            user.id,
            rootId,
            index,
            page.background_file_id,
            page.background_width,
            page.background_height,
            page.page_rotation,
            page.pdf_source_file_id,
            page.pdf_source_page,
          ],
        );
        const state = (
          await c.query('SELECT state_base64 FROM board_states WHERE document_id=$1', [page.id])
        ).rows[0];
        await c.query(
          'INSERT INTO board_states(document_id,generation,state_base64) VALUES($1,$2,$3)',
          [selectedId, randomUUID(), state?.state_base64 ?? ''],
        );
        for (const asset of (
          await c.query('SELECT file_id FROM board_assets WHERE document_id=$1', [page.id])
        ).rows)
          await c.query('INSERT INTO board_assets(document_id,file_id) VALUES($1,$2)', [
            selectedId,
            asset.file_id,
          ]);
      }
      if (action.kind === 'rotate') {
        const state = (
          await c.query('SELECT * FROM board_states WHERE document_id=$1 FOR UPDATE', [page.id])
        ).rows[0];
        if (!state) fail(409, 'Board state is unavailable');
        await saveBoardVersion(
          c,
          page.id,
          state,
          user.id,
          'Before page rotation',
          'before_restore',
        );
        const ydoc = new Y.Doc();
        try {
          if (state.state_base64) Y.applyUpdate(ydoc, Buffer.from(state.state_base64, 'base64'));
          const oldAngle = Number(page.page_rotation),
            quarter = action.clockwise ? 90 : 270;
          const w = Number(page.background_width ?? 1000),
            h = Number(page.background_height ?? 1400),
            width = oldAngle % 180 ? h : w,
            height = oldAngle % 180 ? w : h;
          const elements = ydoc.getMap<Record<string, unknown>>('elements');
          ydoc.transact(() => {
            for (const [key, value] of elements) {
              const ew = Number(value.width),
                eh = Number(value.height),
                cx = Number(value.x) + ew / 2,
                cy = Number(value.y) + eh / 2;
              const x = action.clockwise ? height - cy : cy,
                y = action.clockwise ? cx : width - cx;
              elements.set(key, {
                ...value,
                x: x - ew / 2,
                y: y - eh / 2,
                angle: (Number(value.angle) + (quarter * Math.PI) / 180) % (2 * Math.PI),
                version: Number(value.version) + 1,
                updated: Date.now(),
              });
            }
          });
          try {
            validateBoard(ydoc);
          } catch {
            fail(400, 'Rotated annotations exceed board limits');
          }
          await c.query(
            'UPDATE board_states SET generation=$1,revision=0,state_base64=$2,updated_at=CURRENT_TIMESTAMP(3) WHERE document_id=$3',
            [randomUUID(), Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64'), page.id],
          );
          await c.query('DELETE FROM board_receipts WHERE document_id=$1', [page.id]);
          await c.query('UPDATE collaborative_documents SET page_rotation=$1 WHERE id=$2', [
            (oldAngle + quarter) % 360,
            page.id,
          ]);
        } finally {
          ydoc.destroy();
        }
      }
      await audit(c, user.id, auth.room.organization_id, 'board.page_' + action.kind, page.id);
      return { id: selectedId, boardBookId: rootId };
    });
    notify(id, 'document_changed');
    notify(id, 'board_changed');
    notify(id, 'workspace_changed');
    return result;
  });
  app.post<{ Params: { id: string; doc: string } }>(base + '/pdf-source', async (req) => {
    const u = await ctx.user(req),
      id = z.uuid().parse(req.params.id),
      doc = z.uuid().parse(req.params.doc),
      data = z
        .object({ fileId: z.uuid(), page: z.number().int().min(1).max(100) })
        .strict()
        .parse(req.body);
    await transaction(ctx.pool, async (c) => {
      await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [id]);
      const auth = await classroomAuthorization(c, id, u.id),
        perms = resolveUserPermissions(auth.room, auth.role, auth.room._userPerm);
      if (!perms.isPresenter || !perms.canWhiteboard)
        fail(403, 'Only the presenter can manage pages');
      await assertPlatformFeature(c, 'pdfImportEnabled');
      const page = (
        await c.query(
          "SELECT * FROM collaborative_documents WHERE id=$1 AND classroom_id=$2 AND kind='board' FOR UPDATE",
          [doc, id],
        )
      ).rows[0];
      if (!page) fail(404, 'Page not found');
      const file = (
        await c.query(
          "SELECT id FROM files WHERE id=$1 AND classroom_id=$2 AND organization_id=$3 AND purpose='resource' AND media_type='application/pdf' AND status='ready' FOR UPDATE",
          [data.fileId, id, auth.room.organization_id],
        )
      ).rows[0];
      if (!file) fail(404, 'PDF source unavailable');
      if (
        page.pdf_source_file_id &&
        (page.pdf_source_file_id !== file.id || Number(page.pdf_source_page) !== data.page)
      )
        fail(409, 'PDF source is immutable');
      await c.query(
        'UPDATE collaborative_documents SET pdf_source_file_id=$1,pdf_source_page=$2 WHERE id=$3',
        [file.id, data.page, doc],
      );
    });
    notify(id, 'document_changed');
    return { ok: true };
  });
}
