import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ZipFile } from 'yazl';
import { buildApp, type Config } from '../apps/api/src/app';
import { FileService } from '../apps/api/src/files';
import { ClamAVScanner } from '../apps/api/src/antivirus';
import { inspectFile, fileName } from '../apps/api/src/file-validation';
import { testDatabase, hasRealDatabase } from './database';
import { testStorage } from './storage-fixture';
import { testPng } from './file-fixtures';
import { fileConfigFromEnvironment } from '../apps/api/src/file-config';
import { FileSystemStorage } from '../apps/api/src/object-storage';

test('relative private storage stays anchored to the launch directory in source and compiled builds', () => {
  const files = fileConfigFromEnvironment({
    FILE_STORAGE_DRIVER: 'filesystem',
    FILE_STORAGE_DIR: '.local/shared-private',
  });
  assert.ok(files.storage instanceof FileSystemStorage);
  assert.equal(files.storage.root, resolve('.local/shared-private'));
});

const origin = 'http://localhost:5173';
const config: Config = {
  origin,
  production: false,
  mediaUrl: 'ws://localhost:7880',
  mediaKey: '',
  mediaSecret: '',
  mediaWorker: false,
  breakoutWorker: false,
};
const multipart = (name: string, body: Buffer) => {
  const boundary = 'toaster-' + randomUUID();
  return {
    boundary,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
};

test('files enforce scoped authorization, real persistent blobs, quota, folders and copies', async (t) => {
  const { pool, cleanup } = await testDatabase(),
    disk = await testStorage();
  const settings = {
    ...config,
    files: { storage: disk.storage, allowUnscanned: true, maxUploadBytes: 4096, worker: false },
  };
  let app = await buildApp(pool, settings);
  const post = (path: string, data: unknown, cookie = '') =>
    app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: { origin, cookie },
      payload: data as object,
    });
  const get = (path: string, cookie = '') =>
    app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
  const upload = (
    path: string,
    name: string,
    body: Buffer,
    cookie: string,
    declared = body.length,
  ) => {
    const part = multipart(name, body);
    return app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: {
        origin,
        cookie,
        'content-type': 'multipart/form-data; boundary=' + part.boundary,
        'x-toaster-file-size': String(declared),
      },
      payload: part.payload,
    });
  };
  async function account(email: string) {
    assert.equal(
      (await post('/auth/register', { email, name: email, password: 'file-upload-test-password' }))
        .statusCode,
      201,
    );
    const response = await post('/auth/login', { email, password: 'file-upload-test-password' });
    return { id: response.json().id, cookie: String(response.headers['set-cookie']).split(';')[0] };
  }
  try {
    const owner = await account('owner@files.test'),
      student = await account('student@files.test'),
      outsider = await account('outsider@files.test');
    const org = (await post('/organizations', { name: 'File workshop' }, owner.cookie)).json();
    await post(
      '/organizations/' + org.id + '/members',
      { email: 'student@files.test', role: 'student' },
      owner.cookie,
    );
    const room = (
        await post(
          '/organizations/' + org.id + '/classrooms',
          { enrollmentMode: 'organization', name: 'Resource class' },
          owner.cookie,
        )
      ).json(),
      otherRoom = (
        await post(
          '/organizations/' + org.id + '/classrooms',
          { enrollmentMode: 'organization', name: 'Other class' },
          owner.cookie,
        )
      ).json();
    const base = '/classrooms/' + room.id;
    let id = '';
    const body = Buffer.from('Hello — سلام\nClass resources.');
    await t.test(
      'student, outsider and anonymous upload attempts are denied server-side',
      async () => {
        assert.equal((await upload(base + '/files', 'notes.txt', body, '')).statusCode, 401);
        assert.equal(
          (await upload(base + '/files', 'notes.txt', body, student.cookie)).statusCode,
          403,
        );
        assert.equal(
          (await upload(base + '/files', 'notes.txt', body, outsider.cookie)).statusCode,
          403,
        );
      },
    );
    await t.test(
      'Unicode file bytes and metadata survive API restart without being labelled scanned',
      async () => {
        const response = await upload(base + '/files', 'یادداشت.txt', body, owner.cookie);
        assert.equal(response.statusCode, 201, response.body);
        id = response.json().id;
        assert.equal(response.json().status, 'ready');
        assert.equal(response.json().scanStatus, 'unscanned');
        assert.equal(response.json().name, 'یادداشت.txt');
        assert.ok(!('object_key' in response.json()));
        await app.close();
        app = await buildApp(pool, settings);
        const content = await get(base + '/files/' + id + '/content', student.cookie);
        assert.equal(content.statusCode, 200, content.body);
        assert.deepEqual(content.rawPayload, body);
        assert.match(content.headers['content-disposition'] as string, /filename\*=UTF-8''/);
        assert.equal(content.headers['cache-control'], 'private, no-store');
        assert.match(content.headers['content-security-policy'] as string, /sandbox/);
        const range = await app.inject({
          method: 'GET',
          url: '/api/v1' + base + '/files/' + id + '/content',
          headers: { cookie: student.cookie, range: 'bytes=0-4' },
        });
        assert.equal(range.statusCode, 206);
        assert.equal(range.body, 'Hello');
        assert.equal(range.headers['content-range'], 'bytes 0-4/' + body.length);
        assert.equal(
          (await get(base + '/files/' + id + '/content', outsider.cookie)).statusCode,
          403,
        );
        assert.equal(
          (await get('/classrooms/' + otherRoom.id + '/files/' + id + '/content', owner.cookie))
            .statusCode,
          404,
        );
        assert.equal(
          (await get('/organizations/' + org.id + '/files/' + id + '/content', owner.cookie))
            .statusCode,
          404,
        );
      },
    );
    await t.test('quota is authoritative and size/type failures release reservations', async () => {
      await pool.query('UPDATE organizations SET storage_quota_bytes=$1 WHERE id=$2', [
        body.length + 2,
        org.id,
      ]);
      assert.equal(
        (await upload(base + '/files', 'extra.txt', Buffer.from('extra'), owner.cookie)).statusCode,
        409,
      );
      await pool.query('UPDATE organizations SET storage_quota_bytes=10000 WHERE id=$1', [org.id]);
      assert.equal(
        (
          await upload(
            base + '/files',
            'wrong.pdf',
            Buffer.from('<script>bad()</script>'),
            owner.cookie,
          )
        ).statusCode,
        400,
      );
      assert.equal(
        (await upload(base + '/files', 'short.txt', Buffer.from('short'), owner.cookie, 8))
          .statusCode,
        400,
      );
      assert.equal(
        (await upload(base + '/files', 'long.txt', Buffer.from('longer'), owner.cookie, 2))
          .statusCode,
        413,
      );
      assert.equal(
        (await upload(base + '/files', 'huge.txt', Buffer.from('x'), owner.cookie, 4097))
          .statusCode,
        400,
      );
      const state = (await get(base + '/files', owner.cookie)).json();
      assert.equal(state.usage.usedBytes, String(body.length));
      assert.equal((await get(base + '/files', student.cookie)).json().files.length, 1);
      if (hasRealDatabase) {
        await pool.query('UPDATE organizations SET storage_quota_bytes=$1 WHERE id=$2', [
          body.length + 8,
          org.id,
        ]);
        const competing = await Promise.all(
          ['race-a.txt', 'race-b.txt'].map((name) =>
            upload(base + '/files', name, Buffer.from('sixsix'), owner.cookie),
          ),
        );
        assert.deepEqual(competing.map((r) => r.statusCode).sort(), [201, 409]);
        const winner = competing.find((r) => r.statusCode === 201)!.json();
        assert.equal(
          (await get(base + '/files', owner.cookie)).json().usage.usedBytes,
          String(body.length + 6),
        );
        await post(base + '/files/' + winner.id + '/delete', {}, owner.cookie);
        await new FileService(pool, settings.files).sweep();
        await pool.query('UPDATE organizations SET storage_quota_bytes=10000 WHERE id=$1', [
          org.id,
        ]);
      }
    });
    await t.test(
      'folder moves, copy and literal search preserve scope and prevent cycles',
      async () => {
        const folder = (
            await post(base + '/file-folders', { name: 'Materials' }, owner.cookie)
          ).json(),
          child = (
            await post(
              base + '/file-folders',
              { name: 'Exercises', parentId: folder.id },
              owner.cookie,
            )
          ).json();
        assert.equal(
          (
            await post(
              base + '/file-folders/' + folder.id + '/update',
              { parentId: child.id },
              owner.cookie,
            )
          ).statusCode,
          409,
        );
        assert.equal(
          (
            await post(
              base + '/files/' + id + '/update',
              { name: 'Guide 100%.txt', folderId: folder.id },
              student.cookie,
            )
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await post(
              base + '/files/' + id + '/update',
              { name: 'Guide 100%.txt', folderId: folder.id },
              owner.cookie,
            )
          ).statusCode,
          200,
        );
        const copy = await post(
          base + '/files/' + id + '/copy',
          { name: 'Copied notes.txt', folderId: null },
          owner.cookie,
        );
        assert.equal(copy.statusCode, 201, copy.body);
        assert.deepEqual(
          (await get(base + '/files/' + copy.json().id + '/content', student.cookie)).rawPayload,
          body,
        );
        assert.equal(
          (await pool.query('SELECT source_file_id FROM files WHERE id=$1', [copy.json().id]))
            .rows[0].source_file_id,
          id,
        );
        const search = (
          await get(base + '/files?folderId=' + folder.id + '&search=100%25', student.cookie)
        ).json();
        // pg-mem does not implement PostgreSQL's backslash escaping for ILIKE.
        // The literal wildcard contract runs against real PostgreSQL in CI.
        if (hasRealDatabase) assert.equal(search.files.length, 1);
        assert.equal(
          (await get(base + '/files?folderId=' + folder.id + '&search=100_', student.cookie)).json()
            .files.length,
          0,
        );
        const wrong = (
          await post(
            '/classrooms/' + otherRoom.id + '/file-folders',
            { name: 'Other scope' },
            owner.cookie,
          )
        ).json();
        assert.equal(
          (await post(base + '/files/' + id + '/update', { folderId: wrong.id }, owner.cookie))
            .statusCode,
          404,
        );
        assert.equal(
          (await post(base + '/file-folders/' + folder.id + '/delete', {}, owner.cookie))
            .statusCode,
          409,
        );
      },
    );
    await t.test('deletion keeps bytes reserved until blob removal and is auditable', async () => {
      assert.equal(
        (await post(base + '/files/' + id + '/delete', {}, student.cookie)).statusCode,
        403,
      );
      assert.equal(
        (await post(base + '/files/' + id + '/delete', {}, owner.cookie)).statusCode,
        200,
      );
      assert.equal((await get(base + '/files/' + id + '/content', student.cookie)).statusCode, 404);
      const before = (await get(base + '/files', owner.cookie)).json().usage.usedBytes;
      await new FileService(pool, settings.files).sweep();
      const after = (await get(base + '/files', owner.cookie)).json().usage.usedBytes;
      assert.equal(BigInt(before) - BigInt(after), BigInt(body.length));
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) AS count FROM audit_logs WHERE action='file.blob_removed' AND resource_id=$1",
              [id],
            )
          ).rows[0].count,
        ),
        1,
      );
    });
  } finally {
    await app.close();
    await cleanup();
    await disk.cleanup();
  }
});

test('scanner failures quarantine content, retry leases resist stale clean results and cleanup is bounded', async (t) => {
  const { pool, cleanup } = await testDatabase(),
    disk = await testStorage();
  let mode: 'error' | 'infected' | 'clean' | 'deferred' = 'error';
  let release: ((v: 'clean' | 'infected') => void) | undefined;
  let started: (() => void) | undefined;
  const scanner = {
    async scan() {
      if (mode === 'error') throw new Error('Test scanner unavailable');
      if (mode === 'deferred') {
        started?.();
        return new Promise<'clean' | 'infected'>((resolve) => {
          release = resolve;
        });
      }
      return mode;
    },
  };
  const settings = { ...config, files: { storage: disk.storage, scanner, worker: false } };
  const app = await buildApp(pool, settings);
  const service = new FileService(pool, settings.files);
  const post = (path: string, data: unknown, cookie = '') =>
    app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: { origin, cookie },
      payload: data as object,
    });
  try {
    await post('/auth/register', {
      email: 'scan@files.test',
      name: 'Scan owner',
      password: 'scanner-workflow-password',
    });
    const login = await post('/auth/login', {
        email: 'scan@files.test',
        password: 'scanner-workflow-password',
      }),
      cookie = String(login.headers['set-cookie']).split(';')[0];
    const org = (await post('/organizations', { name: 'Scan organization' }, cookie)).json(),
      room = (
        await post(
          '/organizations/' + org.id + '/classrooms',
          { enrollmentMode: 'organization', name: 'Scan class' },
          cookie,
        )
      ).json();
    const base = '/classrooms/' + room.id;
    const body = Buffer.from('Scan fixture');
    const part = multipart('scan.txt', body);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1' + base + '/files',
      headers: {
        origin,
        cookie,
        'content-type': 'multipart/form-data; boundary=' + part.boundary,
        'x-toaster-file-size': String(body.length),
      },
      payload: part.payload,
    });
    assert.equal(response.statusCode, 201, response.body);
    const file = response.json();
    assert.equal(file.status, 'quarantined');
    assert.equal(file.scanStatus, 'error');
    const download = () =>
      app.inject({
        method: 'GET',
        url: '/api/v1' + base + '/files/' + file.id + '/content',
        headers: { cookie },
      });
    assert.equal((await download()).statusCode, 409);
    mode = 'clean';
    assert.equal(
      (await post(base + '/files/' + file.id + '/retry-scan', {}, cookie)).statusCode,
      200,
    );
    assert.equal((await download()).statusCode, 200);
    await t.test('a stale clean verdict cannot unblock a newly infected file', async () => {
      await pool.query("UPDATE files SET status='quarantined',scan_attempts=0 WHERE id=$1", [
        file.id,
      ]);
      mode = 'deferred';
      const begin = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = service.scan(file.id);
      await begin;
      await pool.query('UPDATE files SET scan_claimed_until=$1 WHERE id=$2', [
        new Date(Date.now() - 1000),
        file.id,
      ]);
      mode = 'infected';
      await service.scan(file.id);
      release!('clean');
      await pending;
      assert.equal(
        (await pool.query('SELECT status FROM files WHERE id=$1', [file.id])).rows[0].status,
        'deleting',
      );
      assert.equal((await download()).statusCode, 409);
    });
    await t.test(
      'cleanup failures retain quota and stop automatic retries at eight attempts',
      async () => {
        const broken = new FileService(pool, {
          ...settings.files,
          storage: {
            put: disk.storage.put.bind(disk.storage),
            get: disk.storage.get.bind(disk.storage),
            async delete() {
              throw new Error('Test storage outage');
            },
          },
        });
        for (let attempt = 0; attempt < 10; attempt++) {
          await pool.query('UPDATE files SET next_cleanup_at=$1 WHERE id=$2', [
            new Date(Date.now() - 1000),
            file.id,
          ]);
          await broken.sweep();
        }
        const row = (
          await pool.query('SELECT status,cleanup_attempts FROM files WHERE id=$1', [file.id])
        ).rows[0];
        assert.equal(row.status, 'deleting');
        assert.equal(row.cleanup_attempts, 8);
        assert.equal((await service.usage(org.id)).usedBytes, String(body.length));
        await post(base + '/files/' + file.id + '/delete', {}, cookie);
        await service.sweep();
        assert.equal(
          (await pool.query('SELECT status FROM files WHERE id=$1', [file.id])).rows[0].status,
          'rejected',
        );
        assert.equal((await service.usage(org.id)).usedBytes, '0');
      },
    );
    await assert.rejects(
      () =>
        buildApp(pool, {
          ...settings,
          production: true,
          files: { ...settings.files, allowUnscanned: true },
        }),
      /Production cannot release unscanned/,
    );
  } finally {
    await app.close();
    await cleanup();
    await disk.cleanup();
  }
});

test('file validation rejects disguised active content and unsafe OOXML expansion', async () => {
  const disk = await testStorage();
  const path = join(disk.root, 'archive');
  async function archive(entries: Record<string, string>) {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    for (const [name, text] of Object.entries(entries)) zip.addBuffer(Buffer.from(text), name);
    zip.end();
    await once(zip.outputStream, 'end');
    await writeFile(path, Buffer.concat(chunks));
  }
  try {
    await writeFile(path, testPng());
    assert.equal(await inspectFile(path, 'mark.png'), 'image/png');
    await writeFile(path, testPng(20000, 20000));
    await assert.rejects(() => inspectFile(path, 'oversized.png'), /dimensions exceed/);
    for (const name of ['../escape.txt', 'bad\r\nheader.txt', '\u202eexe.txt'])
      assert.equal(fileName.safeParse(name).success, false);
    await writeFile(path, '<svg onload="alert(1)"></svg>');
    await assert.rejects(() => inspectFile(path, 'disguised.png'), /Unsupported/);
    await archive({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<document/>' });
    assert.match(await inspectFile(path, 'notes.docx'), /wordprocessingml/);
    await archive({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': '<document/>',
      'word/vbaProject.bin': 'macro-fixture',
    });
    await assert.rejects(() => inspectFile(path, 'notes.docx'), /Unsafe/);
    await archive({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': 'x'.repeat(1024 * 1024),
    });
    await assert.rejects(() => inspectFile(path, 'notes.docx'), /expanded/);
    await assert.rejects(() => disk.storage.get('../outside'), /Invalid/);
  } finally {
    await disk.cleanup();
  }
});

test('ClamAV adapter streams bytes and never treats malformed or absent verdicts as clean', async () => {
  const disk = await testStorage(),
    path = join(disk.root, 'sample');
  await writeFile(path, 'harmless scanner protocol fixture');
  let verdict = 'stream: OK\0';
  let captured = Buffer.alloc(0);
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0),
      header = false,
      received: Buffer[] = [];
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!header) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        assert.equal(buffer.subarray(0, end).toString(), 'zINSTREAM');
        buffer = buffer.subarray(end + 1);
        header = true;
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE();
        if (buffer.length < 4 + size) return;
        buffer = buffer.subarray(4);
        if (size === 0) {
          captured = Buffer.concat(received);
          socket.end(verdict);
          return;
        }
        received.push(buffer.subarray(0, size));
        buffer = buffer.subarray(size);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing scanner test port');
  const scanner = new ClamAVScanner('127.0.0.1', address.port, 1000);
  try {
    assert.equal(await scanner.scan(path), 'clean');
    assert.deepEqual(captured, await readFile(path));
    verdict = 'stream: Test.Signature FOUND\0';
    assert.equal(await scanner.scan(path), 'infected');
    verdict = 'stream: unknown ERROR\0';
    await assert.rejects(() => scanner.scan(path), /verdict/);
    verdict = '';
    await assert.rejects(() => scanner.scan(path), /without a verdict/);
  } finally {
    server.close();
    await once(server, 'close');
    await disk.cleanup();
  }
});
