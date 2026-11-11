import { testDatabase } from './database';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { newDb } from 'pg-mem';
import type pg from 'pg';
import { buildApp } from '../apps/api/src/app.js';
const { pool, cleanup } = await testDatabase();
const origin = 'http://localhost:5173';
const app = await buildApp(pool, {
  origin,
  production: false,
  mediaUrl: 'ws://localhost:7880',
  mediaKey: 'test-key',
  mediaSecret: 'test-secret-that-is-long-enough-for-tests',
});

after(async () => {
  await app.close();
  await cleanup();
});
async function post(path: string, payload: unknown, cookie = '') {
  return app.inject({
    method: 'POST',
    url: '/api/v1' + path,
    headers: { origin, cookie, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}
async function get(path: string, cookie = '') {
  return app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
}
async function account(email: string) {
  assert.equal(
    (
      await post('/auth/register', {
        email,
        name: email.split('@')[0],
        password: 'safe-test-password-123',
      })
    ).statusCode,
    201,
  );
  const r = await post('/auth/login', { email, password: 'safe-test-password-123' });
  assert.equal(r.statusCode, 200);
  return { cookie: r.headers['set-cookie']!.toString().split(';')[0], user: r.json() };
}
test('foundation security and persistence workflow', async (t) => {
  const owner = await account('teacher@example.org');
  const student = await account('student@example.org');
  const stranger = await account('outsider@example.org');
  let orgId = '',
    roomId = '';
  await t.test('HttpOnly cookie and hashed credentials', async () => {
    const login = await post('/auth/login', {
      email: 'teacher@example.org',
      password: 'safe-test-password-123',
    });
    assert.match(String(login.headers['set-cookie']), /HttpOnly/);
    assert.match(String(login.headers['set-cookie']), /SameSite=Strict/);
    const rows = (await pool.query('SELECT password_hash FROM users')).rows;
    assert.ok(rows.every((r) => !r.password_hash.includes('safe-test')));
    const tokens = (await pool.query('SELECT token_hash FROM auth_sessions')).rows;
    assert.ok(tokens.every((r) => /^[a-f0-9]{64}$/.test(r.token_hash)));
  });
  await t.test('authentication and input validation', async () => {
    assert.equal((await get('/organizations')).statusCode, 401);
    assert.equal(
      (await post('/auth/login', { email: 'teacher@example.org', password: 'wrong-password' }))
        .statusCode,
      401,
    );
    assert.equal((await post('/organizations', { name: 'x' }, owner.cookie)).statusCode, 400);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/organizations',
          headers: { cookie: owner.cookie },
          payload: { name: 'CSRF' },
        })
      ).statusCode,
      403,
    );
  });
  await t.test('organization creation grants only its creator owner membership', async () => {
    const r = await post('/organizations', { name: 'Learning laboratory' }, owner.cookie);
    assert.equal(r.statusCode, 201);
    orgId = r.json().id;
    assert.equal((await get('/organizations', stranger.cookie)).json().length, 0);
    assert.equal((await get('/organizations', owner.cookie)).json()[0].role, 'owner');
  });
  await t.test('cross-tenant room access denied', async () => {
    assert.equal(
      (await get('/organizations/' + orgId + '/classrooms', stranger.cookie)).statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          '/organizations/' + orgId + '/classrooms',
          { enrollmentMode: 'organization', name: 'Unauthorized' },
          stranger.cookie,
        )
      ).statusCode,
      403,
    );
  });
  await t.test('owner adds student and creates persisted classroom', async () => {
    assert.equal(
      (
        await post(
          '/organizations/' + orgId + '/members',
          { email: 'student@example.org', role: 'student' },
          owner.cookie,
        )
      ).statusCode,
      201,
    );
    const r = await post(
      '/organizations/' + orgId + '/classrooms',
      { enrollmentMode: 'organization', name: 'Distributed systems' },
      owner.cookie,
    );
    assert.equal(r.statusCode, 201);
    roomId = r.json().id;
    assert.equal(
      (await get('/organizations/' + orgId + '/classrooms', student.cookie)).json()[0].name,
      'Distributed systems',
    );
  });
  await t.test('student cannot create rooms or escalate membership', async () => {
    assert.equal(
      (
        await post(
          '/organizations/' + orgId + '/classrooms',
          { enrollmentMode: 'organization', name: 'Escalation' },
          student.cookie,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          '/organizations/' + orgId + '/members',
          { email: 'outsider@example.org', role: 'teacher' },
          student.cookie,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          '/organizations/' + orgId + '/members',
          { email: 'outsider@example.org', role: 'owner' },
          owner.cookie,
        )
      ).statusCode,
      400,
    );
  });
  await t.test('join token bound to server-selected identity and room', async () => {
    await post('/classrooms/' + roomId + '/session/start', {}, owner.cookie);
    const r = await post(
      '/classrooms/' + roomId + '/join',
      { identity: 'forged', room: 'forged' },
      student.cookie,
    );
    assert.equal(r.statusCode, 200);
    const claims = JSON.parse(Buffer.from(r.json().token.split('.')[1], 'base64url').toString());
    assert.equal(claims.sub, student.user.id);
    assert.equal(claims.video.room, 'toaster-' + JSON.parse(claims.metadata).sessionId);
    assert.equal(JSON.parse(claims.metadata).classroomId, roomId);
    assert.equal(claims.video.roomJoin, true);
    assert.equal(claims.video.canPublishData, false);
    assert.ok(claims.exp - claims.nbf <= 120);
    assert.equal(
      (await post('/classrooms/' + roomId + '/join', {}, stranger.cookie)).statusCode,
      403,
    );
  });
  await t.test('chat persists and is isolated by organization', async () => {
    assert.equal(
      (await post('/classrooms/' + roomId + '/messages', { body: 'سلام — hello' }, student.cookie))
        .statusCode,
      201,
    );
    const messages = (await get('/classrooms/' + roomId + '/messages', owner.cookie)).json();
    assert.equal(messages[0].body, 'سلام — hello');
    assert.equal(
      (await get('/classrooms/' + roomId + '/messages', stranger.cookie)).statusCode,
      403,
    );
    assert.equal(
      (await post('/classrooms/' + roomId + '/messages', { body: ' ' }, student.cookie)).statusCode,
      400,
    );
    assert.equal(
      (
        await post(
          '/classrooms/' + roomId + '/messages',
          { body: 'x'.repeat(2001) },
          student.cookie,
        )
      ).statusCode,
      400,
    );
  });
  await t.test('privileged changes emit audit events', async () => {
    const actions = (await pool.query('SELECT action FROM audit_logs')).rows.map((r) => r.action);
    for (const a of ['organization.created', 'member.added', 'classroom.created'])
      assert.ok(actions.includes(a));
  });
  await t.test('logout revokes cookie server-side', async () => {
    assert.equal((await post('/auth/logout', {}, student.cookie)).statusCode, 200);
    assert.equal((await get('/me', student.cookie)).statusCode, 401);
  });
});
