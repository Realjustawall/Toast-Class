import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase, hasRealDatabase } from './database';
import { testStorage } from './storage-fixture';
import { testPng } from './file-fixtures';
import { buildApp } from '../apps/api/src/app';
test('chat has isolated rate budgets, idempotent sends, safe replay after clearing and default-denied image permissions', async () => {
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
  const post = (path: string, payload: object, cookie: string) =>
      app.inject({ method: 'POST', url: '/api/v1' + path, headers: { origin, cookie }, payload }),
    get = (path: string, cookie: string) =>
      app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
  const account = async (name: string) => {
    const email = name + '@chat-reliability.test',
      r = await post('/auth/register', { email, name, password: '123456' }, '');
    assert.equal(r.statusCode, 201);
    const login = await post('/auth/login', { email, password: '123456' }, '');
    return { id: r.json().id, email, cookie: String(login.headers['set-cookie']).split(';')[0] };
  };
  const upload = (base: string, cookie: string, purpose: string) => {
    const boundary = 'image-' + randomUUID(),
      bytes = testPng();
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
            '\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n',
        ),
        bytes,
        Buffer.from('\r\n--' + boundary + '--\r\n'),
      ]),
    });
  };
  try {
    const owner = await account('Teacher'),
      learner = await account('Learner'),
      org = (await post('/organizations', { name: 'Reliable chat' }, owner.cookie)).json();
    await post(
      '/organizations/' + org.id + '/members',
      { email: learner.email, role: 'student' },
      owner.cookie,
    );
    const room = (
        await post(
          '/organizations/' + org.id + '/classrooms',
          { name: 'Class', enrollmentMode: 'organization' },
          owner.cookie,
        )
      ).json(),
      base = '/classrooms/' + room.id;
    assert.equal((await upload(base, learner.cookie, 'chatImage')).statusCode, 403);
    assert.equal(
      (
        await post(
          base + '/user-permissions/' + learner.id,
          { canChatImages: true },
          learner.cookie,
        )
      ).statusCode,
      403,
    );
    for (let i = 0; i < 12; i++)
      assert.equal((await upload(base, owner.cookie, 'annotationImage')).statusCode, 201);
    const ownerImage = await upload(base, owner.cookie, 'chatImage');
    assert.equal(ownerImage.statusCode, 201);
    assert.equal(
      (
        await post(
          base + '/messages',
          { body: 'forbidden', imageFileId: ownerImage.json().id },
          learner.cookie,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (await post(base + '/user-permissions/' + learner.id, { canChatImages: true }, owner.cookie))
        .statusCode,
      200,
    );
    const image = await upload(base, learner.cookie, 'chatImage');
    assert.equal(image.statusCode, 201);
    const payload = {
      body: 'Only once',
      clientMessageId: randomUUID(),
      imageFileId: image.json().id,
    };
    // pg-mem does not implement SELECT FOR UPDATE transaction isolation.
    // Exercise simultaneous retries on the real MySQL/PostgreSQL fixtures.
    const responses = hasRealDatabase
      ? await Promise.all(
          Array.from({ length: 5 }, () => post(base + '/messages', payload, learner.cookie)),
        )
      : [];
    if (!hasRealDatabase)
      for (let i = 0; i < 5; i++)
        responses.push(await post(base + '/messages', payload, learner.cookie));
    for (const r of responses) assert.equal(r.statusCode, 201);
    assert.equal(new Set(responses.map((r) => r.json().id)).size, 1);
    assert.equal((await get(base + '/messages', owner.cookie)).json().length, 1);
    assert.equal(
      (await post(base + '/messages', { ...payload, body: 'Different content' }, learner.cookie))
        .statusCode,
      409,
    );
    assert.equal((await post(base + '/messages/clear', {}, owner.cookie)).statusCode, 200);
    assert.equal((await post(base + '/messages', payload, learner.cookie)).statusCode, 201);
    assert.equal((await get(base + '/messages', owner.cookie)).json().length, 0);
    await post(base + '/user-permissions/' + learner.id, { canChatImages: false }, owner.cookie);
    assert.equal((await upload(base, learner.cookie, 'chatImage')).statusCode, 403);
    assert.equal(
      (
        await post(
          base + '/messages',
          { ...payload, clientMessageId: randomUUID() },
          learner.cookie,
        )
      ).statusCode,
      403,
    );
    let exhausted = false;
    for (let i = 0; i < 610; i++) {
      const response = await get('/account', owner.cookie);
      if (response.statusCode === 429) {
        exhausted = true;
        break;
      }
      assert.equal(response.statusCode, 200);
    }
    assert.ok(exhausted, 'Unrelated API budget was exercised');
    assert.equal((await get(base + '/chat-categories', owner.cookie)).statusCode, 200);
    assert.equal(
      (await get(base + '/files/' + ownerImage.json().id + '/status', owner.cookie)).statusCode,
      200,
    );
    assert.equal(
      (await get(base + '/files/' + ownerImage.json().id + '/content', owner.cookie)).statusCode,
      200,
    );
    assert.equal((await get(base + '/messages', owner.cookie)).statusCode, 200);
    assert.equal(
      (
        await post(
          base + '/messages',
          { body: 'Text remains available', clientMessageId: randomUUID() },
          owner.cookie,
        )
      ).statusCode,
      201,
    );
    let accepted = 0;
    for (let i = 0; i < 181; i++) {
      const r = await post(
        base + '/messages',
        { body: 'Burst ' + i, clientMessageId: randomUUID() },
        learner.cookie,
      );
      if (r.statusCode === 429) {
        assert.ok(Number(r.headers['retry-after']) > 0);
        break;
      }
      assert.equal(r.statusCode, 201);
      accepted++;
    }
    assert.ok(
      accepted > 100 && accepted < 180,
      'Human bursts work while sustained spam is still bounded',
    );
  } finally {
    await app.close();
    await storage.cleanup();
    await cleanup();
  }
});
