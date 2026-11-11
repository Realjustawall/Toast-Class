import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../apps/api/src/app';
import { testDatabase, hasRealDatabase } from './database';
test('board books initialize idempotently and isolate persistent blank pages and fresh editing grants', async () => {
  const { pool, cleanup } = await testDatabase(),
    origin = 'http://localhost:5173';
  const app = await buildApp(pool, {
    origin,
    production: false,
    mediaUrl: '',
    mediaKey: '',
    mediaSecret: '',
  });
  const post = (path: string, data: unknown, cookie = '') =>
    app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: { origin, cookie },
      payload: data as object,
    });
  const get = (path: string, cookie: string) =>
    app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
  const account = async (name: string) => {
    const email = name + '@board-pages.test';
    const a = await post('/auth/register', { name, email, password: '123456' });
    assert.equal(a.statusCode, 201);
    const login = await post('/auth/login', { email, password: '123456' });
    return { id: a.json().id, email, cookie: String(login.headers['set-cookie']).split(';')[0] };
  };
  try {
    const a = await account('Moderator'),
      b = await account('Student');
    const org = (await post('/organizations', { name: 'Pages' }, a.cookie)).json();
    await post(
      '/organizations/' + org.id + '/members',
      { email: b.email, role: 'student' },
      a.cookie,
    );
    const room = (
        await post(
          '/organizations/' + org.id + '/classrooms',
          { name: 'Book', enrollmentMode: 'organization' },
          a.cookie,
        )
      ).json(),
      base = '/classrooms/' + room.id;
    const legacy = (
      await post(base + '/documents', { kind: 'board', name: 'Original legacy board' }, a.cookie)
    ).json();
    const root = (await post(base + '/board-book', {}, a.cookie)).json();
    assert.notEqual(root.id, legacy.id);
    assert.equal((await post(base + '/board-book', {}, a.cookie)).json().id, root.id);
    const path = base + '/documents/' + root.id + '/pages';
    assert.equal((await post(path, {}, b.cookie)).statusCode, 403);
    // pg-mem has no row-lock serialization; production concurrency is tested on MySQL.
    const pages = hasRealDatabase
      ? await Promise.all([post(path, {}, a.cookie), post(path, {}, a.cookie)])
      : [await post(path, {}, a.cookie), await post(path, {}, a.cookie)];
    assert.ok(pages.every((p) => p.statusCode === 201));
    assert.deepEqual(pages.map((p) => p.json().pageIndex).sort(), [2, 3]);
    for (const page of pages) {
      const state = await get(base + '/documents/' + page.json().id + '/board', a.cookie);
      assert.equal(state.statusCode, 200);
      assert.equal(state.json().revision, 0);
      assert.notEqual(
        state.json().generation,
        (await get(base + '/documents/' + root.id + '/board', a.cookie)).json().generation,
      );
    }
    await post(
      base + '/user-permissions/' + b.id,
      { canWhiteboard: true, isPresenter: true },
      a.cookie,
    );
    assert.equal((await post(path, {}, b.cookie)).statusCode, 201);
    await post(base + '/user-permissions/' + b.id, { interactionLocked: true }, a.cookie);
    assert.equal((await post(path, {}, b.cookie)).statusCode, 403);
    const other = (
      await post('/organizations/' + org.id + '/classrooms', { name: 'Other' }, a.cookie)
    ).json();
    assert.equal(
      (await post('/classrooms/' + other.id + '/documents/' + root.id + '/pages', {}, a.cookie))
        .statusCode,
      404,
    );
    assert.equal((await get(base + '/documents', a.cookie)).json().length, 5);
  } finally {
    await app.close();
    await cleanup();
  }
});
