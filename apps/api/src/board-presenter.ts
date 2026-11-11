import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { transaction, audit } from './db.js';
import { classroomAuthorization } from './classroom-access.js';
import { resolveUserPermissions } from './app.js';
import type { DatabasePool } from './database.js';
import { fail } from './errors.js';
import type { TeachingContext } from './teaching.js';

type Params = { id: string; doc: string };
type Access = {
  u: { id: string };
  room: { id: string; organization_id: string };
  role: string;
  document: { id: string };
};
const frame = z
  .object({
    generation: z.uuid(),
    revision: z.number().int().min(0).max(2147483646),
    operationId: z.uuid(),
    active: z.boolean(),
    viewport: z
      .object({
        centerX: z.number().finite().min(-1e7).max(1e7),
        centerY: z.number().finite().min(-1e7).max(1e7),
        zoom: z.number().finite().min(0.1).max(10),
      })
      .strict(),
  })
  .strict();

export async function registerBoardPresenter(
  app: FastifyInstance,
  ctx: TeachingContext,
  access: (req: { cookies: Record<string, string | undefined> }, params: Params) => Promise<Access>,
) {
  const allowed = async (c: Pick<DatabasePool, 'query'>, roomId: string, userId: string) => {
    const auth = await classroomAuthorization(c, roomId, userId);
    const permissions = resolveUserPermissions(auth.room, auth.role, auth.room._userPerm);
    return permissions.isPresenter && permissions.canWhiteboard;
  };
  const base = '/api/v1/classrooms/:id/documents/:doc/board/view';
  app.get<{ Params: Params }>(base, async (req) => {
    const a = await access(req, req.params);
    const state = (
      await ctx.pool.query('SELECT generation FROM board_states WHERE document_id=$1', [
        a.document.id,
      ])
    ).rows[0];
    if (!state) fail(409, 'Board state is unavailable');
    const saved = (
      await ctx.pool.query(
        'SELECT v.*,m.role AS presenter_role FROM board_presenter_views v LEFT JOIN memberships m ON m.user_id=v.actor_id AND m.organization_id=$2 WHERE v.document_id=$1',
        [a.document.id, a.room.organization_id],
      )
    ).rows[0];
    let actorAllowed = false;
    if (saved?.actor_id) {
      try {
        actorAllowed = await allowed(ctx.pool, a.room.id, saved.actor_id);
      } catch (error) {
        if (!(
          error &&
          typeof error === 'object' &&
          'statusCode' in error &&
          [403, 404].includes(Number(error.statusCode))
        ))
          throw error;
      }
    }
    // A restore invalidates the former presenter's coordinates without rewriting history.
    return {
      generation: state.generation,
      revision: saved?.revision ?? 0,
      active: !!saved?.active && saved.generation === state.generation && actorAllowed,
      actorId: saved?.actor_id ?? null,
      viewport: saved
        ? { centerX: saved.center_x, centerY: saved.center_y, zoom: saved.zoom }
        : null,
      canPresent: await allowed(ctx.pool, a.room.id, a.u.id),
    };
  });
  app.post<{ Params: Params }>(
    base,
    { config: { rateLimit: { max: 180, timeWindow: '1 minute' } } },
    async (req) => {
      const a = await access(req, req.params),
        data = frame.parse(req.body);
      const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex');
      const result = await transaction(ctx.pool, async (c) => {
        await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [a.room.id]);
        // Same document -> membership lock order as history/CRDT writes and restores.
        await c.query('SELECT id FROM collaborative_documents WHERE id=$1 FOR UPDATE', [
          a.document.id,
        ]);
        if (!(await allowed(c, a.room.id, a.u.id)))
          fail(403, 'Presentation access is disabled by moderator');
        const state = (
          await c.query('SELECT generation FROM board_states WHERE document_id=$1', [a.document.id])
        ).rows[0];
        if (state?.generation !== data.generation) fail(409, 'Board generation changed');
        const old = (
          await c.query('SELECT * FROM board_presenter_views WHERE document_id=$1', [a.document.id])
        ).rows[0];
        if (old?.operation_id === data.operationId) {
          if (old.digest !== digest || old.actor_id !== a.u.id)
            fail(409, 'Presenter operation ID was reused');
          return { revision: old.revision };
        }
        if ((old?.revision ?? 0) !== data.revision)
          fail(409, 'Presenter view changed; refresh before presenting');
        const revision = data.revision + 1;
        const values = [
          data.generation,
          revision,
          data.active,
          data.viewport.centerX,
          data.viewport.centerY,
          data.viewport.zoom,
          a.u.id,
          data.operationId,
          digest,
          a.document.id,
        ];
        if (old)
          await c.query(
            'UPDATE board_presenter_views SET generation=$1,revision=$2,active=$3,center_x=$4,center_y=$5,zoom=$6,actor_id=$7,operation_id=$8,digest=$9,updated_at=CURRENT_TIMESTAMP(3) WHERE document_id=$10',
            values,
          );
        else
          await c.query(
            'INSERT INTO board_presenter_views(generation,revision,active,center_x,center_y,zoom,actor_id,operation_id,digest,document_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            values,
          );
        // Audit control changes, not every pan/zoom packet.
        if (
          !old ||
          old.active !== data.active ||
          old.actor_id !== a.u.id ||
          old.generation !== data.generation
        )
          await audit(
            c,
            a.u.id,
            a.room.organization_id,
            data.active ? 'board.presentation_started' : 'board.presentation_stopped',
            a.document.id,
          );
        return { revision };
      });
      (app as unknown as { notifyBoardView: (id: string) => void }).notifyBoardView(a.document.id);
      return result;
    },
  );
}
