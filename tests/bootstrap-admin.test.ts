import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './database';
import { bootstrapAdministrator } from '../scripts/bootstrap-admin';
import { buildApp } from '../apps/api/src/app';
test('initial administrator is created once, authenticates with six characters, closes registration and cannot hijack an existing account', async (t) => {
  if (process.env.TEST_DATABASE_ENGINE !== 'mysql') {
    t.skip('MySQL advisory lock');
    return;
  }
  const { pool, cleanup } = await testDatabase(),
    origin = 'http://localhost:5173';
  const app = await buildApp(pool, {
    origin,
    production: false,
    mediaUrl: '',
    mediaKey: '',
    mediaSecret: '',
  });
  try {
    const post = (path: string, payload: object) =>
      app.inject({ method: 'POST', url: '/api/v1' + path, headers: { origin }, payload });
    const user = await post('/auth/register', {
      email: 'existing@setup.test',
      password: '123456',
      name: 'Existing learner',
    });
    assert.equal(user.statusCode, 201);
    await assert.rejects(
      bootstrapAdministrator(pool, 'existing@setup.test', 'sixsix'),
      /already belongs/,
    );
    assert.equal((await pool.query('SELECT * FROM platform_admins')).rowCount, 0);
    const results = await Promise.all([
      bootstrapAdministrator(pool, 'admin@setup.test', 'sixsix'),
      bootstrapAdministrator(pool, 'other@setup.test', 'otherpassword'),
    ]);
    assert.equal(results.filter((v) => v.created).length, 1);
    const actual = (
      await pool.query(
        'SELECT email,password_hash FROM users WHERE id IN (SELECT user_id FROM platform_admins)',
      )
    ).rows;
    assert.equal(actual.length, 1);
    assert.ok(!actual[0].password_hash.includes('sixsix'));
    const password = actual[0].email === 'admin@setup.test' ? 'sixsix' : 'otherpassword';
    const login = await post('/auth/login', { email: actual[0].email, password });
    assert.equal(login.statusCode, 200, login.body);
    assert.equal(login.json().isPlatformAdmin, true);
    assert.equal(
      (
        await post('/auth/register', {
          email: 'after@setup.test',
          password: '123456',
          name: 'Blocked',
        })
      ).statusCode,
      403,
    );
    const before = (
      await pool.query('SELECT password_hash FROM users WHERE email=$1', [actual[0].email])
    ).rows[0].password_hash;
    assert.deepEqual(await bootstrapAdministrator(pool, actual[0].email, 'changedpassword'), {
      created: false,
    });
    assert.equal(
      (await pool.query('SELECT password_hash FROM users WHERE email=$1', [actual[0].email]))
        .rows[0].password_hash,
      before,
    );
    const settings = (await app.inject('/api/v1/app/settings')).json();
    assert.equal(settings.options.defaultLanguage, 'en');
    assert.equal(
      (
        await pool.query(
          "SELECT * FROM account_security_events WHERE action='platform_admin.bootstrapped'",
        )
      ).rowCount,
      1,
    );
  } finally {
    await app.close();
    await cleanup();
  }
});
