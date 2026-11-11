import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as Y from 'yjs';
import { transaction, audit } from './db.js';
import { fail } from './errors.js';
import { canEditWhiteboard } from './app.js';
import { classroomAuthorization } from './classroom-access.js';
import { validateBoard } from './board-schema.js';
import type { TeachingContext } from './teaching.js';
import { registerBoardPresence } from './board-presence.js';
import { registerBoardPresenter } from './board-presenter.js';
import {
  boardDigest,
  rebaseBoard,
  requireBoardManager,
  saveBoardVersion,
} from './board-history.js';

export async function registerBoards(app: FastifyInstance, ctx: TeachingContext) {
  const { pool, user, roomAccess, membership } = ctx;
  const base = '/api/v1/classrooms/:id/documents/:doc/board';
  type Params = { id: string; doc: string };
  const notify = (id: string) =>
    (app as unknown as { notifyClassroom: (id: string, type?: string) => void }).notifyClassroom(
      id,
      'board_changed',
    );
  async function access(req: { cookies: Record<string, string | undefined> }, params: Params) {
    const u = await user(req),
      room = await roomAccess(z.uuid().parse(params.id), u.id),
      role = await membership(room.organization_id, u.id);
    const document = (
      await pool.query('SELECT * FROM collaborative_documents WHERE id=$1 AND classroom_id=$2', [
        z.uuid().parse(params.doc),
        room.id,
      ])
    ).rows[0];
    if (!document || document.kind !== 'board' || document.board_format !== 'excalidraw')
      fail(404, 'Advanced board not found');
    return { u, room, role, document };
  }
  await registerBoardPresence(app, ctx, access);
  await registerBoardPresenter(app, ctx, access);
  app.get<{ Params: Params; Querystring: { since?: string } }>(
    base,
    { config: { rateLimit: { max: 900, timeWindow: '1 minute' } } },
    async (req) => {
      const a = await access(req, req.params),
        since = z.coerce.number().int().min(0).optional().parse(req.query.since);
      const state = (
        await pool.query('SELECT * FROM board_states WHERE document_id=$1', [a.document.id])
      ).rows[0];
      if (!state) fail(409, 'Board state is unavailable');
      const metadata = {
        generation: state.generation,
        revision: state.revision,
        canEdit: canEditWhiteboard(a.room, a.role, Boolean(a.document.teacher_only)),
        document: a.document,
      };
      if (since !== undefined && since <= state.revision) {
        const updates = (
          await pool.query(
            'SELECT revision,update_base64 FROM board_receipts WHERE document_id=$1 AND revision>$2 ORDER BY revision LIMIT 129',
            [a.document.id, since],
          )
        ).rows;
        if (updates.length === state.revision - since && updates.every((v) => v.update_base64))
          return {
            ...metadata,
            updates: updates.map((v) => ({ revision: v.revision, update: v.update_base64 })),
          };
      }
      return { ...metadata, state: state.state_base64 };
    },
  );
  app.post<{ Params: Params }>(
    base + '/updates',
    { bodyLimit: 768 * 1024, config: { rateLimit: { max: 360, timeWindow: '1 minute' } } },
    async (req) => {
      const a = await access(req, req.params);
      const data = z
        .object({
          id: z.uuid(),
          generation: z.uuid(),
          update: z
            .string()
            .min(4)
            .max(700000)
            .regex(/^[A-Za-z0-9+/]*={0,2}$/),
        })
        .strict()
        .parse(req.body);
      const bytes = Buffer.from(data.update, 'base64');
      if (bytes.length > 512 * 1024 || bytes.toString('base64') !== data.update)
        fail(400, 'Invalid board update encoding');
      const digest = createHash('sha256').update(bytes).digest('hex');
      const revision = await transaction(pool, async (c) => {
        const doc = (
          await c.query('SELECT * FROM collaborative_documents WHERE id=$1 FOR UPDATE', [
            a.document.id,
          ])
        ).rows[0];
        const fresh = await classroomAuthorization(c, a.room.id, a.u.id);
        if (!canEditWhiteboard(fresh.room, fresh.role, Boolean(doc.teacher_only)))
          fail(403, 'Board is read only');
        const state = (await c.query('SELECT * FROM board_states WHERE document_id=$1', [doc.id]))
          .rows[0];
        if (!state || state.generation !== data.generation)
          fail(409, 'Board generation changed; reload before editing');
        const old = (
          await c.query(
            'SELECT digest,revision FROM board_receipts WHERE document_id=$1 AND update_id=$2',
            [doc.id, data.id],
          )
        ).rows[0];
        if (old) {
          if (old.digest !== digest) fail(409, 'Update ID was already used for different content');
          return old.revision;
        }
        if (
          Number(
            (
              await c.query('SELECT COUNT(*) AS count FROM board_receipts WHERE document_id=$1', [
                doc.id,
              ])
            ).rows[0].count,
          ) >= 200000
        )
          fail(413, 'Board update limit reached');
        const ydoc = new Y.Doc();
        let snapshot: string;
        try {
          if (state.state_base64) Y.applyUpdate(ydoc, Buffer.from(state.state_base64, 'base64'));
          Y.applyUpdate(ydoc, bytes);
          if (ydoc.store.pendingStructs || ydoc.store.pendingDs)
            throw new Error('Missing causal dependencies');
          validateBoard(ydoc);
          for (const value of ydoc.getMap<Record<string, unknown>>('elements').values()) {
            if (value.type !== 'image') continue;
            const image = (
              await c.query(
                "SELECT id FROM files WHERE id=$1 AND organization_id=$2 AND classroom_id=$3 AND purpose='board' AND status='ready' AND media_type='image/png'",
                [value.fileId, a.room.organization_id, a.room.id],
              )
            ).rows[0];
            const inherited = (
              await c.query(
                'SELECT file_id FROM board_assets WHERE document_id=$1 AND file_id=$2',
                [doc.id, value.fileId],
              )
            ).rows[0];
            if (!image && !inherited) fail(403, 'Annotation image is unavailable');
            if (!inherited)
              await c.query('INSERT INTO board_assets(document_id,file_id) VALUES($1,$2)', [
                doc.id,
                value.fileId,
              ]);
          }
          snapshot = Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64');
        } catch {
          fail(400, 'Invalid collaborative board update');
        } finally {
          ydoc.destroy();
        }
        const next = state.revision + 1;
        if (next > 2147483647) fail(409, 'Board revision limit reached');
        await c.query(
          'UPDATE board_states SET state_base64=$1,revision=$2,updated_at=CURRENT_TIMESTAMP(3) WHERE document_id=$3',
          [snapshot!, next, doc.id],
        );
        await c.query(
          'INSERT INTO board_receipts(document_id,update_id,revision,digest,update_base64,author_id) VALUES($1,$2,$3,$4,$5,$6)',
          [doc.id, data.id, next, digest, data.update, a.u.id],
        );
        await c.query(
          'UPDATE board_receipts SET update_base64=NULL WHERE document_id=$1 AND revision<=$2',
          [doc.id, next - 128],
        );
        if (next % 25 === 0)
          await saveBoardVersion(
            c,
            doc.id,
            { ...state, revision: next, state_base64: snapshot! },
            a.u.id,
            '',
            'automatic',
          );
        return next;
      });
      notify(a.room.id);
      return { revision };
    },
  );
  app.post<{ Params: Params }>(base + '/access', async (req) => {
    const a = await access(req, req.params);
    await membership(a.room.organization_id, a.u.id, true);
    const data = z.object({ teacherOnly: z.boolean() }).strict().parse(req.body);
    await transaction(pool, async (c) => {
      await c.query('SELECT id FROM collaborative_documents WHERE id=$1 FOR UPDATE', [
        a.document.id,
      ]);
      const fresh = await classroomAuthorization(c, a.room.id, a.u.id);
      if (!['owner', 'teacher'].includes(fresh.role)) fail(403, 'Forbidden');
      await c.query('UPDATE collaborative_documents SET teacher_only=$1 WHERE id=$2', [
        data.teacherOnly,
        a.document.id,
      ]);
      await audit(c, a.u.id, a.room.organization_id, 'board.access_changed', a.document.id, {
        teacherOnly: data.teacherOnly,
      });
    });
    notify(a.room.id);
    return { ok: true };
  });
  app.get<{ Params: Params }>(base + '/versions', async (req) => {
    const a = await access(req, req.params);
    await membership(a.room.organization_id, a.u.id, true);
    return (
      await pool.query(
        'SELECT id,generation,revision,label,kind,digest,author_id,created_at FROM board_versions WHERE document_id=$1 ORDER BY created_at DESC,id DESC LIMIT 128',
        [a.document.id],
      )
    ).rows;
  });
  app.get<{ Params: Params & { version: string } }>(base + '/versions/:version', async (req) => {
    const a = await access(req, req.params);
    await membership(a.room.organization_id, a.u.id, true);
    const row = (
      await pool.query('SELECT * FROM board_versions WHERE id=$1 AND document_id=$2', [
        z.uuid().parse(req.params.version),
        a.document.id,
      ])
    ).rows[0];
    if (!row) fail(404, 'Board version not found');
    if (boardDigest(row.state_base64) !== row.digest)
      fail(409, 'Board version integrity check failed');
    return row;
  });
  const expected = z.object({
    expectedGeneration: z.uuid(),
    expectedRevision: z.number().int().min(0).max(2147483646),
  });
  app.post<{ Params: Params }>(base + '/versions', async (req) => {
    const a = await access(req, req.params),
      data = expected
        .extend({ id: z.uuid(), label: z.string().trim().min(1).max(120) })
        .strict()
        .parse(req.body);
    const version = await transaction(pool, async (c) => {
      await c.query('SELECT id FROM collaborative_documents WHERE id=$1 FOR UPDATE', [
        a.document.id,
      ]);
      await requireBoardManager(c, a.room.organization_id, a.u.id);
      const old = (
        await c.query(
          'SELECT id,generation,revision,label,kind,digest,author_id FROM board_versions WHERE id=$1 AND document_id=$2',
          [data.id, a.document.id],
        )
      ).rows[0];
      if (old) {
        if (
          old.kind !== 'manual' ||
          old.generation !== data.expectedGeneration ||
          old.revision !== data.expectedRevision ||
          old.label !== data.label ||
          old.author_id !== a.u.id
        )
          fail(409, 'Snapshot ID already used');
        return old;
      }
      const state = (
        await c.query('SELECT * FROM board_states WHERE document_id=$1', [a.document.id])
      ).rows[0];
      if (
        !state ||
        state.generation !== data.expectedGeneration ||
        state.revision !== data.expectedRevision
      )
        fail(409, 'Board changed; synchronize before saving a version');
      const saved = await saveBoardVersion(
        c,
        a.document.id,
        state,
        a.u.id,
        data.label,
        'manual',
        data.id,
      );
      await audit(c, a.u.id, a.room.organization_id, 'board.version_saved', a.document.id, {
        versionId: data.id,
        revision: state.revision,
      });
      return saved;
    });
    notify(a.room.id);
    return version;
  });
  app.post<{ Params: Params & { version: string } }>(
    base + '/versions/:version/restore',
    async (req) => {
      const a = await access(req, req.params),
        versionId = z.uuid().parse(req.params.version),
        data = expected.extend({ id: z.uuid() }).strict().parse(req.body);
      const digest = createHash('sha256')
        .update(JSON.stringify([versionId, data.expectedGeneration, data.expectedRevision]))
        .digest('hex');
      const result = await transaction(pool, async (c) => {
        await c.query('SELECT id FROM collaborative_documents WHERE id=$1 FOR UPDATE', [
          a.document.id,
        ]);
        await requireBoardManager(c, a.room.organization_id, a.u.id);
        const receipt = (
          await c.query(
            'SELECT * FROM board_restore_operations WHERE document_id=$1 AND operation_id=$2',
            [a.document.id, data.id],
          )
        ).rows[0];
        if (receipt) {
          if (receipt.digest !== digest || receipt.actor_id !== a.u.id)
            fail(409, 'Restore operation ID already used');
          return { generation: receipt.generation, revision: receipt.revision };
        }
        const state = (
          await c.query('SELECT * FROM board_states WHERE document_id=$1', [a.document.id])
        ).rows[0];
        if (
          !state ||
          state.generation !== data.expectedGeneration ||
          state.revision !== data.expectedRevision
        )
          fail(409, 'Board changed; synchronize before restoring');
        if (
          Number(
            (
              await c.query(
                'SELECT COUNT(*) AS count FROM board_restore_operations WHERE document_id=$1',
                [a.document.id],
              )
            ).rows[0].count,
          ) >= 1000
        )
          fail(413, 'Board restore limit reached');
        const source = (
          await c.query(
            'SELECT state_base64,digest FROM board_versions WHERE id=$1 AND document_id=$2',
            [versionId, a.document.id],
          )
        ).rows[0];
        if (!source) fail(404, 'Board version not found');
        const restored = rebaseBoard(source.state_base64, source.digest),
          generation = randomUUID(),
          revision = state.revision + 1;
        const backup = await saveBoardVersion(
          c,
          a.document.id,
          state,
          a.u.id,
          '',
          'before_restore',
        );
        await c.query(
          'UPDATE board_states SET state_base64=$1,generation=$2,revision=$3,updated_at=CURRENT_TIMESTAMP(3) WHERE document_id=$4',
          [restored, generation, revision, a.document.id],
        );
        // A NULL delta forces readers spanning the restore boundary to fetch a full snapshot.
        await c.query(
          'INSERT INTO board_receipts(document_id,update_id,revision,digest,update_base64,author_id) VALUES($1,$2,$3,$4,$5,$6)',
          [a.document.id, randomUUID(), revision, boardDigest(restored), null, a.u.id],
        );
        await c.query(
          'INSERT INTO board_restore_operations(document_id,operation_id,digest,generation,revision,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
          [a.document.id, data.id, digest, generation, revision, a.u.id],
        );
        await audit(c, a.u.id, a.room.organization_id, 'board.version_restored', a.document.id, {
          versionId,
          backupVersionId: backup!.id,
          generation,
          revision,
        });
        return { generation, revision };
      });
      notify(a.room.id);
      return result;
    },
  );
}
