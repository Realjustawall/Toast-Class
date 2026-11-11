import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildApp, type Config } from '../apps/api/src/app';
import { PresentationService, CONVERSION_OUTPUT_LIMIT } from '../apps/api/src/presentations';
import { testDatabase, hasRealDatabase } from './database';
import { testStorage } from './storage-fixture';
import { testPng } from './file-fixtures';

test('presentation queue, quota, tenant boundaries and revisioned classroom page authority', async (t) => {
  const { pool, cleanup } = await testDatabase(),
    disk = await testStorage();
  const files = { storage: disk.storage, allowUnscanned: true, worker: false };
  const config: Config = {
    origin: 'http://localhost:5173',
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
  let app = await buildApp(pool, config);
  const post = (path: string, data: unknown, cookie = '') =>
    app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: { origin: config.origin, cookie },
      payload: data as object,
    });
  const get = (path: string, cookie = '') =>
    app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
  const account = async (email: string) => {
    assert.equal(
      (await post('/auth/register', { email, name: email, password: 'presentation-test-password' }))
        .statusCode,
      201,
    );
    const response = await post('/auth/login', { email, password: 'presentation-test-password' });
    return { id: response.json().id, cookie: String(response.headers['set-cookie']).split(';')[0] };
  };
  try {
    const owner = await account('owner@presentations.test'),
      student = await account('student@presentations.test'),
      outsider = await account('outsider@presentations.test');
    const org = (
      await post('/organizations', { name: 'Presentation studio' }, owner.cookie)
    ).json();
    await post(
      '/organizations/' + org.id + '/members',
      { email: 'student@presentations.test', role: 'student' },
      owner.cookie,
    );
    const room = (
      await post(
        '/organizations/' + org.id + '/classrooms',
        { enrollmentMode: 'organization', name: 'Lecture' },
        owner.cookie,
      )
    ).json();
    const otherRoom = (
      await post(
        '/organizations/' + org.id + '/classrooms',
        { enrollmentMode: 'organization', name: 'Independent lecture' },
        owner.cookie,
      )
    ).json();
    const base = '/classrooms/' + room.id,
      service = new PresentationService(pool, files);
    const upload = async (scope: string, name: string, bytes: Buffer) => {
      const boundary = 'upload-' + randomUUID();
      return app.inject({
        method: 'POST',
        url: '/api/v1' + scope + '/files',
        headers: {
          origin: config.origin,
          cookie: owner.cookie,
          'x-toaster-file-size': String(bytes.length),
          'content-type': 'multipart/form-data; boundary=' + boundary,
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n\r\n`,
          ),
          bytes,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
    };
    const source = (
      await upload(base, 'Lecture.txt', Buffer.from('A real document source.'))
    ).json();
    let jobId = '';
    await t.test(
      'only authorized teachers can queue a real released source and reserve output quota',
      async () => {
        assert.equal((await post(base + '/presentations', { fileId: source.id })).statusCode, 401);
        assert.equal(
          (await post(base + '/presentations', { fileId: source.id }, student.cookie)).statusCode,
          403,
        );
        assert.equal(
          (await post(base + '/presentations', { fileId: source.id }, outsider.cookie)).statusCode,
          403,
        );
        assert.equal(
          (
            await post(
              '/classrooms/' + otherRoom.id + '/presentations',
              { fileId: source.id },
              owner.cookie,
            )
          ).statusCode,
          404,
        );
        const response = await post(
          base + '/presentations',
          { fileId: source.id, name: 'Weekly workshop', status: 'ready' },
          owner.cookie,
        );
        assert.equal(response.statusCode, 202, response.body);
        jobId = response.json().id;
        assert.equal(response.json().status, 'queued');
        const usage = (await get(base + '/files', owner.cookie)).json().usage;
        assert.equal(
          BigInt(usage.usedBytes),
          BigInt(CONVERSION_OUTPUT_LIMIT + Buffer.byteLength('A real document source.')),
        );
        assert.equal(
          (await post(base + '/presentations', { fileId: source.id }, owner.cookie)).statusCode,
          409,
        );
        assert.equal((await get(base + '/presentations/' + jobId, student.cookie)).statusCode, 404);
        assert.equal(
          (await get(base + '/presentations', student.cookie)).json().presentations.length,
          0,
        );
        assert.equal(
          (await post(base + '/files/' + source.id + '/delete', {}, owner.cookie)).statusCode,
          409,
        );
        assert.equal(
          (await get('/classrooms/' + otherRoom.id + '/presentations/' + jobId, owner.cookie))
            .statusCode,
          404,
        );
        assert.equal((await get(base + '/presentations', outsider.cookie)).statusCode, 403);
        await app.close();
        app = await buildApp(pool, config);
        assert.equal(
          (await get(base + '/presentations/' + jobId, owner.cookie)).json().status,
          'queued',
        );
      },
    );
    let pageFile = '',
      initiallyReadyFile = '';
    await t.test(
      'rendered test fixtures remain private until all outputs are released; library mutations cannot corrupt assets',
      async () => {
        // Fixture setup tests publication/control contracts, not converter behavior.
        // Actual LibreOffice/Poppler assertions live in scripts/test_converter.py.
        const p = await service.job(jobId),
          scope = { orgId: org.id, roomId: room.id, userId: owner.id, role: 'owner' };
        for (const [number, bytes] of [
          Buffer.from('%PDF-fixture'),
          testPng(),
          testPng(),
        ].entries()) {
          const file = await service.files.reserve(
            scope,
            'fixture-' + number + (number ? '.png' : '.pdf'),
            bytes.length,
            null,
          );
          const path = join(disk.root, 'asset-' + number);
          await writeFile(path, bytes);
          await disk.storage.put(
            file.key,
            path,
            bytes.length,
            number ? 'image/png' : 'application/pdf',
          );
          await pool.query(
            "UPDATE files SET status=$1,purpose='presentation',media_type=$2,sha256=$3,scan_status='unscanned' WHERE id=$4",
            [
              number === 2 ? 'quarantined' : 'ready',
              number ? 'image/png' : 'application/pdf',
              createHash('sha256').update(bytes).digest('hex'),
              file.id,
            ],
          );
          await pool.query(
            'INSERT INTO presentation_assets(presentation_id,organization_id,generation,file_id,page_number,width,height) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [jobId, org.id, p.generation, file.id, number, number ? 1 : null, number ? 1 : null],
          );
          if (number === 2) pageFile = file.id;
          if (number === 1) initiallyReadyFile = file.id;
        }
        await pool.query(
          "UPDATE presentations SET status='scanning',page_count=2,reserved_bytes=0 WHERE id=$1",
          [jobId],
        );
        await service.maintenance();
        assert.equal((await service.job(jobId)).status, 'scanning');
        assert.equal((await get(base + '/presentations/' + jobId, student.cookie)).statusCode, 404);
        assert.equal(
          (await get(base + '/files/' + initiallyReadyFile + '/content', student.cookie))
            .statusCode,
          404,
          'Knowing an output UUID cannot bypass whole-presentation publication',
        );
        await pool.query("UPDATE files SET status='ready' WHERE id=$1", [pageFile]);
        await service.maintenance();
        assert.equal((await service.job(jobId)).status, 'ready');
        const state = (await get(base + '/presentations/' + jobId, student.cookie)).json();
        assert.equal(state.assets.length, 3);
        assert.equal((await get(base + '/files', student.cookie)).json().files.length, 1);
        assert.deepEqual(
          (await get(base + '/files/' + pageFile + '/content', student.cookie)).rawPayload,
          testPng(),
        );
        for (const [action, data] of [
          ['delete', {}],
          ['update', { name: 'broken.png' }],
          ['copy', {}],
          ['retry-scan', {}],
        ] as const)
          assert.equal(
            (await post(base + '/files/' + pageFile + '/' + action, data, owner.cookie)).statusCode,
            404,
            action,
          );
        assert.equal(
          (
            await get(
              '/classrooms/' + otherRoom.id + '/files/' + pageFile + '/content',
              owner.cookie,
            )
          ).statusCode,
          404,
        );
      },
    );
    await t.test(
      'server pages, role enforcement and monotonic revisions reject stale actions including hide/show ABA',
      async () => {
        let sessionId = randomUUID();
        const show = (revision: number, page = 1) => ({
          action: 'show',
          sessionId,
          presentationId: jobId,
          page,
          independentView: false,
          expectedRevision: revision,
        });
        assert.equal(
          (await post(base + '/presentations/control', show(0), owner.cookie)).statusCode,
          409,
        );
        const started = await post(base + '/session/start', {}, owner.cookie);
        assert.equal(started.statusCode, 201);
        sessionId = started.json().id;
        assert.equal(
          (await post(base + '/presentations/control', show(0), student.cookie)).statusCode,
          403,
        );
        assert.equal(
          (await post(base + '/presentations/control', show(0, 3), owner.cookie)).statusCode,
          400,
        );
        assert.equal(
          (await post(base + '/presentations/control', show(0), owner.cookie)).statusCode,
          200,
        );
        assert.equal((await get(base + '/presentations', student.cookie)).json().current.page, 1);
        assert.equal(
          (await post(base + '/presentations/control', show(0, 2), owner.cookie)).statusCode,
          409,
        );
        assert.equal(
          (
            await post(
              base + '/presentations/control',
              { ...show(1, 2), independentView: true },
              owner.cookie,
            )
          ).statusCode,
          200,
        );
        assert.equal(
          (
            await post(
              base + '/presentations/control',
              { action: 'hide', sessionId, expectedRevision: 2 },
              owner.cookie,
            )
          ).statusCode,
          200,
        );
        const hidden = (await get(base + '/presentations', student.cookie)).json();
        assert.equal(hidden.current, null);
        assert.equal(hidden.revision, 3);
        assert.equal(
          (await post(base + '/presentations/control', show(0), owner.cookie)).statusCode,
          409,
        );
        assert.equal(
          (await post(base + '/presentations/control', show(3, 2), owner.cookie)).statusCode,
          200,
        );
        await app.close();
        app = await buildApp(pool, config);
        assert.equal((await get(base + '/presentations', student.cookie)).json().current.page, 2);
        await post(base + '/session/end', {}, owner.cookie);
        assert.equal((await get(base + '/presentations', student.cookie)).json().current, null);
        const oldSession = sessionId;
        sessionId = (await post(base + '/session/start', {}, owner.cookie)).json().id;
        assert.equal(
          (
            await post(
              base + '/presentations/control',
              { ...show(0), sessionId: oldSession },
              owner.cookie,
            )
          ).statusCode,
          409,
        );
        assert.equal(
          (await post(base + '/presentations/control', show(0), owner.cookie)).statusCode,
          200,
        );
        await post(base + '/session/end', {}, owner.cookie);
      },
    );
    await t.test(
      'exhausted output scanning exposes failure and retry waits for physical cleanup',
      async () => {
        await pool.query("UPDATE presentations SET status='scanning' WHERE id=$1", [jobId]);
        await pool.query(
          "UPDATE files SET status='quarantined',scan_status='error',scan_attempts=5,scan_claimed_until=$1 WHERE id=$2",
          [new Date(Date.now() + 30000), pageFile],
        );
        await service.maintenance();
        assert.equal(
          (await service.job(jobId)).status,
          'scanning',
          'A live final scan must retain its lease',
        );
        await pool.query('UPDATE files SET scan_claimed_until=NULL WHERE id=$1', [pageFile]);
        await service.maintenance();
        assert.equal((await service.job(jobId)).failure_code, 'output_scan_failed');
        assert.equal(
          (await post(base + '/presentations/' + jobId + '/retry', {}, owner.cookie)).statusCode,
          409,
        );
        await service.files.sweep();
        assert.equal(
          (await post(base + '/presentations/' + jobId + '/retry', {}, owner.cookie)).statusCode,
          200,
        );
      },
    );
    await t.test(
      'authorized deletion tears down assets, releases bytes only after storage deletion, and preserves audit',
      async () => {
        assert.equal(
          (await post(base + '/presentations/' + jobId + '/delete', {}, student.cookie)).statusCode,
          403,
        );
        assert.equal(
          (await post(base + '/presentations/' + jobId + '/delete', {}, owner.cookie)).statusCode,
          200,
        );
        assert.equal(
          (await get(base + '/files/' + pageFile + '/content', student.cookie)).statusCode,
          404,
        );
        await service.files.sweep();
        await service.maintenance();
        assert.equal((await service.job(jobId)).status, 'deleted');
        assert.equal(
          (await post(base + '/files/' + source.id + '/delete', {}, owner.cookie)).statusCode,
          200,
        );
        await service.files.sweep();
        assert.equal((await get(base + '/files', owner.cookie)).json().usage.usedBytes, '0');
        assert.ok(
          (
            await pool.query(
              "SELECT id FROM audit_logs WHERE action='presentation.controlled' AND organization_id=$1",
              [org.id],
            )
          ).rowCount,
        );
      },
    );
    await t.test(
      'conversion reserves real quota and expires a lost worker lease without exposing outputs',
      async () => {
        const input = (await upload(base, 'Second.txt', Buffer.from('Another source'))).json();
        await pool.query('UPDATE organizations SET storage_quota_bytes=1000 WHERE id=$1', [org.id]);
        assert.equal(
          (await post(base + '/presentations', { fileId: input.id }, owner.cookie)).statusCode,
          409,
        );
        await pool.query('UPDATE organizations SET storage_quota_bytes=1073741824 WHERE id=$1', [
          org.id,
        ]);
        const requested = (
          await post(base + '/presentations', { fileId: input.id }, owner.cookie)
        ).json();
        await pool.query(
          "UPDATE presentations SET status='processing',claim=$1,claimed_until=$2 WHERE id=$3",
          [randomUUID(), new Date(Date.now() - 1000), requested.id],
        );
        await service.maintenance();
        assert.equal((await service.job(requested.id)).failure_code, 'worker_lease_expired');
        assert.equal(
          (await post(base + '/presentations/' + requested.id + '/retry', {}, owner.cookie))
            .statusCode,
          200,
        );
        assert.equal((await service.job(requested.id)).status, 'queued');
      },
    );
    await t.test(
      'real database worker claims are exclusive, fenced and publish a complete scanned set',
      { skip: !hasRealDatabase },
      async () => {
        const candidates = await Promise.all([service.claimNext(), service.claimNext()]);
        const jobs = candidates.filter((p): p is NonNullable<typeof p> => !!p);
        assert.equal(jobs.length, 1);
        const job = jobs[0];
        assert.equal(await service.heartbeat(job), true);
        assert.equal(await service.heartbeat({ ...job, claim: randomUUID() }), false);
        const assets = [Buffer.from('%PDF-worker-test'), testPng()];
        for (const [page, bytes] of assets.entries()) {
          const path = join(disk.root, 'worker-' + page);
          await writeFile(path, bytes);
          const before = await service.files.usage(org.id);
          const id = await service.stageAsset(
            job,
            {
              page,
              byteSize: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
              ...(page ? { width: 1, height: 1 } : {}),
            },
            (key) =>
              disk.storage.put(key, path, bytes.length, page ? 'image/png' : 'application/pdf'),
          );
          assert.equal(
            (await service.files.usage(org.id)).usedBytes,
            before.usedBytes,
            'Reservation becomes actual bytes without double charging',
          );
          if (page === 0) await assert.rejects(service.complete(job, 1), /incomplete/);
          await service.files.scan(id);
        }
        await service.complete(job, 1);
        await service.maintenance();
        assert.equal((await service.job(job.id)).status, 'ready');
        let invoked = false;
        await assert.rejects(
          service.stageAsset(
            job,
            { page: 2, byteSize: 70, sha256: 'a'.repeat(64), width: 1, height: 1 },
            async () => {
              invoked = true;
            },
          ),
          /lease/,
        );
        assert.equal(invoked, false, 'Stale claims cannot begin storage writes');
        const infected = (
          await pool.query(
            'SELECT file_id FROM presentation_assets WHERE presentation_id=$1 AND page_number=1',
            [job.id],
          )
        ).rows[0].file_id;
        await pool.query("UPDATE presentations SET status='scanning' WHERE id=$1", [job.id]);
        await pool.query(
          "UPDATE files SET status='deleting',scan_status='infected',delete_reason='infected' WHERE id=$1",
          [infected],
        );
        await service.maintenance();
        assert.equal((await service.job(job.id)).failure_code, 'output_scan_failed');
        await service.files.sweep();
        assert.equal(
          (await pool.query('SELECT status FROM files WHERE id=$1', [infected])).rows[0].status,
          'rejected',
        );
        assert.equal(
          (await post(base + '/presentations/' + job.id + '/retry', {}, owner.cookie)).statusCode,
          200,
          'Removed infected output must not permanently block retry',
        );
      },
    );
  } finally {
    await app.close();
    await cleanup();
    await disk.cleanup();
  }
});
