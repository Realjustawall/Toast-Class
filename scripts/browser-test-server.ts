// Explicitly ephemeral test infrastructure. Never used by npm run dev.
import { testDatabase } from '../tests/database';
import { testStorage } from '../tests/storage-fixture';
import { buildApp } from '../apps/api/src/app.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { pool, cleanup, workerDatabaseUrl } = await testDatabase();
const storage = await testStorage();
const conversion = process.env.TEST_CONVERSION_DOCKER === 'true';
const app = await buildApp(pool, {
  origin: process.env.TEST_APP_ORIGIN ?? 'http://localhost:4175',
  production: false,
  mediaUrl: process.env.TEST_MEDIA_URL ?? 'ws://localhost:7880',
  mediaKey: process.env.TEST_MEDIA_KEY ?? '',
  mediaSecret: process.env.TEST_MEDIA_SECRET ?? '',
  files: { storage: storage.storage, allowUnscanned: true },
  presentationsEnabled: conversion,
});
// Trusted fixture setup only; this file is never a production entry point.
if (process.env.TEST_PLATFORM_ADMIN_SEED === 'true') {
  const origin = process.env.TEST_APP_ORIGIN ?? 'http://localhost:4175';
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { origin },
    payload: {
      email: 'platform-admin@browser.test',
      name: 'Test Platform Administrator',
      password: 'admin123',
    },
  });
  if (r.statusCode !== 201) throw new Error('Unable to initialize test administrator');
  await pool.query('INSERT INTO platform_admins(user_id) VALUES($1)', [r.json().id]);
}
let conversionProcess: ReturnType<typeof spawn> | undefined;
let conversionWorkDir: string | undefined;
if (conversion) {
  if (process.platform !== 'linux' || !workerDatabaseUrl)
    throw new Error(
      'Real conversion browser tests require Linux, Docker and an isolated real test database',
    );
  const url = new URL(workerDatabaseUrl);
  const isolated =
    url.protocol === 'mysql:'
      ? /^\/toaster_[a-f0-9]{32}_test$/.test(url.pathname)
      : /^-c search_path=test_[a-f0-9]{32}$/.test(url.searchParams.get('options') ?? '');
  if (!isolated) throw new Error('Refusing conversion worker outside an isolated test database');
  conversionWorkDir =
    process.env.TEST_CONVERSION_WORK_DIR ??
    (await mkdtemp(join(tmpdir(), 'toaster-conversion-e2e-')));
  conversionProcess = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/main.ts'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: url.toString(),
      NODE_ENV: 'development',
      PRESENTATIONS_ENABLED: 'true',
      FILE_STORAGE_DRIVER: 'filesystem',
      FILE_STORAGE_DIR: storage.storage.root,
      FILE_ALLOW_UNSCANNED: 'true',
      CLAMAV_HOST: '',
      CONVERSION_WORK_DIR: conversionWorkDir,
    },
  });
}
await app.listen({
  host: process.env.TEST_API_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_API_PORT ?? 33001),
});
console.log(
  'Isolated browser test API: ' +
    (pool.dialect === 'mysql'
      ? 'MySQL test database'
      : process.env.TEST_DATABASE_URL
        ? 'PostgreSQL test schema'
        : 'ephemeral pg-mem') +
    ', ' +
    (process.env.TEST_MEDIA_KEY ? 'configured real SFU' : 'no media'),
);
process.send?.({ type: 'ready' });
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (conversionProcess && conversionProcess.exitCode === null) {
    const exited = once(conversionProcess, 'exit');
    conversionProcess.kill('SIGTERM');
    await exited;
  }
  await app.close();
  await cleanup();
  await storage.cleanup();
  if (conversionWorkDir && !process.env.TEST_CONVERSION_WORK_DIR)
    await rm(conversionWorkDir, { recursive: true, force: true });
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutdown());
process.on('message', (message) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown')
    void shutdown();
});
