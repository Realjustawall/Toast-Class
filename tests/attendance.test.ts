import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import { buildApp } from '../apps/api/src/app';
import { testDatabase } from './database';
import { attendanceDuration } from '../apps/api/src/attendance';
test('attendance merges intervals without counting missing joins or duplicate connections', () => {
  const d = (v: number) => new Date(v);
  assert.equal(
    attendanceDuration(
      [
        { joined_at: d(1000), left_at: d(5000) },
        { joined_at: d(3000), left_at: d(6000) },
        { joined_at: d(8000), left_at: null },
      ],
      10000,
    ),
    7000,
  );
  assert.equal(
    attendanceDuration(
      [
        { joined_at: null, left_at: d(5000) },
        { joined_at: d(7000), left_at: d(6000) },
      ],
      10000,
    ),
    0,
  );
});
test('signed media webhook attendance, replay protection and tenant privacy', async () => {
  const { pool, cleanup } = await testDatabase();
  const key = 'test-media-key',
    secret = 'test-media-secret-that-is-long-enough';
  const origin = 'http://localhost:5173';
  const app = await buildApp(pool, {
    origin,
    production: false,
    mediaKey: key,
    mediaSecret: secret,
    mediaUrl: '',
  });
  const post = (path: string, payload: unknown, cookie = '') =>
    app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: { origin, cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
  const get = (path: string, cookie: string) =>
    app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
  async function account(email: string) {
    await post('/auth/register', { email, name: email, password: 'attendance-test-password' });
    const login = await post('/auth/login', { email, password: 'attendance-test-password' });
    return { cookie: String(login.headers['set-cookie']).split(';')[0], id: login.json().id };
  }
  async function webhook(body: unknown) {
    const raw = JSON.stringify(body);
    const token = new AccessToken(key, secret, { ttl: 120 });
    token.sha256 = createHash('sha256').update(raw).digest('base64');
    return app.inject({
      method: 'POST',
      url: '/api/v1/media/webhook',
      headers: { 'content-type': 'application/webhook+json', authorization: await token.toJwt() },
      payload: raw,
    });
  }
  try {
    const owner = await account('owner@attendance.test'),
      student = await account('student@attendance.test'),
      other = await account('other@attendance.test');
    const org = (await post('/organizations', { name: 'Attendance org' }, owner.cookie)).json().id;
    await post(
      '/organizations/' + org + '/members',
      { email: 'student@attendance.test', role: 'student' },
      owner.cookie,
    );
    const room = (
      await post(
        '/organizations/' + org + '/classrooms',
        { enrollmentMode: 'organization', name: 'Observed attendance' },
        owner.cookie,
      )
    ).json().id;
    await post('/classrooms/' + room + '/session/start', {}, owner.cookie);
    const now = Math.floor(Date.now() / 1000),
      join = {
        event: 'participant_joined',
        id: randomUUID(),
        createdAt: now - 30,
        room: { name: room },
        participant: { sid: 'PA_connection1', identity: student.id },
      };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/media/webhook',
          headers: { 'content-type': 'application/webhook+json' },
          payload: JSON.stringify(join),
        })
      ).statusCode,
      401,
    );
    assert.equal((await webhook(join)).statusCode, 200);
    assert.equal((await webhook(join)).json().duplicate, true);
    assert.equal((await webhook({ ...join, createdAt: now - 20 })).statusCode, 409);
    const leave = { ...join, event: 'participant_left', id: randomUUID(), createdAt: now - 10 };
    assert.equal((await webhook(leave)).statusCode, 200);
    const report = (await get('/classrooms/' + room + '/attendance', owner.cookie)).json();
    assert.equal(report.participants.length, 1);
    assert.equal(report.participants[0].totalDurationMs, 20000);
    assert.equal(report.participants[0].connections.length, 1);
    assert.equal(
      (await get('/classrooms/' + room + '/attendance', student.cookie)).statusCode,
      403,
    );
    assert.equal((await get('/classrooms/' + room + '/attendance', other.cookie)).statusCode, 403);
    // A leave arriving before its corresponding join is retained without invented join time.
    const second = {
      ...join,
      id: randomUUID(),
      participant: { sid: 'PA_connection2', identity: student.id },
      createdAt: now - 5,
    };
    await webhook({ ...second, event: 'participant_left', id: randomUUID(), createdAt: now });
    await webhook(second);
    assert.equal(
      (await get('/classrooms/' + room + '/attendance', owner.cookie)).json().participants[0]
        .totalDurationMs,
      25000,
    );
    const state = (await get('/classrooms/' + room + '/teaching', owner.cookie)).json();
    assert.ok(report.participants[0].connections[0].session_id === state.session.id);
  } finally {
    await app.close();
    await cleanup();
  }
});
