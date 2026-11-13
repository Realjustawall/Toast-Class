import type { FastifyInstance } from 'fastify';
import type { TeachingContext } from './teaching.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import yauzl from 'yauzl';
import { transaction, audit } from './db.js';
import { fail } from './errors.js';
import { classroomAuthorization } from './classroom-access.js';
import { resolveUserPermissions } from './app.js';

export const SANDBOX_MAX_BYTES = 5 * 1024 * 1024;
export const SANDBOX_MAX_BASE64 = Math.ceil(SANDBOX_MAX_BYTES / 3) * 4 + 32;
const MAX_FILES = 50;
const MAX_UNCOMPRESSED = 10 * 1024 * 1024;
const MAX_TEXT_FILE = 2 * 1024 * 1024;

export type SandboxBundleFile = {
  kind: 'text' | 'data';
  mime: string;
  content: string;
};

export type SandboxBundle = {
  entry: string;
  files: Record<string, SandboxBundleFile>;
};

const ALLOWED_TYPES: Record<string, { kind: 'text' | 'data'; mime: string }> = {
  '.html': { kind: 'text', mime: 'text/html' },
  '.htm': { kind: 'text', mime: 'text/html' },
  '.css': { kind: 'text', mime: 'text/css' },
  '.js': { kind: 'text', mime: 'text/javascript' },
  '.mjs': { kind: 'text', mime: 'text/javascript' },
  '.json': { kind: 'text', mime: 'application/json' },
  '.txt': { kind: 'text', mime: 'text/plain' },
  '.svg': { kind: 'data', mime: 'image/svg+xml' },
  '.png': { kind: 'data', mime: 'image/png' },
  '.jpg': { kind: 'data', mime: 'image/jpeg' },
  '.jpeg': { kind: 'data', mime: 'image/jpeg' },
  '.gif': { kind: 'data', mime: 'image/gif' },
  '.webp': { kind: 'data', mime: 'image/webp' },
  '.woff2': { kind: 'data', mime: 'font/woff2' },
};

function fileExtension(fileName: string) {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
}

function normalizeZipPath(raw: string): string | null {
  if (!raw || raw.includes('\\') || raw.includes('\0')) return null;
  const cleaned = raw.replace(/^\.\//, '');
  if (!cleaned || cleaned.startsWith('/') || cleaned.endsWith('/')) return null;
  const parts = cleaned.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

function stripCommonRoot(files: Record<string, SandboxBundleFile>) {
  const keys = Object.keys(files);
  if (!keys.length) return files;
  const firstSlash = keys[0]!.indexOf('/');
  if (firstSlash <= 0) return files;
  const prefix = keys[0]!.slice(0, firstSlash + 1);
  if (!keys.every((key) => key.startsWith(prefix))) return files;
  const stripped: Record<string, SandboxBundleFile> = {};
  for (const [key, value] of Object.entries(files)) {
    stripped[key.slice(prefix.length)] = value;
  }
  return stripped;
}

function pickEntryFile(files: Record<string, SandboxBundleFile>): string {
  const keys = Object.keys(files);
  const exact =
    keys.find((k) => k.toLowerCase() === 'index.html') ??
    keys.find((k) => k.toLowerCase() === 'index.htm');
  if (exact) return exact;
  const rootHtml = keys.find((k) => !k.includes('/') && /\.(html?)$/i.test(k));
  if (rootHtml) return rootHtml;
  const anyHtml = keys.find((k) => /\.(html?)$/i.test(k));
  if (!anyHtml) fail(400, 'ZIP archive must contain an HTML entry file');
  return anyHtml;
}

export async function parseSandboxUpload(
  fileName: string,
  contentBase64: string,
): Promise<SandboxBundle> {
  const normalizedBase64 = contentBase64.replace(/\s+/g, '');
  if (
    !normalizedBase64 ||
    normalizedBase64.length > SANDBOX_MAX_BASE64 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedBase64)
  ) {
    fail(400, 'Invalid sandbox upload payload');
  }
  const bytes = Buffer.from(normalizedBase64, 'base64');
  if (!bytes.length || bytes.length > SANDBOX_MAX_BYTES) {
    fail(400, 'Sandbox file exceeds 5 MB limit');
  }

  const ext = fileExtension(fileName.trim());
  if (ext === '.html' || ext === '.htm') {
    if (bytes.length > MAX_TEXT_FILE) fail(400, 'HTML file exceeds 2 MB limit');
    return {
      entry: 'index.html',
      files: {
        'index.html': {
          kind: 'text',
          mime: 'text/html',
          content: bytes.toString('utf8'),
        },
      },
    };
  }

  if (ext !== '.zip' || bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) {
    fail(400, 'Upload an .html or .zip file');
  }

  const rawFiles = await new Promise<Record<string, SandboxBundleFile>>((resolve, reject) =>
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new Error('Invalid ZIP archive'));
          return;
        }
        const collected: Record<string, SandboxBundleFile> = {};
        let count = 0;
        let total = 0;
        let done = false;
        const finish = (err?: Error) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try {
            zip.close();
          } catch {}
          if (err) reject(err);
          else resolve(collected);
        };
        const timer = setTimeout(() => finish(new Error('Invalid ZIP archive')), 5000);
        zip.on('error', () => finish(new Error('Invalid ZIP archive')));
        zip.on('end', () => finish());
        zip.on('entry', (entry) => {
          if (done) return;
          if (entry.fileName.endsWith('/')) {
            zip.readEntry();
            return;
          }
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (mode === 0o120000) {
            finish(new Error('Symbolic links are not allowed in ZIP archive'));
            return;
          }
          const safePath = normalizeZipPath(entry.fileName);
          if (!safePath || collected[safePath]) {
            finish(new Error('Invalid file path in ZIP archive'));
            return;
          }
          const entryExt = fileExtension(safePath);
          const spec = ALLOWED_TYPES[entryExt];
          if (!spec) {
            finish(new Error('Unsupported file type in ZIP archive: ' + (entryExt || safePath)));
            return;
          }
          count++;
          total += entry.uncompressedSize;
          if (count > MAX_FILES || total > MAX_UNCOMPRESSED) {
            finish(new Error('ZIP archive exceeds file or size limits'));
            return;
          }
          if (spec.kind === 'text' && entry.uncompressedSize > MAX_TEXT_FILE) {
            finish(new Error('Text file in ZIP exceeds 2 MB limit'));
            return;
          }
          zip.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) {
              finish(new Error('Invalid ZIP archive'));
              return;
            }
            const chunks: Buffer[] = [];
            let readBytes = 0;
            stream.on('data', (chunk: Buffer) => {
              readBytes += chunk.length;
              if (readBytes > entry.uncompressedSize + 64 || readBytes > MAX_UNCOMPRESSED) {
                stream.destroy();
                finish(new Error('Invalid ZIP archive'));
                return;
              }
              chunks.push(chunk);
            });
            stream.on('error', () => finish(new Error('Invalid ZIP archive')));
            stream.on('end', () => {
              const fileBuf = Buffer.concat(chunks);
              collected[safePath] = {
                kind: spec.kind,
                mime: spec.mime,
                content:
                  spec.kind === 'text'
                    ? fileBuf.toString('utf8')
                    : `data:${spec.mime};base64,${fileBuf.toString('base64')}`,
              };
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    ),
  ).catch((err) => {
    fail(400, err instanceof Error ? err.message : 'Invalid ZIP archive');
  });

  const files = stripCommonRoot(rawFiles);
  const entry = pickEntryFile(files);
  return { entry, files };
}

export async function registerSandbox(app: FastifyInstance, ctx: TeachingContext) {
  const { pool, user, roomAccess, membership } = ctx;
  const base = '/api/v1/classrooms/:id/sandbox';
  const notify = (id: string) =>
    (app as unknown as { notifyClassroom: (id: string, type?: string) => void }).notifyClassroom(
      id,
      'sandbox_changed',
    );

  const access = async (req: { cookies: Record<string, string | undefined> }, id: string) => {
    const u = await user(req);
    const room = await roomAccess(id, u.id);
    const role = await membership(room.organization_id, u.id);
    return { u, room, role };
  };

  app.get<{ Params: { id: string } }>(base, async (req) => {
    const { room } = await access(req, req.params.id);
    return (
      await pool.query(
        'SELECT id,name,revision,updated_at FROM sandbox_boards WHERE classroom_id=$1 ORDER BY created_at,id',
        [room.id],
      )
    ).rows;
  });

  app.post<{ Params: { id: string } }>(
    base,
    { bodyLimit: SANDBOX_MAX_BASE64 + 4096 },
    async (req, reply) => {
      const { u, room } = await access(req, req.params.id);
      const data = z
        .object({
          name: z.string().trim().min(1).max(120),
          fileName: z.string().trim().min(1).max(200),
          contentBase64: z.string().min(1).max(SANDBOX_MAX_BASE64),
        })
        .strict()
        .parse(req.body);
      const bundle = await parseSandboxUpload(data.fileName, data.contentBase64);
      const bundleJson = JSON.stringify(bundle);
      const id = randomUUID();
      await transaction(pool, async (c) => {
        await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [room.id]);
        const auth = await classroomAuthorization(c, room.id, u.id);
        const effective = resolveUserPermissions(auth.room, auth.role, auth.room._userPerm);
        if (!['owner', 'teacher'].includes(auth.role) && !effective.isPresenter) {
          fail(403, 'Forbidden');
        }
        const existing = (
          await c.query('SELECT id FROM sandbox_boards WHERE classroom_id=$1', [room.id])
        ).rows;
        if (existing.length >= 40) fail(409, 'Sandbox board limit reached');
        await c.query(
          'INSERT INTO sandbox_boards(id,classroom_id,name,bundle_json,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5)',
          [id, room.id, data.name, bundleJson, u.id],
        );
        await audit(c, u.id, room.organization_id, 'sandbox.created', id);
      });
      notify(room.id);
      return reply.code(201).send({ id, name: data.name, revision: 0 });
    },
  );

  app.get<{ Params: { id: string; board: string } }>(base + '/:board', async (req) => {
    const { room, u } = await access(req, req.params.id);
    const row = (
      await pool.query(
        'SELECT id,classroom_id,name,bundle_json,revision,updated_at FROM sandbox_boards WHERE id=$1 AND classroom_id=$2',
        [z.uuid().parse(req.params.board), room.id],
      )
    ).rows[0];
    if (!row) fail(404, 'Not found');
    const auth = await classroomAuthorization(pool, room.id, u.id);
    const effective = resolveUserPermissions(auth.room, auth.role, auth.room._userPerm);
    return {
      id: row.id,
      name: row.name,
      bundle: JSON.parse(row.bundle_json) as SandboxBundle,
      revision: Number(row.revision),
      updated_at: row.updated_at,
      canEdit: ['owner', 'teacher'].includes(auth.role) || effective.isPresenter,
    };
  });

  const removeBoard = async (req: {
    cookies: Record<string, string | undefined>;
    params: { id: string; board: string };
  }) => {
    const { u, room } = await access(req, req.params.id);
    const boardId = z.uuid().parse(req.params.board);
    await transaction(pool, async (c) => {
      await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [room.id]);
      const auth = await classroomAuthorization(c, room.id, u.id);
      const effective = resolveUserPermissions(auth.room, auth.role, auth.room._userPerm);
      if (!['owner', 'teacher'].includes(auth.role) && !effective.isPresenter) {
        fail(403, 'Forbidden');
      }
      const existing = (
        await c.query('SELECT id FROM sandbox_boards WHERE id=$1 AND classroom_id=$2', [
          boardId,
          room.id,
        ])
      ).rows;
      if (!existing.length) fail(404, 'Not found');
      await c.query('DELETE FROM sandbox_boards WHERE id=$1 AND classroom_id=$2', [
        boardId,
        room.id,
      ]);
      await audit(c, u.id, room.organization_id, 'sandbox.deleted', boardId);
    });
    notify(room.id);
    return { ok: true };
  };

  app.delete<{ Params: { id: string; board: string } }>(base + '/:board', removeBoard);
  app.post<{ Params: { id: string; board: string } }>(base + '/:board/delete', removeBoard);
}
