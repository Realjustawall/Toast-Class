import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, hasRealDatabase } from './database';
import { buildApp } from '../apps/api/src/app';

test('six-character passwords, SQL-shaped data and platform-only registration lock', async () => {
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
      headers: { origin, cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(data),
    });
  const get = (path: string, cookie = '') =>
    app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
  try {
    assert.equal(
      (
        await post('/auth/register', {
          name: 'Short password',
          email: 'short@example.org',
          password: '12345',
        })
      ).statusCode,
      400,
    );
    const evilName = "x'); DROP TABLE users;--";
    assert.equal(
      (
        await post('/auth/register', {
          name: evilName,
          email: 'lock-admin@example.org',
          password: 'abc123',
          isPlatformAdmin: true,
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await post('/auth/register', {
          name: 'Other account',
          email: 'lock-other@example.org',
          password: 'def456',
        })
      ).statusCode,
      201,
    );
    const login = await post('/auth/login', {
      email: 'lock-admin@example.org',
      password: 'abc123',
    });
    assert.equal(login.statusCode, 200);
    assert.equal(login.json().name, evilName);
    assert.equal(login.json().isPlatformAdmin, false);
    const cookie = String(login.headers['set-cookie']).split(';')[0],
      uid = login.json().id;
    const other = String(
      (await post('/auth/login', { email: 'lock-other@example.org', password: 'def456' })).headers[
        'set-cookie'
      ],
    ).split(';')[0];
    assert.equal(
      (
        await post('/auth/login', {
          email: "lock-admin@example.org' OR '1'='1",
          password: 'abc123',
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await post('/auth/login', { email: 'lock-admin@example.org', password: "' OR 1=1--" }))
        .statusCode,
      401,
    );
    assert.equal(
      Number((await pool.query('SELECT COUNT(*) AS count FROM users')).rows[0].count),
      2,
    );
    const org = (await post('/organizations', { name: 'Local organization' }, cookie)).json().id;
    assert.ok(org);
    assert.equal((await get('/platform/registration', cookie)).statusCode, 403);
    assert.equal(
      (await post('/platform/registration', { open: false, expectedRevision: 0 }, cookie))
        .statusCode,
      403,
    );
    await pool.query('INSERT INTO platform_admins(user_id) VALUES($1)', [uid]);
    assert.equal((await get('/me', cookie)).json().isPlatformAdmin, true);
    assert.equal((await get('/auth/registration')).json().open, true);
    assert.equal(
      (await post('/platform/registration', { open: false, expectedRevision: 0 }, cookie))
        .statusCode,
      200,
    );
    assert.equal((await get('/auth/registration')).json().open, false);
    assert.equal((await get('/platform/registration', other)).statusCode, 403);
    assert.equal(
      (
        await post('/auth/register', {
          name: 'Blocked account',
          email: 'blocked@example.org',
          password: 'ghi789',
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await post('/auth/login', { email: 'lock-other@example.org', password: 'def456' }))
        .statusCode,
      200,
    );
    assert.equal(
      (await post('/platform/registration', { open: true, expectedRevision: 0 }, cookie))
        .statusCode,
      409,
    );
    assert.equal(
      (await post('/platform/registration', { open: true, expectedRevision: 1 }, cookie))
        .statusCode,
      200,
    );
    assert.equal((await get('/auth/registration')).json().open, true);
    const events = (await get('/account/security', cookie)).json();
    assert.ok(events.some((v: { action: string }) => v.action === 'registration.closed'));
    assert.ok(events.some((v: { action: string }) => v.action === 'registration.opened'));
  } finally {
    await app.close();
    await cleanup();
  }
});

test(
  'registration waits for an in-flight closure and does not use stale open state',
  { skip: !hasRealDatabase },
  async () => {
    const { pool, cleanup } = await testDatabase();
    const origin = 'http://localhost:5173';
    const app = await buildApp(pool, {
      origin,
      production: false,
      mediaUrl: '',
      mediaKey: '',
      mediaSecret: '',
    });
    const connection = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await connection.query('BEGIN');
      await connection.query(
        'UPDATE platform_settings SET registration_open=false,revision=revision+1 WHERE id=1',
      );
      let settled = false;
      const request = app
        .inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          headers: { origin },
          payload: {
            name: 'Concurrent applicant',
            email: 'concurrent@example.org',
            password: 'abc123',
          },
        })
        .then((response) => {
          settled = true;
          return response;
        });
      pending = request;
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(settled, false, 'signup must wait on the registration settings lock');
      await connection.query('COMMIT');
      assert.equal((await request).statusCode, 403);
      assert.equal(
        Number((await pool.query('SELECT COUNT(*) AS count FROM users')).rows[0].count),
        0,
      );
      assert.equal(
        Number(
          (await pool.query('SELECT COUNT(*) AS count FROM account_security_events')).rows[0].count,
        ),
        0,
      );
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
      await pending?.catch(() => {});
      await app.close();
      await cleanup();
    }
  },
);
