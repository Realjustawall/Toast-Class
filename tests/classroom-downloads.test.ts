import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase, hasRealDatabase } from './database';
import { testStorage } from './storage-fixture';
import { testPng } from './file-fixtures';
import { testPdf } from './document-fixtures';
import { buildApp } from '../apps/api/src/app';

test('presenter download policies persist, fence file transports and board books, and enforce fresh roles, tenants and revisions', async () => {
  const { pool, cleanup } = await testDatabase(),
    storage = await testStorage(),
    origin = 'http://localhost:5173';
  const app = await buildApp(pool, {
    origin,
    production: false,
    mediaUrl: '',
    mediaKey: '',
    mediaSecret: '',
    files: { storage: storage.storage, allowUnscanned: true, worker: false },
  });
  const post = (path: string, payload: object, cookie: string) =>
      app.inject({ method: 'POST', url: '/api/v1' + path, headers: { origin, cookie }, payload }),
    get = (path: string, cookie: string) =>
      app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
  const account = async (name: string) => {
    const email = name + '@downloads.test',
      r = await post('/auth/register', { email, name, password: '123456' }, '');
    assert.equal(r.statusCode, 201);
    const login = await post('/auth/login', { email, password: '123456' }, '');
    return { id: r.json().id, email, cookie: String(login.headers['set-cookie']).split(';')[0] };
  };
  const upload = async (base: string, cookie: string, bytes: Buffer, name: string, query = '') => {
    const b = 'upload-' + randomUUID();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1' + base + '/files' + query,
      headers: {
        origin,
        cookie,
        'content-type': 'multipart/form-data; boundary=' + b,
        'x-toaster-file-size': String(bytes.length),
      },
      payload: Buffer.concat([
        Buffer.from(
          '--' +
            b +
            '\r\nContent-Disposition: form-data; name="file"; filename="' +
            name +
            '"\r\nContent-Type: application/octet-stream\r\n\r\n',
        ),
        bytes,
        Buffer.from('\r\n--' + b + '--\r\n'),
      ]),
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  };
  try {
    const owner = await account('Owner'),
      presenter = await account('Presenter'),
      viewer = await account('Viewer'),
      outsider = await account('Outsider'),
      foreign = await account('Foreign');
    const org = (await post('/organizations', { name: 'Download policies' }, owner.cookie)).json();
    for (const u of [presenter, viewer, outsider])
      await post(
        '/organizations/' + org.id + '/members',
        { email: u.email, role: 'student' },
        owner.cookie,
      );
    const room = (
        await post(
          '/organizations/' + org.id + '/classrooms',
          { name: 'Class', memberIds: [presenter.id, viewer.id] },
          owner.cookie,
        )
      ).json(),
      base = '/classrooms/' + room.id;
    const file = await upload(
      base,
      owner.cookie,
      Buffer.from('Original lesson content'),
      'lesson.txt',
    );
    const toggle = (
      kind: string,
      targetId: string,
      enabled: boolean,
      revision: number,
      cookie = presenter.cookie,
    ) => post(base + '/downloads', { kind, targetId, enabled, expectedRevision: revision }, cookie);
    assert.equal((await get(base + '/downloads', viewer.cookie)).json().canManage, false);
    assert.equal(
      (await get(base + '/files/' + file.id + '/content', viewer.cookie)).statusCode,
      200,
    );
    assert.equal((await toggle('file', file.id, false, 0, viewer.cookie)).statusCode, 403);
    await post(base + '/user-permissions/' + presenter.id, { isPresenter: true }, owner.cookie);
    const closed = await toggle('file', file.id, false, 0);
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(closed.json().revision, 1);
    for (const suffix of ['', '?raw=1', '?encoding=base64'])
      assert.equal(
        (await get(base + '/files/' + file.id + '/content' + suffix, viewer.cookie)).statusCode,
        403,
      );
    for (const method of ['GET', 'HEAD'] as const)
      assert.equal(
        (
          await app.inject({
            method,
            url: '/api/v1' + base + '/files/' + file.id + '/content',
            headers: { cookie: viewer.cookie, range: 'bytes=0-5' },
          })
        ).statusCode,
        403,
      );
    assert.equal(
      (await get(base + '/files/' + file.id + '/content', presenter.cookie)).statusCode,
      200,
    );
    assert.equal((await toggle('file', file.id, true, 0)).statusCode, 409);
    const persisted = await get(base + '/downloads', viewer.cookie);
    assert.ok(
      persisted
        .json()
        .items.some(
          (p: { targetId: string; enabled: boolean }) => p.targetId === file.id && !p.enabled,
        ),
    );
    assert.equal((await get(base + '/downloads', outsider.cookie)).statusCode, 403);
    assert.equal((await get(base + '/downloads', foreign.cookie)).statusCode, 403);
    assert.equal((await toggle('file', file.id, true, 1, foreign.cookie)).statusCode, 403);
    assert.equal((await toggle('file', randomUUID(), true, 0)).statusCode, 404);
    const root = (await post(base + '/board-book', {}, owner.cookie)).json(),
      child = (await post(base + '/documents/' + root.id + '/pages', {}, owner.cookie)).json();
    const pdf = await upload(base, owner.cookie, await testPdf(), 'source.pdf');
    await pool.query(
      'UPDATE collaborative_documents SET pdf_source_file_id=$1,pdf_source_page=1 WHERE id=$2',
      [pdf.id, root.id],
    );
    const image = await upload(
      base,
      owner.cookie,
      testPng(),
      'background.png',
      '?annotationImage=1',
    );
    assert.equal((await toggle('board', child.id, false, 0)).statusCode, 200);
    for (const targetId of [root.id, child.id]) {
      assert.equal(
        (await post(base + '/downloads/authorize', { targetId, format: 'pdf' }, viewer.cookie))
          .statusCode,
        403,
      );
      assert.equal(
        (await post(base + '/downloads/authorize', { targetId, format: 'pdf' }, owner.cookie))
          .statusCode,
        200,
      );
      assert.equal(
        (await get(base + '/documents/' + targetId + '/board', viewer.cookie)).statusCode,
        200,
        'Viewing must stay available',
      );
    }
    assert.equal(
      (
        await get(
          base + '/files/' + pdf.id + '/content?documentId=' + root.id + '&raw=1',
          viewer.cookie,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (await get(base + '/files/' + pdf.id + '/content?encoding=base64', viewer.cookie)).statusCode,
      403,
      'Omitting the document does not bypass a closed book',
    );
    assert.equal(
      (await get(base + '/files/' + pdf.id + '/content?documentId=' + randomUUID(), viewer.cookie))
        .statusCode,
      403,
      'A fabricated document ID does not bypass a closed book',
    );
    assert.equal(
      (await get(base + '/files/' + image.id + '/content', viewer.cookie)).statusCode,
      200,
      'Rendering background assets stay readable',
    );
    const csrf = await app.inject({
      method: 'POST',
      url: '/api/v1' + base + '/downloads',
      headers: { origin: 'https://untrusted.test', cookie: owner.cookie },
      payload: { kind: 'board', targetId: root.id, enabled: true, expectedRevision: 1 },
    });
    assert.equal(csrf.statusCode, 403);
    await post(base + '/user-permissions/' + presenter.id, { isPresenter: false }, owner.cookie);
    assert.equal((await toggle('file', file.id, true, 1)).statusCode, 403);
    assert.equal(
      (await get(base + '/files/' + file.id + '/content', presenter.cookie)).statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          base + '/documents/' + root.id + '/page-action',
          { kind: 'archive', archived: true },
          owner.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await toggle('board', root.id, true, 1, owner.cookie)).statusCode,
      200,
      'Archiving the first page must not break the book download policy',
    );
    assert.equal(
      (
        await post(
          base + '/downloads/authorize',
          { targetId: child.id, format: 'pdf' },
          viewer.cookie,
        )
      ).statusCode,
      200,
    );
    // Prepared conversion assets isolate authorization from the optional Linux converter.
    const basic = (
      await post(
        base + '/documents',
        { name: 'Basic board', kind: 'board', boardFormat: 'legacy' },
        owner.cookie,
      )
    ).json();
    assert.equal(
      (
        await post(
          base + '/downloads/authorize',
          { targetId: basic.id, format: 'pdf' },
          viewer.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal((await toggle('board', basic.id, false, 0, owner.cookie)).statusCode, 200);
    assert.equal(
      (
        await post(
          base + '/downloads/authorize',
          { targetId: basic.id, format: 'pdf' },
          viewer.cookie,
        )
      ).statusCode,
      403,
    );
    const presentationId = randomUUID(),
      generation = randomUUID();
    await pool.query(
      "INSERT INTO presentations(id,organization_id,classroom_id,source_file_id,name,status,generation,page_count,created_by) VALUES($1,$2,$3,$4,'Slides','ready',$5,1,$6)",
      [presentationId, org.id, room.id, file.id, generation, owner.id],
    );
    for (const [asset, page, width, height] of [
      [pdf.id, 0, null, null],
      [image.id, 1, 10, 10],
    ]) {
      await pool.query("UPDATE files SET purpose='presentation' WHERE id=$1", [asset]);
      await pool.query(
        'INSERT INTO presentation_assets(presentation_id,organization_id,generation,file_id,page_number,width,height) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [presentationId, org.id, generation, asset, page, width, height],
      );
    }
    assert.equal((await toggle('file', file.id, true, 1, owner.cookie)).statusCode, 200);
    assert.equal(
      (await get(base + '/files/' + pdf.id + '/content', viewer.cookie)).statusCode,
      200,
    );
    assert.equal(
      (await toggle('presentation', presentationId, false, 0, owner.cookie)).statusCode,
      200,
    );
    assert.equal(
      (await get(base + '/files/' + pdf.id + '/content', viewer.cookie)).statusCode,
      403,
    );
    assert.equal(
      (await get(base + '/files/' + file.id + '/content', viewer.cookie)).statusCode,
      403,
    );
    assert.equal(
      (await get(base + '/files/' + image.id + '/content', viewer.cookie)).statusCode,
      200,
    );
    assert.equal(
      (await toggle('presentation', presentationId, true, 1, owner.cookie)).statusCode,
      200,
    );
    assert.equal(
      (await get(base + '/files/' + pdf.id + '/content', viewer.cookie)).statusCode,
      200,
    );
    if (hasRealDatabase) {
      const results = await Promise.all([
        toggle('file', file.id, true, 2, owner.cookie),
        toggle('file', file.id, false, 2, owner.cookie),
      ]);
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    }
    assert.ok(
      (
        await pool.query(
          "SELECT id FROM audit_logs WHERE action='classroom.download_access_changed'",
        )
      ).rows.length >= 3,
    );
  } finally {
    await app.close();
    await storage.cleanup();
    await cleanup();
  }
});
