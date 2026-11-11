import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { testDatabase } from './database';

test('authenticated classmates behind one IP have independent limits and forged cookies remain unauthorized', async () => {
  const { pool, cleanup } = await testDatabase();
  const app = await buildApp(pool, {
    origin: 'http://localhost:5173',
    production: false,
    mediaUrl: '',
    mediaKey: '',
    mediaSecret: '',
  });
  try {
    const cookies: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = randomUUID(),
        token = randomBytes(32).toString('hex');
      await pool.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [
        id,
        id + '@rate.test',
        'Classmate ' + i,
        'disabled-fixture',
      ]);
      await pool.query(
        'INSERT INTO auth_sessions(id,token_hash,user_id,expires_at) VALUES($1,$2,$3,$4)',
        [
          randomUUID(),
          createHash('sha256').update(token).digest('hex'),
          id,
          new Date(Date.now() + 60000),
        ],
      );
      cookies.push('toaster_session=' + token);
    }
    const get = (cookie: string) => app.inject({ url: '/api/v1/me', headers: { cookie } });
    for (let i = 0; i < 600; i++) assert.equal((await get(cookies[0])).statusCode, 200);
    assert.equal((await get(cookies[0])).statusCode, 429);
    assert.equal(
      (await get(cookies[1])).statusCode,
      200,
      'Another classmate sharing the IP must retain access',
    );
    assert.equal((await get('toaster_session=forged')).statusCode, 401);
    assert.equal((await get('toaster_session=another-forgery')).statusCode, 401);
    await pool.query('DELETE FROM auth_sessions');
    assert.equal(
      (await get(cookies[1])).statusCode,
      401,
      'Revocation must not reuse another request identity',
    );
  } finally {
    await app.close();
    await cleanup();
  }
});
