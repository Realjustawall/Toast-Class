import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { buildApp } from '../apps/api/src/app';
import { testDatabase } from './database';

test('classroom settings, individual revocation, notices, reactions and clearing chat persist with role boundaries', async () => {
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
  const get = (path: string, cookie = '') =>
    app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
  const account = async (email: string) => {
    const registered = await post('/auth/register', {
      email,
      name: email,
      password: 'test-password',
    });
    assert.equal(registered.statusCode, 201);
    const login = await post('/auth/login', { email, password: 'test-password' });
    return { id: registered.json().id, cookie: String(login.headers['set-cookie']).split(';')[0] };
  };
  try {
    const owner = await account('owner@controls.test');
    const student = await account('student@controls.test');
    const outsider = await account('outsider@controls.test');
    const org = (await post('/organizations', { name: 'Controls school' }, owner.cookie)).json();
    await post(
      `/organizations/${org.id}/members`,
      { email: 'student@controls.test', role: 'student' },
      owner.cookie,
    );
    const room = (
      await post(
        `/organizations/${org.id}/classrooms`,
        { enrollmentMode: 'organization', name: 'Controls classroom' },
        owner.cookie,
      )
    ).json();
    const base = `/classrooms/${room.id}`;
    const connection = await get('/connection');
    assert.equal(connection.json().status, 'ready');
    assert.equal(connection.headers['cache-control'], 'no-store');
    assert.equal((await get(base + '/user-permissions', student.cookie)).statusCode, 403);
    assert.equal((await get(base + '/user-permissions', outsider.cookie)).statusCode, 403);
    assert.equal(
      (await post(base + '/settings', { theme: 'immersive-glass' }, student.cookie)).statusCode,
      403,
    );
    for (const theme of ['classic-bbb', 'modular-skyroom', 'immersive-glass', 'studio-hybrid']) {
      assert.equal((await post(base + '/settings', { theme }, owner.cookie)).statusCode, 200);
      assert.equal((await get(base, student.cookie)).json().theme, theme);
    }
    assert.equal(
      (await post(base + '/notice', { externalMediaUrl: 'https://' }, owner.cookie)).statusCode,
      400,
    );
    assert.equal(
      (await post(base + '/notice', { externalMediaUrl: 'javascript:alert(1)' }, owner.cookie))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await post(
          base + '/notice',
          { pinnedNotice: 'پیام واقعی کلاس', externalMediaUrl: 'https://example.org/lesson' },
          owner.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await get(base + '/teaching', student.cookie)).json().pinnedNotice,
      'پیام واقعی کلاس',
    );
    await post(base + '/session/start', {}, owner.cookie);
    const permission = base + '/user-permissions/' + student.id;
    assert.equal(
      (
        await post(
          permission,
          { canChat: false, canRaiseHand: false, canWhiteboard: false },
          owner.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await post(base + '/messages', { body: 'denied' }, student.cookie)).statusCode,
      403,
    );
    assert.equal((await post(base + '/hand', { raised: true }, student.cookie)).statusCode, 403);
    const board = (
      await post(
        base + '/documents',
        { name: 'Collaborative board', kind: 'board', boardFormat: 'excalidraw' },
        owner.cookie,
      )
    ).json();
    const boardBase = base + '/documents/' + board.id + '/board';
    const state = (await get(boardBase, student.cookie)).json();
    assert.equal(
      state.canEdit,
      false,
      'Explicit user revocation must also restrict collaborative boards',
    );
    const update = {
      id: randomUUID(),
      generation: state.generation,
      update: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString('base64'),
    };
    assert.equal((await post(boardBase + '/updates', update, student.cookie)).statusCode, 403);
    const legacy = (
      await post(
        base + '/documents',
        { name: 'Basic board', kind: 'board', boardFormat: 'legacy' },
        owner.cookie,
      )
    ).json();
    assert.equal(
      (
        await post(
          base + '/documents/' + legacy.id + '/updates',
          { id: randomUUID(), update: update.update },
          student.cookie,
        )
      ).statusCode,
      403,
    );
    await post(
      permission,
      { canChat: null, canRaiseHand: null, canWhiteboard: null },
      owner.cookie,
    );
    assert.equal((await get(boardBase, student.cookie)).json().canEdit, false);
    assert.equal(
      (await post(base + '/messages', { body: 'persisted message' }, student.cookie)).statusCode,
      201,
    );
    assert.equal((await post(base + '/messages/clear', {}, student.cookie)).statusCode, 403);
    assert.equal((await post(base + '/messages/clear', {}, owner.cookie)).statusCode, 200);
    assert.deepEqual((await get(base + '/messages', student.cookie)).json(), []);
    assert.equal(
      (await post(base + '/status', { status: 'agree' }, student.cookie)).statusCode,
      200,
    );
    assert.equal(
      (await post(base + '/status', { clearAll: true }, student.cookie)).statusCode,
      403,
    );
    assert.equal((await get(base + '/teaching', owner.cookie)).json().statuses[0].status, 'agree');
    await post(base + '/status', { clearAll: true }, owner.cookie);
    assert.deepEqual((await get(base + '/teaching', student.cookie)).json().statuses, []);
    await post(permission, { kicked: true }, owner.cookie);
    assert.equal((await get(base + '/teaching', student.cookie)).statusCode, 403);
    await post(permission, { kicked: false }, owner.cookie);
    assert.equal((await get(base + '/teaching', student.cookie)).statusCode, 200);
    await post(base + '/settings', { permissions: { locked: true } }, owner.cookie);
    assert.equal((await get(base, student.cookie)).statusCode, 403);
    await post(base + '/settings', { permissions: { locked: false } }, owner.cookie);
    assert.equal((await get(base, student.cookie)).statusCode, 200);
  } finally {
    await app.close();
    await cleanup();
  }
});
