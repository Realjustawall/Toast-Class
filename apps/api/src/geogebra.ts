import type { FastifyInstance } from 'fastify';
import type { TeachingContext } from './teaching.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import yauzl from 'yauzl';
import { transaction, audit } from './db.js';
import { fail } from './errors.js';
import { canEditWhiteboard } from './app.js';
import { sqlDialect } from './database.js';
import { hasClassroomAccess } from './classroom-access.js';
import { assertPlatformFeature } from './platform-options.js';
import { classroomAuthorization } from './classroom-access.js';

export const GEOGEBRA_MAX_BYTES = 5 * 1024 * 1024;
export const GEOGEBRA_MAX_BASE64 = Math.ceil(GEOGEBRA_MAX_BYTES / 3) * 4;
export async function validateGeoGebra(base64: string) {
  if (!base64 || base64.length > GEOGEBRA_MAX_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
    fail(400, 'Invalid GeoGebra file');
  const bytes = Buffer.from(base64, 'base64');
  if (
    bytes.length < 4 ||
    bytes.length > GEOGEBRA_MAX_BYTES ||
    bytes.toString('base64') !== base64 ||
    bytes.readUInt32LE(0) !== 0x04034b50
  )
    fail(400, 'Invalid GeoGebra file');
  try {
    await new Promise<void>((resolve, reject) =>
      yauzl.fromBuffer(
        bytes,
        { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
        (error, zip) => {
          if (error || !zip) {
            reject(new Error('Invalid archive'));
            return;
          }
          let count = 0,
            total = 0,
            construction = false,
            done = false;
          const names = new Set<string>();
          const finish = (error?: Error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            zip.close();
            error ? reject(error) : resolve();
          };
          const timer = setTimeout(() => finish(new Error('Archive deadline')), 5000);
          zip.on('error', (error) => finish(error));
          zip.on('entry', (entry: yauzl.Entry) => {
            total += entry.uncompressedSize;
            count++;
            if (
              count > 2048 ||
              total > 64 * 1024 * 1024 ||
              entry.uncompressedSize > 32 * 1024 * 1024 ||
              entry.fileName.length > 300 ||
              /(^|\/)\.\.?($|\/)|\\|^[A-Za-z]:/.test(entry.fileName) ||
              names.has(entry.fileName) ||
              entry.generalPurposeBitFlag & 1
            )
              return finish(new Error('Unsafe archive'));
            names.add(entry.fileName);
            if (entry.fileName !== 'geogebra.xml') {
              zip.readEntry();
              return;
            }
            if (entry.uncompressedSize > 4 * 1024 * 1024)
              return finish(new Error('Construction too large'));
            zip.openReadStream(entry, (error, stream) => {
              if (error || !stream) return finish(error ?? new Error('Invalid construction'));
              const chunks: Buffer[] = [];
              let size = 0;
              stream.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > 4 * 1024 * 1024) {
                  stream.destroy();
                  finish(new Error('Construction too large'));
                } else chunks.push(chunk);
              });
              stream.on('error', (error) => finish(error));
              stream.on('end', () => {
                if (done) return;
                const xml = Buffer.concat(chunks).toString('utf8');
                if (
                  /<!DOCTYPE|<!ENTITY/i.test(xml) ||
                  !/^\s*(?:<\?xml[^>]*\?>\s*)?<geogebra\b/.test(xml)
                )
                  return finish(new Error('Invalid construction'));
                construction = true;
                zip.readEntry();
              });
            });
          });
          zip.on('end', () => finish(construction ? undefined : new Error('Missing construction')));
          zip.readEntry();
        },
      ),
    );
  } catch {
    fail(400, 'Invalid GeoGebra file');
  }
}

export async function registerGeoGebra(app: FastifyInstance, ctx: TeachingContext) {
  const { pool, user, roomAccess, membership } = ctx,
    base = '/api/v1/classrooms/:id/geogebra';
  const notify = (id: string) =>
    (app as unknown as { notifyClassroom: (id: string, type?: string) => void }).notifyClassroom(
      id,
      'geogebra_changed',
    );
  const access = async (req: { cookies: Record<string, string | undefined> }, id: string) => {
    const u = await user(req),
      room = await roomAccess(id, u.id),
      role = await membership(room.organization_id, u.id);
    await assertPlatformFeature(pool, 'geoEnabled');
    return { u, room, role };
  };
  app.get<{ Params: { id: string } }>(base, async (req) => {
    const { room } = await access(req, req.params.id);
    return (
      await pool.query(
        'SELECT id,name,revision,updated_at FROM geogebra_documents WHERE classroom_id=$1 ORDER BY created_at,id',
        [room.id],
      )
    ).rows;
  });
  app.post<{ Params: { id: string } }>(base, async (req, reply) => {
    const { u, room } = await access(req, req.params.id);
    await membership(room.organization_id, u.id, true);
    const { name } = z
        .object({ name: z.string().trim().min(1).max(120) })
        .strict()
        .parse(req.body),
      id = randomUUID();
    await transaction(pool, async (c) => {
      await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [room.id]);
      const authorization = await classroomAuthorization(c, room.id, u.id);
      if (!['owner', 'teacher'].includes(authorization.role)) fail(403, 'Forbidden');
      await assertPlatformFeature(c, 'geoEnabled');
      const existing = (
        await c.query('SELECT id FROM geogebra_documents WHERE classroom_id=$1', [room.id])
      ).rows;
      if (existing.length >= 40) fail(409, 'GeoGebra worksheet limit reached');
      await c.query(
        "INSERT INTO geogebra_documents(id,classroom_id,name,state_base64,created_by,updated_by) VALUES($1,$2,$3,'',$4,$4)",
        [id, room.id, name, u.id],
      );
      await audit(c, u.id, room.organization_id, 'geogebra.created', id);
    });
    notify(room.id);
    return reply.code(201).send({ id });
  });
  app.get<{ Params: { id: string; doc: string } }>(base + '/:doc', async (req) => {
    const a = await access(req, req.params.id);
    const document = (
      await pool.query('SELECT * FROM geogebra_documents WHERE id=$1 AND classroom_id=$2', [
        z.uuid().parse(req.params.doc),
        a.room.id,
      ])
    ).rows[0];
    if (!document) fail(404, 'Not found');
    return { ...document, canEdit: canEditWhiteboard(a.room, a.role, true) };
  });
  app.post<{ Params: { id: string; doc: string } }>(
    base + '/:doc',
    { bodyLimit: GEOGEBRA_MAX_BASE64 + 2048 },
    async (req) => {
      const a = await access(req, req.params.id);
      if (!canEditWhiteboard(a.room, a.role, true)) fail(403, 'Board is read only');
      const data = z
          .object({
            revision: z.number().int().min(0),
            state: z.string().min(1).max(GEOGEBRA_MAX_BASE64),
          })
          .strict()
          .parse(req.body),
        id = z.uuid().parse(req.params.doc);
      // Check ownership before inspecting potentially expensive user archives.
      if (
        !(
          await pool.query('SELECT id FROM geogebra_documents WHERE id=$1 AND classroom_id=$2', [
            id,
            a.room.id,
          ])
        ).rows.length
      )
        fail(404, 'Not found');
      await validateGeoGebra(data.state);
      const revision = await transaction(pool, async (c) => {
        await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [a.room.id]);
        const authorization = await classroomAuthorization(c, a.room.id, a.u.id);
        if (!canEditWhiteboard(authorization.room, authorization.role, true))
          fail(403, 'Board is read only');
        await assertPlatformFeature(c, 'geoEnabled');
        const document = (
          await c.query(
            'SELECT revision,state_base64 FROM geogebra_documents WHERE id=$1 AND classroom_id=$2 FOR UPDATE',
            [id, a.room.id],
          )
        ).rows[0];
        if (!document) fail(404, 'Not found');
        const room = (await c.query('SELECT * FROM classrooms WHERE id=$1', [a.room.id])).rows[0];
        const member = (
          await c.query('SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2', [
            a.room.organization_id,
            a.u.id,
          ])
        ).rows[0];
        const override = (
          await c.query(
            'SELECT * FROM classroom_user_permissions WHERE classroom_id=$1 AND user_id=$2',
            [a.room.id, a.u.id],
          )
        ).rows[0];
        if (!room || !member || !(await hasClassroomAccess(c, a.room.id, a.u.id, member.role)))
          fail(403, 'Forbidden');
        if (member.role === 'student' && (room.locked || override?.kicked)) fail(403, 'Forbidden');
        if (!canEditWhiteboard({ ...room, _userPerm: override ?? null }, member.role, true))
          fail(403, 'Board is read only');
        // A retried acknowledged save is harmless and does not increment revision.
        if (document.state_base64 === data.state) return document.revision;
        if (document.revision !== data.revision) fail(409, 'GeoGebra worksheet changed');
        await c.query(
          sqlDialect(
            c,
            'UPDATE geogebra_documents SET state_base64=$1,revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$3',
            'UPDATE geogebra_documents SET state_base64=$1,revision=revision+1,updated_by=$2,updated_at=CURRENT_TIMESTAMP(3) WHERE id=$3',
          ),
          [data.state, a.u.id, id],
        );
        return document.revision + 1;
      });
      notify(a.room.id);
      return { revision };
    },
  );
}
