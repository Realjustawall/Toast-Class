import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../apps/api/src/app';
import { testDatabase } from './database';

test('message ownership, moderator access, conflicts and cross-classroom isolation', async () => {
  const { pool, cleanup } = await testDatabase();
  const origin = 'http://localhost:5173';
  const app = await buildApp(pool, {
    origin,
    production: false,
    mediaUrl: '',
    mediaKey: '',
    mediaSecret: '',
  });
  const post = (path: string, payload: unknown, cookie = '') =>
    app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: { origin, cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
  const account = async (name: string) => {
    const email = name + '@chat.test',
      password = 'test-password-chat';
    const r = await post('/auth/register', { email, password, name });
    assert.equal(r.statusCode, 201);
    const login = await post('/auth/login', { email, password });
    return { id: r.json().id, cookie: String(login.headers['set-cookie']).split(';')[0], email };
  };
  try {
    const owner = await account('owner'),
      a = await account('alice'),
      b = await account('bob');
    const org = (await post('/organizations', { name: 'Chat test' }, owner.cookie)).json();
    for (const u of [a, b])
      assert.equal(
        (
          await post(
            `/organizations/${org.id}/members`,
            { email: u.email, role: 'student' },
            owner.cookie,
          )
        ).statusCode,
        201,
      );
    const room = (
      await post(
        `/organizations/${org.id}/classrooms`,
        { name: 'Chat', enrollmentMode: 'organization' },
        owner.cookie,
      )
    ).json();
    const other = (
      await post(
        `/organizations/${org.id}/classrooms`,
        { name: 'Other', enrollmentMode: 'organization' },
        owner.cookie,
      )
    ).json();
    const base = `/classrooms/${room.id}/messages`;
    const id = (await post(base, { body: 'original' }, a.cookie)).json().id;
    assert.equal(
      (await post(`${base}/${id}/edit`, { body: 'forged', expectedBody: 'original' }, b.cookie))
        .statusCode,
      403,
    );
    assert.equal((await post(`${base}/${id}/delete`, {}, b.cookie)).statusCode, 403);
    assert.equal(
      (await post(`/classrooms/${other.id}/messages/${id}/delete`, {}, owner.cookie)).statusCode,
      404,
    );
    assert.equal(
      (await post(`${base}/${id}/edit`, { body: 'edited', expectedBody: 'original' }, a.cookie))
        .statusCode,
      200,
    );
    assert.equal(
      (await post(`${base}/${id}/edit`, { body: 'stale', expectedBody: 'original' }, a.cookie))
        .statusCode,
      409,
    );
    assert.equal(
      (
        await post(
          `${base}/${id}/edit`,
          { body: 'moderated', expectedBody: 'edited' },
          owner.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await post(`${base}/${id}/edit`, { body: ' ', expectedBody: 'moderated' }, a.cookie))
        .statusCode,
      400,
    );
    assert.equal((await post(base + '/clear', {}, a.cookie)).statusCode, 403);
    assert.equal((await post(`${base}/${id}/delete`, {}, a.cookie)).statusCode, 200);
    assert.equal((await post(`${base}/${id}/delete`, {}, owner.cookie)).statusCode, 404);
    const next = (await post(base, { body: 'remove by staff' }, b.cookie)).json().id;
    assert.equal((await post(`${base}/${next}/delete`, {}, owner.cookie)).statusCode, 200);
  } finally {
    await app.close();
    await cleanup();
  }
});
