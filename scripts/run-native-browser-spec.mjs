import { readFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

// Configuration files are deliberately private and never served by Vite.
// Explicit process environment overrides local defaults. No credentials print.
const values = {
  ...dotenv.parse(await readFile('.local/runtime/native-media.env')),
  ...dotenv.parse(await readFile('.local/runtime/native-mysql.env')),
  ...process.env,
};
// Reuse the owned local preview SFU for isolated UUID-named test rooms. Keeping
// a second idle SFU alive is unnecessary; explicit test media settings win.
if (!process.env.TEST_MEDIA_URL && process.env.TEST_USE_PREVIEW_SFU !== 'false') {
  try {
    const preview = dotenv.parse(await readFile('.local/runtime/native-preview.env'));
    Object.assign(values, {
      TEST_MEDIA_URL: preview.LIVEKIT_URL,
      TEST_MEDIA_KEY: preview.LIVEKIT_API_KEY,
      TEST_MEDIA_SECRET: preview.LIVEKIT_API_SECRET,
      // Its webhook belongs to the persistent preview API, not this fixture.
      TEST_MEDIA_WEBHOOKS: 'false',
    });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const temporary = resolve('.local/tmp');
await mkdir(temporary, { recursive: true });
values.TEMP = temporary;
values.TMP = temporary;
values.TEST_API_PORT ??= '35011';
values.TEST_WEB_PORT ??= '35191';
values.TEST_APP_ORIGIN = 'http://localhost:' + values.TEST_WEB_PORT;
values.TOASTER_API_TARGET = 'http://127.0.0.1:' + values.TEST_API_PORT;
function child(args, ipc = false) {
  return spawn(process.execPath, args, {
    windowsHide: true,
    env: values,
    stdio: ipc ? ['ignore', 'inherit', 'inherit', 'ipc'] : 'inherit',
  });
}
async function bounded(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned server deadline exceeded')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function ready(url, process) {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (process.exitCode !== null) throw new Error('Owned test server exited before readiness');
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Owned server readiness timed out');
}
let api, web;
try {
  const prepare = child(['scripts/prepare-offline-assets.mjs']);
  if ((await once(prepare, 'exit'))[0] !== 0) throw new Error('Offline asset preparation failed');
  api = child(['--import', 'tsx', 'scripts/browser-test-server.ts'], true);
  await bounded(
    Promise.race([
      once(api, 'message'),
      once(api, 'exit').then(() => {
        throw new Error('Owned API failed to start');
      }),
    ]),
    60000,
  );
  await ready(values.TOASTER_API_TARGET + '/health', api);
  web = child([
    'node_modules/vite/bin/vite.js',
    'apps/web',
    '--config',
    'apps/web/vite.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    values.TEST_WEB_PORT,
    '--strictPort',
  ]);
  await ready(values.TEST_APP_ORIGIN, web);
  const test = child([
    'node_modules/@playwright/test/cli.js',
    'test',
    '-c',
    'playwright.owned.config.ts',
    ...process.argv.slice(2),
  ]);
  process.exitCode = (await once(test, 'exit'))[0] ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (web?.exitCode === null) web.kill();
  if (api?.exitCode === null) {
    const exited = once(api, 'exit');
    api.send({ type: 'shutdown' });
    try {
      await bounded(exited, 10000);
    } catch {
      api.kill();
      console.error('Owned API did not drain cleanly');
      process.exitCode = 1;
    }
  }
}
