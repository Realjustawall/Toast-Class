import { test, expect } from './owned-browser';
import { writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

test('development HTTP cannot bypass private runtime, storage or backend boundaries', async ({
  request,
}) => {
  const path = resolve('.local', 'fs-canary-' + randomUUID() + '.json');
  const canary = 'private-canary-' + randomUUID();
  await writeFile(path, JSON.stringify({ canary }), { flag: 'wx' });
  const fsUrl = (file: string) => '/@fs/' + file.replaceAll('\\', '/');
  try {
    for (const suffix of ['', '?raw', '?import']) {
      const response = await request.get(fsUrl(path) + suffix);
      expect(response.status()).toBe(403);
      expect(await response.text()).not.toContain(canary);
    }
    for (const file of [
      'apps/api/src/app.ts',
      'packages/database/mysql/001_identity.sql',
      '.env',
    ]) {
      const response = await request.get(fsUrl(resolve(file)));
      expect(response.status(), file).toBe(403);
    }
    expect((await request.get('/src/main.tsx')).status()).toBe(200);
    expect((await request.get(fsUrl(resolve('packages/whiteboard/schema.ts')))).status()).toBe(200);
  } finally {
    await rm(path, { force: true });
  }
});
