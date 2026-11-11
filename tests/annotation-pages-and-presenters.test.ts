import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { testDatabase } from './database';
import { testStorage } from './storage-fixture';
import { testPng } from './file-fixtures';
import { testPdf } from './document-fixtures';
import { buildApp } from '../apps/api/src/app';
import { unlockedPolicy } from '../apps/api/src/classroom-lock-policy';
test('annotation pages, original PDF assets, private stamps, student presentation and user selection persist with fresh authorization', async () => {
  const { pool, cleanup } = await testDatabase(),
    storage = await testStorage(),
    origin = 'http://localhost:5173',
    app = await buildApp(pool, {
      origin,
      production: false,
      mediaUrl: '',
      mediaKey: '',
      mediaSecret: '',
      files: { storage: storage.storage, allowUnscanned: true, worker: false },
    });
  const post = (path: string, data: unknown, cookie = '') =>
      app.inject({
        method: 'POST',
        url: '/api/v1' + path,
        headers: { origin, cookie },
        payload: data as object,
      }),
    get = (path: string, cookie = '') =>
      app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
  const account = async (name: string) => {
    const email = name + '@annotation.test',
      created = await post('/auth/register', { email, name, password: '123456' });
    assert.equal(created.statusCode, 201);
    const login = await post('/auth/login', { email, password: '123456' });
    return {
      id: created.json().id,
      email,
      cookie: String(login.headers['set-cookie']).split(';')[0],
    };
  };
  const upload = async (base: string, cookie: string, bytes: Buffer, name: string, query = '') => {
    const boundary = 'file-' + randomUUID();
    return app.inject({
      method: 'POST',
      url: '/api/v1' + base + '/files' + query,
      headers: {
        origin,
        cookie,
        'content-type': 'multipart/form-data; boundary=' + boundary,
        'x-toaster-file-size': String(bytes.length),
      },
      payload: Buffer.concat([
        Buffer.from(
          '--' +
            boundary +
            '\r\nContent-Disposition: form-data; name="file"; filename="' +
            name +
            '"\r\nContent-Type: application/octet-stream\r\n\r\n',
        ),
        bytes,
        Buffer.from('\r\n--' + boundary + '--\r\n'),
      ]),
    });
  };
  try {
    const owner = await account('Owner'),
      student = await account('Student'),
      outsider = await account('Outsider'),
      org = (await post('/organizations', { name: 'Annotation school' }, owner.cookie)).json();
    await post(
      '/organizations/' + org.id + '/members',
      { email: student.email, role: 'student' },
      owner.cookie,
    );
    const room = (
        await post(
          '/organizations/' + org.id + '/classrooms',
          { name: 'PDF class', enrollmentMode: 'organization' },
          owner.cookie,
        )
      ).json(),
      base = '/classrooms/' + room.id,
      root = (await post(base + '/board-book', {}, owner.cookie)).json(),
      docBase = base + '/documents/' + root.id;
    assert.equal(
      (await post(docBase + '/page-action', { kind: 'duplicate' }, student.cookie)).statusCode,
      403,
    );
    assert.equal(
      (await upload(base, student.cookie, testPng(), 'no.png', '?annotationImage=1')).statusCode,
      403,
    );
    const image = await upload(
        base,
        owner.cookie,
        testPng(),
        'annotation.png',
        '?annotationImage=1',
      ),
      source = await upload(base, owner.cookie, testPdf(1), 'source.pdf');
    assert.equal(image.statusCode, 201);
    assert.equal(source.statusCode, 201);
    const encoded = await get(
      base + '/files/' + source.json().id + '/content?encoding=base64',
      owner.cookie,
    );
    assert.equal(encoded.statusCode, 200);
    assert.match(String(encoded.headers['content-type']), /^text\/plain/);
    assert.deepEqual(Buffer.from(encoded.body, 'base64'), testPdf(1));
    assert.equal(
      (await get(base + '/files/' + source.json().id + '/content?encoding=base64', outsider.cookie))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          docBase + '/background',
          { fileId: image.json().id, width: 400, height: 600 },
          owner.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await post(docBase + '/pdf-source', { fileId: source.json().id, page: 1 }, owner.cookie))
        .statusCode,
      200,
    );
    assert.equal(
      (await post(base + '/files/' + source.json().id + '/delete', {}, owner.cookie)).statusCode,
      409,
    );
    const state = (await get(docBase + '/board', owner.cookie)).json(),
      ydoc = new Y.Doc(),
      shape = {
        id: 'annotationImage',
        type: 'image',
        fileId: image.json().id,
        status: 'saved',
        scale: [1, 1],
        x: 10,
        y: 20,
        width: 100,
        height: 80,
        angle: 0,
        strokeColor: '#123456',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 1,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: Date.now(),
        link: null,
        locked: false,
      };
    ydoc.getMap('elements').set(shape.id, shape);
    ydoc.getMap('settings').set('measurement', { pixelsPerUnit: 40, unit: 'cm' });
    const update = {
      id: randomUUID(),
      generation: state.generation,
      update: Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64'),
    };
    ydoc.destroy();
    assert.equal((await post(docBase + '/board/updates', update, owner.cookie)).statusCode, 200);
    assert.equal(
      (await pool.query('SELECT file_id FROM board_assets WHERE document_id=$1', [root.id])).rows
        .length,
      1,
    );
    const stamp = await post(
      base + '/annotation-stamps',
      { name: 'Diagram', elements: [shape] },
      owner.cookie,
    );
    assert.equal(stamp.statusCode, 200);
    assert.equal((await get(base + '/annotation-stamps', owner.cookie)).json().length, 1);
    assert.equal((await get(base + '/annotation-stamps', student.cookie)).json().length, 0);
    await post(base + '/annotation-stamps/' + stamp.json().id + '/delete', {}, student.cookie);
    assert.equal((await get(base + '/annotation-stamps', owner.cookie)).json().length, 1);
    assert.equal((await get(base + '/annotation-stamps', outsider.cookie)).statusCode, 403);
    const duplicate = await post(docBase + '/page-action', { kind: 'duplicate' }, owner.cookie);
    assert.equal(duplicate.statusCode, 200);
    const child = duplicate.json().id;
    assert.equal(
      (await pool.query('SELECT file_id FROM board_assets WHERE document_id=$1', [child])).rows
        .length,
      1,
    );
    const copied = (await get(base + '/documents/' + child, owner.cookie)).json().document;
    assert.equal(copied.pdf_source_file_id, source.json().id);
    assert.equal(Number(copied.pdf_source_page), 1);
    assert.equal(
      (await post(docBase + '/page-action', { kind: 'rotate', clockwise: true }, owner.cookie))
        .statusCode,
      200,
    );
    const rotated = (await get(docBase + '/board', owner.cookie)).json();
    assert.notEqual(rotated.generation, state.generation);
    const check = new Y.Doc();
    Y.applyUpdate(check, Buffer.from(rotated.state, 'base64'));
    const value = check.getMap<Record<string, unknown>>('elements').get(shape.id)!;
    assert.equal(value.x, 490);
    assert.equal(value.y, 20);
    assert.equal(check.getMap<{ unit: string }>('settings').get('measurement')!.unit, 'cm');
    check.destroy();
    const edge = new Y.Doc();
    Y.applyUpdate(edge, Buffer.from(rotated.state, 'base64'));
    edge
      .getMap('elements')
      .set(shape.id, { ...value, x: -1e7, y: -1e7, version: Number(value.version) + 1 });
    const edgeWrite = await post(
      docBase + '/board/updates',
      {
        id: randomUUID(),
        generation: rotated.generation,
        update: Buffer.from(Y.encodeStateAsUpdate(edge)).toString('base64'),
      },
      owner.cookie,
    );
    edge.destroy();
    assert.equal(edgeWrite.statusCode, 200);
    const beforeRejectedRotation = (await get(docBase + '/board', owner.cookie)).json();
    assert.equal(
      (await post(docBase + '/page-action', { kind: 'rotate', clockwise: true }, owner.cookie))
        .statusCode,
      400,
    );
    const afterRejectedRotation = (await get(docBase + '/board', owner.cookie)).json();
    assert.equal(afterRejectedRotation.generation, beforeRejectedRotation.generation);
    assert.equal(afterRejectedRotation.state, beforeRejectedRotation.state);
    assert.equal(
      (await post(docBase + '/board/updates', { ...update, id: randomUUID() }, owner.cookie))
        .statusCode,
      409,
    );
    assert.equal(
      (
        await post(
          docBase + '/page-action',
          { kind: 'reorder', ids: [child, root.id] },
          owner.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await post(docBase + '/page-action', { kind: 'reorder', ids: [child, child] }, owner.cookie))
        .statusCode,
      400,
    );
    await post(
      base + '/workspace',
      { kind: 'document', documentId: root.id, expectedRevision: 0 },
      owner.cookie,
    );
    assert.equal(
      (await post(docBase + '/page-action', { kind: 'archive', archived: true }, owner.cookie))
        .statusCode,
      200,
    );
    assert.equal((await get(base + '/workspace', student.cookie)).json().documentId, child);
    assert.equal(
      (
        await post(
          base + '/documents/' + child + '/page-action',
          { kind: 'archive', archived: true },
          owner.cookie,
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await post(
          base + '/workspace',
          { kind: 'document', documentId: root.id, expectedRevision: 2 },
          owner.cookie,
        )
      ).statusCode,
      404,
    );
    await post(docBase + '/page-action', { kind: 'archive', archived: false }, owner.cookie);
    await post(
      docBase + '/page-action',
      { kind: 'bookmark', label: 'Important diagram' },
      owner.cookie,
    );
    assert.equal(
      (await get(docBase, owner.cookie)).json().document.page_bookmark,
      'Important diagram',
    );
    const grant = base + '/user-permissions/' + student.id;
    await post(
      grant,
      { isPresenter: true, canWhiteboard: true, canScreenShare: true },
      owner.cookie,
    );
    const view = (await get(docBase + '/board/view', student.cookie)).json();
    assert.equal(view.canPresent, true);
    const command = {
      generation: rotated.generation,
      revision: view.revision,
      operationId: randomUUID(),
      active: true,
      viewport: { centerX: 100, centerY: 200, zoom: 1 },
    };
    assert.equal((await post(docBase + '/board/view', command, student.cookie)).statusCode, 200);
    assert.equal((await get(docBase + '/board/view', owner.cookie)).json().active, true);
    await post(
      base + '/locks',
      { locks: { ...unlockedPolicy, whiteboard: true, screenShare: true }, expectedRevision: 0 },
      owner.cookie,
    );
    assert.equal((await get(docBase + '/board/view', student.cookie)).json().canPresent, false);
    assert.equal((await get(docBase + '/board/view', owner.cookie)).json().active, false);
    assert.equal(
      (
        await post(
          docBase + '/board/view',
          { ...command, revision: 1, operationId: randomUUID() },
          student.cookie,
        )
      ).statusCode,
      403,
    );
    await post(grant, { lockExempt: true }, owner.cookie);
    assert.equal((await get(docBase + '/board/view', student.cookie)).json().canPresent, true);
    await post(grant, { isPresenter: false }, owner.cookie);
    assert.equal((await get(docBase + '/board/view', student.cookie)).json().canPresent, false);
    assert.equal((await get('/platform/users', owner.cookie)).statusCode, 403);
    assert.equal(
      (
        await post(
          '/organizations/' + org.id + '/members',
          { userId: outsider.id, role: 'student' },
          owner.cookie,
        )
      ).statusCode,
      403,
    );
    await pool.query('INSERT INTO platform_admins(user_id) VALUES($1)', [owner.id]);
    const candidates = (await get('/platform/users?organizationId=' + org.id, owner.cookie)).json()
      .items;
    assert.ok(candidates.some((item: { id: string }) => item.id === outsider.id));
    assert.ok(!candidates.some((item: { id: string }) => item.id === student.id));
    assert.equal(
      (
        await post(
          '/organizations/' + org.id + '/members',
          { userId: outsider.id, role: 'student' },
          owner.cookie,
        )
      ).statusCode,
      201,
    );
  } finally {
    await app.close();
    await storage.cleanup();
    await cleanup();
  }
});
