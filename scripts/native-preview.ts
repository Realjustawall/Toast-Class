import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { createServer } from 'vite';
import { MySqlDatabase } from '../apps/api/src/database';
import { buildApp } from '../apps/api/src/app';
import { fileConfigFromEnvironment } from '../apps/api/src/file-config';
const env = dotenv.parse(await readFile('.local/runtime/native-preview.env'));
const access = JSON.parse(await readFile('.local/runtime/native-preview-access.json', 'utf8'));
const pool = new MySqlDatabase(env.DATABASE_URL);
const app = await buildApp(pool, {
  origin: env.APP_ORIGIN,
  redisUrl: env.REDIS_URL === 'false' ? undefined : env.REDIS_URL || 'redis://127.0.0.1:6379',
  production: false,
  mediaUrl: env.LIVEKIT_URL,
  mediaKey: env.LIVEKIT_API_KEY,
  mediaSecret: env.LIVEKIT_API_SECRET,
  files: fileConfigFromEnvironment(env),
});
const post = async (path: string, data: unknown, cookie = '') => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1' + path,
    headers: { origin: env.APP_ORIGIN, cookie, 'content-type': 'application/json' },
    payload: JSON.stringify(data),
  });
  if (response.statusCode >= 400)
    throw new Error('Preview setup failed: ' + path + ' ' + response.statusCode);
  return response;
};
if (!(await pool.query('SELECT id FROM users WHERE email=$1', [access.email])).rows.length) {
  const registered = await post('/auth/register', {
    email: access.email,
    password: access.password,
    name: 'مدیر آموزش',
    locale: 'fa',
  });
  const uid = registered.json().id;
  await pool.query('INSERT INTO platform_admins(user_id) VALUES($1)', [uid]);
  const login = await post('/auth/login', { email: access.email, password: access.password });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const org = (await post('/organizations', { name: 'آموزشگاه توستر' }, cookie)).json();
  for (const [theme, name] of [
    ['classic-bbb', 'کلاسیک'],
    ['modular-skyroom', 'ماژولار'],
    ['immersive-glass', 'شیشه‌ای'],
    ['studio-hybrid', 'استودیو'],
  ]) {
    const room = (
      await post(
        '/organizations/' + org.id + '/classrooms',
        { name: 'کلاس ' + name, theme },
        cookie,
      )
    ).json();
    await post(
      '/classrooms/' + room.id + '/documents',
      { name: 'تختهٔ کلاس', kind: 'board', boardFormat: 'excalidraw' },
      cookie,
    );
    await post(
      '/classrooms/' + room.id + '/documents',
      { name: 'یادداشت مشترک', kind: 'notes' },
      cookie,
    );
  }
}
await app.listen({ port: 3002, host: '127.0.0.1' });
const vite = await createServer({
  root: resolve('apps/web'),
  configFile: resolve('apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3002', ws: true } },
  },
});
await vite.listen();
console.log('Persistent MySQL classroom preview ready: ' + env.APP_ORIGIN);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await vite.close();
    await app.close();
    await pool.end();
    process.exit(0);
  });
