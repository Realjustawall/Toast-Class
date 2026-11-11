import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateConvertedOutput, DockerDocumentConverter } from '../apps/worker/src/conversion';
import { PresentationWorker } from '../apps/worker/src/presentation-worker';
import { buildApp, type Config } from '../apps/api/src/app';
import { testDatabase, hasRealDatabase } from './database';
import { testStorage } from './storage-fixture';
import { testPng } from './file-fixtures';
import { testPdf, testDocx } from './document-fixtures';

test('converter manifest verification rejects tampering, unsafe names and incorrect raster metadata', async () => {
  const disk = await testStorage(),
    output = join(disk.root, 'output');
  await mkdir(output);
  const bytes = [testPdf(1), testPng()];
  const assets = bytes.map((bytes, index) => ({
    name: index ? 'page-0001.png' : 'document.pdf',
    byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }));
  for (const [index, asset] of assets.entries())
    await writeFile(join(output, asset.name), bytes[index]);
  const manifest = {
    version: 1,
    pageCount: 1,
    pdf: assets[0],
    pages: [{ ...assets[1], number: 1, width: 1, height: 1 }],
  };
  const save = () => writeFile(join(output, 'manifest.json'), JSON.stringify(manifest));
  try {
    await save();
    assert.equal((await validateConvertedOutput(output)).assets.length, 2);
    manifest.pages[0].width = 2;
    await save();
    await assert.rejects(validateConvertedOutput(output), /output_integrity_failed/);
    manifest.pages[0].width = 1;
    manifest.pages[0].name = '../outside.png';
    await save();
    await assert.rejects(validateConvertedOutput(output), /output_integrity_failed/);
    manifest.pages[0].name = 'page-0001.png';
    await save();
    await writeFile(join(output, 'page-0001.png'), Buffer.alloc(bytes[1].length));
    await assert.rejects(validateConvertedOutput(output), /output_integrity_failed/);
  } finally {
    await disk.cleanup();
  }
});

test(
  'real isolated converter worker: PDF/DOCX uploads, private page assets, scanning and failed processing',
  {
    skip: process.env.TEST_CONVERSION_DOCKER !== 'true' || !hasRealDatabase,
    timeout: 180000,
  },
  async () => {
    assert.equal(process.platform, 'linux', 'Run on a Linux Docker host');
    const { pool, cleanup } = await testDatabase(),
      disk = await testStorage(),
      origin = 'http://localhost:5173';
    const files = { storage: disk.storage, allowUnscanned: true, worker: false };
    const config: Config = {
      origin,
      production: false,
      mediaUrl: 'ws://localhost:7880',
      mediaKey: '',
      mediaSecret: '',
      mediaWorker: false,
      breakoutWorker: false,
      presentationWorker: false,
      presentationsEnabled: true,
      files,
    };
    const app = await buildApp(pool, config),
      worker = new PresentationWorker(pool, files, new DockerDocumentConverter());
    let cookie = '';
    const post = (path: string, payload: object) =>
      app.inject({ method: 'POST', url: '/api/v1' + path, headers: { origin, cookie }, payload });
    try {
      await post('/auth/register', {
        email: 'converter@test.example',
        name: 'Converter educator',
        password: 'converter-test-password',
      });
      const login = await post('/auth/login', {
        email: 'converter@test.example',
        password: 'converter-test-password',
      });
      cookie = String(login.headers['set-cookie']).split(';')[0];
      const org = (await post('/organizations', { name: 'Conversion studio' })).json(),
        room = (
          await post('/organizations/' + org.id + '/classrooms', {
            enrollmentMode: 'organization',
            name: 'Document lecture',
          })
        ).json();
      const base = '/classrooms/' + room.id;
      for (const [name, bytes, expected] of [
        ['Lesson.pdf', testPdf(2), 2],
        ['Lesson.docx', await testDocx(), 1],
        ['Broken.pdf', Buffer.from('%PDF-1.4\nnot a valid document'), 0],
      ] as const) {
        const boundary = 'upload-' + randomUUID();
        const upload = await app.inject({
          method: 'POST',
          url: '/api/v1' + base + '/files',
          headers: {
            origin,
            cookie,
            'content-type': 'multipart/form-data; boundary=' + boundary,
            'x-toaster-file-size': String(bytes.length),
          },
          payload: Buffer.concat([
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n\r\n`,
            ),
            bytes,
            Buffer.from(`\r\n--${boundary}--\r\n`),
          ]),
        });
        assert.equal(upload.statusCode, 201, upload.body);
        const requested = await post(base + '/presentations', { fileId: upload.json().id });
        assert.equal(requested.statusCode, 202, requested.body);
        assert.equal(await worker.once(), true);
        let job = await worker.service.job(requested.json().id);
        if (!expected) {
          assert.equal(job.status, 'failed');
          assert.equal(job.failure_code, 'document_processing_failed');
          continue;
        }
        assert.equal(
          job.status,
          'scanning',
          job.failure_code ?? 'Expected actual converted output',
        );
        const assets = (
          await pool.query('SELECT file_id FROM presentation_assets WHERE presentation_id=$1', [
            job.id,
          ])
        ).rows;
        assert.equal(assets.length, expected + 1);
        for (const asset of assets) await worker.service.files.scan(asset.file_id);
        await worker.service.maintenance();
        job = await worker.service.job(job.id);
        assert.equal(job.status, 'ready');
        const details = (
          await app.inject({
            url: '/api/v1' + base + '/presentations/' + job.id,
            headers: { cookie },
          })
        ).json();
        assert.equal(details.pageCount, expected);
        for (const asset of details.assets) {
          const response = await app.inject({
            url: '/api/v1' + base + '/files/' + asset.fileId + '/content',
            headers: { cookie },
          });
          assert.equal(response.statusCode, 200);
          if (asset.page > 0) {
            assert.ok(asset.width > 100);
            assert.ok(asset.height > 100);
            assert.equal(response.rawPayload.subarray(1, 4).toString(), 'PNG');
          } else if (name.endsWith('.pdf')) assert.deepEqual(response.rawPayload, bytes);
        }
      }
    } finally {
      await app.close();
      await cleanup();
      await disk.cleanup();
    }
  },
);
