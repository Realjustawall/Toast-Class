import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { buildApp } from '../apps/api/src/app';
import { testDatabase } from './database';
import { testStorage } from './storage-fixture';
import { testPng } from './file-fixtures';
import { FileService } from '../apps/api/src/files';
import { DEFAULT_PLATFORM_OPTIONS } from '../packages/classroom-settings/schema';
test('image grants and reversible participant locks are enforced on upload, posting, ownership and board writes', async () => {
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
  const post = (path: string, data: unknown, cookie = '') =>
    app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: { origin, cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(data),
    });
  const get = (path: string, cookie: string) =>
    app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
  const account = async (name: string) => {
    const email = name + '@chat-images.test',
      password = '123456';
    const created = await post('/auth/register', { name, email, password });
    assert.equal(created.statusCode, 201);
    const login = await post('/auth/login', { email, password });
    return {
      id: created.json().id,
      email,
      cookie: String(login.headers['set-cookie']).split(';')[0],
    };
  };
  const upload = (
    base: string,
    cookie: string,
    name = 'photo.png',
    bytes = testPng(),
    purpose = 'chatImage',
  ) => {
    const boundary = 'toaster-' + randomUUID();
    return app.inject({
      method: 'POST',
      url: '/api/v1' + base + '/files?' + purpose + '=1',
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
    const owner = await account('owner'),
      learner = await account('learner'),
      peer = await account('peer');
    const org = (await post('/organizations', { name: 'Image grants' }, owner.cookie)).json();
    for (const user of [learner, peer])
      assert.equal(
        (
          await post(
            '/organizations/' + org.id + '/members',
            { email: user.email, role: 'student' },
            owner.cookie,
          )
        ).statusCode,
        201,
      );
    const room = (
      await post(
        '/organizations/' + org.id + '/classrooms',
        { name: 'Main', enrollmentMode: 'organization' },
        owner.cookie,
      )
    ).json();
    const other = (
      await post('/organizations/' + org.id + '/classrooms', { name: 'Other' }, owner.cookie)
    ).json();
    const base = '/classrooms/' + room.id,
      permission = base + '/user-permissions/' + learner.id;
    assert.equal((await upload(base, learner.cookie)).statusCode, 403);
    assert.equal((await post(permission, { canChatImages: true }, learner.cookie)).statusCode, 403);
    const adminPhoto = await upload(base, owner.cookie);
    assert.equal(adminPhoto.statusCode, 201);
    assert.equal(adminPhoto.json().status, 'ready');
    assert.equal(
      (
        await post(
          base + '/messages',
          { body: '', imageFileId: adminPhoto.json().id },
          owner.cookie,
        )
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await post(
          permission,
          { canChatImages: true, canWhiteboard: true, canMicrophone: false },
          owner.cookie,
        )
      ).statusCode,
      200,
    );
    const image = await upload(base, learner.cookie);
    assert.equal(image.statusCode, 201);
    const sent = await post(
      base + '/messages',
      { body: 'caption', imageFileId: image.json().id },
      learner.cookie,
    );
    assert.equal(sent.statusCode, 201);
    // A previously uploaded image must also obey a subsequently lowered limit.
    await pool.query('UPDATE files SET byte_size=$1 WHERE id=$2', [
      2 * 1024 * 1024,
      image.json().id,
    ]);
    await pool.query('UPDATE platform_settings SET options_json=$1 WHERE id=1', [
      JSON.stringify({ ...DEFAULT_PLATFORM_OPTIONS, chatImageMaxMiB: 1 }),
    ]);
    assert.equal(
      (
        await post(
          base + '/messages',
          { body: 'Old upload after limit change', imageFileId: image.json().id },
          learner.cookie,
        )
      ).statusCode,
      400,
    );
    await pool.query('UPDATE files SET byte_size=$1 WHERE id=$2', [
      testPng().length,
      image.json().id,
    ]);
    await pool.query('UPDATE platform_settings SET options_json=NULL WHERE id=1');
    assert.equal(
      (
        await post(
          base + '/messages',
          { body: 'forged image', imageFileId: adminPhoto.json().id },
          learner.cookie,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          '/classrooms/' + other.id + '/messages',
          { body: 'wrong class', imageFileId: image.json().id },
          owner.cookie,
        )
      ).statusCode,
      404,
    );
    assert.equal((await upload(base, peer.cookie)).statusCode, 403);
    assert.equal(
      (await upload(base, learner.cookie, 'evil.svg', Buffer.from('<svg onload="alert(1)"></svg>')))
        .statusCode,
      400,
    );
    const content = await get(base + '/files/' + image.json().id + '/content', peer.cookie);
    assert.equal(content.statusCode, 200);
    assert.match(String(content.headers['content-type']), /^image\/png/);
    assert.equal(content.rawPayload.length, testPng().length);
    const listed = (await get(base + '/messages', learner.cookie)).json();
    assert.ok(
      listed.some(
        (message: { image_file_id: string }) => message.image_file_id === image.json().id,
      ),
    );
    const board = (
      await post(base + '/documents', { name: 'Public board', kind: 'board' }, owner.cookie)
    ).json();
    const ydoc = new Y.Doc();
    const update = Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64');
    ydoc.destroy();
    assert.equal(
      (await post(permission, { interactionLocked: true, isPresenter: true }, owner.cookie))
        .statusCode,
      200,
    );
    const locked = (await get(base + '/teaching', learner.cookie)).json().myPermissions;
    for (const field of [
      'canChat',
      'canChatImages',
      'canWhiteboard',
      'canMicrophone',
      'canCamera',
      'canScreenShare',
      'canRaiseHand',
      'isPresenter',
    ])
      assert.equal(locked[field], false, field);
    assert.equal(
      (await post(base + '/messages', { body: 'locked' }, learner.cookie)).statusCode,
      403,
    );
    assert.equal((await upload(base, learner.cookie)).statusCode, 403);
    assert.equal(
      (
        await post(
          base + '/documents/' + board.id + '/updates',
          { id: randomUUID(), update },
          learner.cookie,
        )
      ).statusCode,
      403,
    );
    const notes = (
      await post(base + '/documents', { name: 'Shared notes', kind: 'notes' }, owner.cookie)
    ).json();
    assert.equal(
      (
        await post(
          base + '/documents/' + notes.id + '/updates',
          { id: randomUUID(), update },
          learner.cookie,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (await post(permission, { interactionLocked: false, isPresenter: false }, owner.cookie))
        .statusCode,
      200,
    );
    const unlocked = (await get(base + '/teaching', learner.cookie)).json().myPermissions;
    assert.equal(unlocked.canChatImages, true);
    assert.equal(unlocked.canMicrophone, false);
    assert.equal(
      (
        await post(
          base + '/documents/' + board.id + '/updates',
          { id: randomUUID(), update },
          learner.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await post(base + '/user-permissions-bulk', { interactionLocked: true }, owner.cookie))
        .statusCode,
      200,
    );
    assert.equal(
      (await get(base + '/teaching', peer.cookie)).json().myPermissions.interactionLocked,
      true,
    );
    assert.equal(
      (await post(base + '/user-permissions-bulk', { interactionLocked: false }, owner.cookie))
        .statusCode,
      200,
    );
    assert.equal((await post(permission, { canChatImages: false }, owner.cookie)).statusCode, 200);
    assert.equal(
      (
        await post(
          base + '/messages',
          { body: 'revoked', imageFileId: image.json().id },
          learner.cookie,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (await get(base + '/files/' + image.json().id + '/status', peer.cookie)).statusCode,
      404,
    );
    assert.equal(
      (await get(base + '/files/' + image.json().id + '/status', learner.cookie)).statusCode,
      200,
    );
    const advanced = (
      await post(
        base + '/documents',
        { name: 'PDF page', kind: 'board', boardFormat: 'excalidraw' },
        owner.cookie,
      )
    ).json();
    const background = await upload(base, owner.cookie, 'page.png', testPng(), 'boardImage');
    assert.equal(background.statusCode, 201);
    const backgroundPath = base + '/documents/' + advanced.id + '/background';
    assert.equal(
      (await upload(base, learner.cookie, 'forbidden.png', testPng(), 'boardImage')).statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          backgroundPath,
          { fileId: background.json().id, width: 100, height: 200 },
          learner.cookie,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          backgroundPath,
          { fileId: adminPhoto.json().id, width: 100, height: 200 },
          owner.cookie,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await post(
          backgroundPath,
          { fileId: background.json().id, width: 100, height: 200 },
          owner.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await post(
          backgroundPath,
          { fileId: background.json().id, width: 200, height: 200 },
          owner.cookie,
        )
      ).statusCode,
      409,
    );
    const imported = (
      await post(
        '/classrooms/' + other.id + '/documents',
        { name: 'Imported PDF page', kind: 'board', boardFormat: 'excalidraw' },
        owner.cookie,
      )
    ).json();
    await pool.query(
      'UPDATE collaborative_documents SET background_file_id=$1,background_width=100,background_height=200 WHERE id=$2',
      [background.json().id, imported.id],
    );
    const importedContent =
      '/classrooms/' + other.id + '/files/' + background.json().id + '/content';
    assert.equal((await get(importedContent, owner.cookie)).statusCode, 404);
    assert.equal(
      (await get(importedContent + '?documentId=' + advanced.id, owner.cookie)).statusCode,
      404,
    );
    assert.equal(
      (await get(importedContent + '?documentId=' + imported.id, owner.cookie)).statusCode,
      200,
    );
    assert.equal(
      (await get(importedContent + '?documentId=' + imported.id, peer.cookie)).statusCode,
      403,
    );
    const abandoned = await upload(base, owner.cookie);
    assert.equal(abandoned.statusCode, 201);
    await pool.query('UPDATE files SET created_at=$1 WHERE classroom_id=$2', [
      new Date(Date.now() - 2 * 86400000),
      room.id,
    ]);
    await new FileService(pool, {
      storage: storage.storage,
      allowUnscanned: true,
      worker: false,
    }).sweep();
    for (const id of [image.json().id, adminPhoto.json().id, background.json().id])
      assert.equal(
        (await pool.query('SELECT status FROM files WHERE id=$1', [id])).rows[0].status,
        'ready',
      );
    assert.equal(
      (await pool.query('SELECT status FROM files WHERE id=$1', [abandoned.json().id])).rows[0]
        .status,
      'failed',
    );
  } finally {
    await app.close();
    await cleanup();
    await storage.cleanup();
  }
});
