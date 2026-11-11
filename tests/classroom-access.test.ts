import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../apps/api/src/app';
import { testDatabase } from './database';

test('classroom enrollment scopes every role, filters the panel, protects administration and revokes active access', async () => {
  const { pool, cleanup } = await testDatabase();
  const origin = 'http://localhost:5173';
  const app = await buildApp(pool, {
    origin,
    production: false,
    mediaUrl: 'ws://localhost:7880',
    mediaKey: '',
    mediaSecret: '',
    mediaWorker: false,
    breakoutWorker: false,
  });
  const post = (path: string, body: object, cookie = '') =>
    app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: { origin, cookie },
      payload: body,
    });
  const get = (path: string, cookie: string) =>
    app.inject({ url: '/api/v1' + path, headers: { cookie } });
  try {
    const accounts = [];
    for (const name of ['owner', 'teacher', 'learner', 'other']) {
      const email = name + '@classroom-access.test',
        password = 'classroom-test-password';
      const created = await post('/auth/register', { name, email, password });
      assert.equal(created.statusCode, 201, created.body);
      const login = await post('/auth/login', { email, password });
      assert.equal(login.statusCode, 200);
      accounts.push({
        id: created.json().id,
        email,
        cookie: login.headers['set-cookie']!.toString().split(';')[0],
      });
    }
    const [owner, teacher, learner, other] = accounts;
    const created = await post('/organizations', { name: 'Scoped academy' }, owner.cookie);
    assert.equal(created.statusCode, 201);
    const org = created.json().id;
    for (const [account, role] of [
      [teacher, 'teacher'],
      [learner, 'student'],
      [other, 'student'],
    ] as const)
      assert.equal(
        (
          await post(
            '/organizations/' + org + '/members',
            { email: account.email, role },
            owner.cookie,
          )
        ).statusCode,
        201,
      );
    const create = async (name: string, memberIds: string[]) => {
      const response = await post(
        '/organizations/' + org + '/classrooms',
        { name, memberIds },
        owner.cookie,
      );
      assert.equal(response.statusCode, 201, response.body);
      return response.json().id as string;
    };
    const a = '/classrooms/' + (await create('First classroom', [teacher.id, learner.id]));
    const b = '/classrooms/' + (await create('Second classroom', [other.id]));
    const empty = '/classrooms/' + (await create('Private classroom', []));
    const listed = await get('/organizations/' + org + '/classrooms', learner.cookie);
    assert.deepEqual(
      listed.json().map((r: { name: string }) => r.name),
      ['First classroom'],
    );
    const finalRooms = await get('/organizations/' + org + '/classrooms', owner.cookie);
    assert.equal(finalRooms.statusCode, 200, finalRooms.body);
    assert.equal(finalRooms.json().length, 3);
    assert.equal(
      (await get('/organizations/' + org + '/classrooms', teacher.cookie)).json().length,
      1,
    );
    for (const suffix of [
      '',
      '/teaching',
      '/documents',
      '/files',
      '/presentations',
      '/messages',
      '/user-permissions',
      '/access',
    ])
      assert.equal((await get(b + suffix, learner.cookie)).statusCode, 403, suffix);
    assert.equal((await get(empty, other.cookie)).statusCode, 403);
    assert.equal(
      (
        await post(
          '/organizations/' + org + '/classrooms',
          { name: 'Forbidden creation' },
          teacher.cookie,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (await post(a + '/settings', { theme: 'studio-hybrid' }, teacher.cookie)).statusCode,
      403,
    );
    assert.equal(
      (await post(a + '/access', { memberIds: [other.id] }, teacher.cookie)).statusCode,
      403,
    );
    assert.equal((await post(a + '/session/start', {}, teacher.cookie)).statusCode, 201);
    assert.equal(
      (await post(a + '/notice', { pinnedNotice: 'Teacher announcement' }, teacher.cookie))
        .statusCode,
      200,
    );
    assert.equal(
      (await post(a + '/user-permissions/' + owner.id, { canCamera: false }, teacher.cookie))
        .statusCode,
      403,
    );
    assert.equal(
      (await post(a + '/user-permissions/' + teacher.id, { canCamera: false }, teacher.cookie))
        .statusCode,
      403,
    );
    assert.equal(
      (await post(a + '/user-permissions/' + learner.id, { canChat: false }, teacher.cookie))
        .statusCode,
      200,
    );
    assert.equal(
      (await post(a + '/messages', { body: 'Must be denied' }, learner.cookie)).statusCode,
      403,
    );
    const roster = await get(a + '/user-permissions', teacher.cookie);
    assert.equal(roster.statusCode, 200);
    assert.ok(!roster.json().members.some((m: { userId: string }) => m.userId === other.id));
    assert.equal(
      (
        await post(
          a + '/access',
          { enrollmentMode: 'assigned', memberIds: [teacher.id] },
          owner.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal((await get(a + '/documents', learner.cookie)).statusCode, 403);
    assert.equal(
      (await get('/organizations/' + org + '/classrooms', learner.cookie)).json().length,
      0,
    );
    const queued = await pool.query('SELECT kind,payload FROM media_commands WHERE user_id=$1', [
      learner.id,
    ]);
    assert.ok(
      queued.rows.some(
        (row) => row.kind === 'remove' && row.payload.reason === 'enrollment_revoked',
      ),
    );
    assert.equal(
      (
        await post(
          a + '/access',
          { enrollmentMode: 'assigned', memberIds: [teacher.id, learner.id] },
          owner.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal((await get(a, learner.cookie)).statusCode, 200);
    assert.equal(
      (await post(a + '/access', { enrollmentMode: 'organization', memberIds: [] }, owner.cookie))
        .statusCode,
      200,
    );
    assert.equal((await get(a, other.cookie)).statusCode, 200);
    const foreign = await post(
      '/organizations/' + org + '/classrooms',
      { name: 'Invalid roster', memberIds: ['00000000-0000-4000-8000-000000000001'] },
      owner.cookie,
    );
    assert.equal(foreign.statusCode, 400);
    const lastRooms = await get('/organizations/' + org + '/classrooms', owner.cookie);
    assert.equal(lastRooms.statusCode, 200, lastRooms.body);
    assert.equal(lastRooms.json().length, 3, lastRooms.body);
  } finally {
    await app.close();
    await cleanup();
  }
});
