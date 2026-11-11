import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './database';
import { buildApp } from '../apps/api/src/app';

test('account preferences, cookie lifetime, private devices, revocation and password security persist', async () => {
  const { pool, cleanup } = await testDatabase();
  const origin = 'http://localhost:5173',
    config = { origin, production: false, mediaUrl: '', mediaKey: '', mediaSecret: '' };
  const app = await buildApp(pool, config);
  const post = (path: string, data: unknown, cookie = '') =>
    app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: {
        origin,
        cookie,
        'content-type': 'application/json',
        'user-agent': 'TOASTER account test',
      },
      payload: JSON.stringify(data),
    });
  const get = (path: string, cookie: string) =>
    app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
  const login = async (email: string, password = 'account-test-password', remember = true) => {
    const r = await post('/auth/login', { email, password, remember });
    assert.equal(r.statusCode, 200, r.body);
    return {
      cookie: String(r.headers['set-cookie']).split(';')[0],
      raw: String(r.headers['set-cookie']),
    };
  };
  try {
    assert.equal(
      (
        await post('/auth/register', {
          name: 'Invalid confirmation',
          email: 'mismatch@example.org',
          password: 'account-test-password',
          passwordConfirmation: 'different-password',
        })
      ).statusCode,
      400,
    );
    for (const email of ['account-a@example.org', 'account-b@example.org'])
      assert.equal(
        (await post('/auth/register', { name: email, email, password: 'account-test-password' }))
          .statusCode,
        201,
      );
    const first = await login('account-a@example.org'),
      second = await login('account-a@example.org', 'account-test-password', false),
      other = await login('account-b@example.org');
    assert.match(first.raw, /Max-Age=604800/);
    assert.doesNotMatch(second.raw, /Max-Age=/);
    const profile = (await get('/account', first.cookie)).json();
    assert.equal(profile.password_hash, undefined);
    assert.equal(
      (
        await post(
          '/account/profile',
          { name: 'Changed', locale: 'en', timezone: 'Unknown/Place' },
          first.cookie,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await post(
          '/account/profile',
          { name: 'Changed', locale: 'en', timezone: 'UTC', role: 'owner' },
          first.cookie,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await post(
          '/account/profile',
          { name: 'Updated account', locale: 'en', timezone: 'UTC' },
          first.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal((await get('/account', second.cookie)).json().name, 'Updated account');
    assert.equal((await get('/account', other.cookie)).json().name, 'account-b@example.org');
    const sessions = (await get('/account/sessions', first.cookie)).json();
    assert.equal(sessions.length, 2);
    assert.equal(sessions.filter((s: { current: boolean }) => s.current).length, 1);
    assert.ok(sessions.every((s: Record<string, unknown>) => s.token_hash === undefined));
    const remote = sessions.find((s: { current: boolean }) => !s.current);
    assert.equal(
      (await post('/account/sessions/' + remote.id + '/revoke', {}, other.cookie)).statusCode,
      404,
    );
    assert.equal(
      (
        await post(
          '/account/password',
          { currentPassword: 'incorrect-password', newPassword: 'new-account-password' },
          first.cookie,
        )
      ).statusCode,
      401,
    );
    assert.equal((await get('/me', second.cookie)).statusCode, 200);
    assert.equal(
      (
        await post(
          '/account/password',
          { currentPassword: 'account-test-password', newPassword: 'new-account-password' },
          first.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal((await get('/me', first.cookie)).statusCode, 200);
    assert.equal((await get('/me', second.cookie)).statusCode, 401);
    assert.equal(
      (
        await post('/auth/login', {
          email: 'account-a@example.org',
          password: 'account-test-password',
        })
      ).statusCode,
      401,
    );
    const latest = await login('account-a@example.org', 'new-account-password');
    const list = (await get('/account/sessions', first.cookie)).json();
    const target = list.find((s: { current: boolean }) => !s.current);
    assert.equal(
      (await post('/account/sessions/' + target.id + '/revoke', {}, first.cookie)).statusCode,
      200,
    );
    assert.equal((await get('/me', latest.cookie)).statusCode, 401);
    const again = await login('account-a@example.org', 'new-account-password');
    assert.equal(
      (await post('/account/sessions/revoke-others', {}, first.cookie)).json().revoked,
      1,
    );
    assert.equal((await get('/me', again.cookie)).statusCode, 401);
    const security = (await get('/account/security', first.cookie)).json();
    assert.ok(security.some((e: { action: string }) => e.action === 'password.changed'));
    assert.equal(
      (await get('/account/security', other.cookie))
        .json()
        .some((e: { action: string }) => e.action === 'password.changed'),
      false,
    );
    const stored = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [profile.id]))
      .rows[0].password_hash;
    assert.ok(!stored.includes('new-account-password'));
    const current = (await get('/account/sessions', first.cookie))
      .json()
      .find((s: { current: boolean }) => s.current);
    assert.equal(
      (await post('/account/sessions/' + current.id + '/revoke', {}, first.cookie)).json().current,
      true,
    );
    assert.equal((await get('/account', first.cookie)).statusCode, 401);
  } finally {
    await app.close();
    await cleanup();
  }
});
