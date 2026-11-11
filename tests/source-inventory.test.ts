import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('real source release retains all installer/build inputs, including extensionless service configuration', async () => {
  const { sourceInventory } = await import(
      new URL('../scripts/source-inventory.mjs', import.meta.url).href
    ),
    entries = await sourceInventory(process.cwd(), 'release'),
    names = new Set(entries.map((e: { path: string }) => e.path));
  for (const required of [
    'install.sh',
    'scripts/install.mjs',
    'scripts/production-installation.mjs',
    'scripts/prepare-offline-installation.mjs',
    'infrastructure/offline/compose.yaml',
    'infrastructure/offline/Caddyfile',
    'infrastructure/production/Caddyfile',
    'infrastructure/docker/Dockerfile.app',
    'infrastructure/docker/Dockerfile.web',
    'infrastructure/docker/Dockerfile.worker',
    'infrastructure/docker/Dockerfile.converter',
    'apps/web/offline-excalidraw.ts',
    'packages/user-preferences.ts',
    'packages/database/mysql/023_private_chat_and_policy.sql',
    'LOGIN DESIGN/toaster-3d.js',
    'toaster-works.html',
  ])
    assert.ok(names.has(required), 'Required build input missing: ' + required);
  assert.ok(!names.has('infrastructure/livekit.yaml'));
});
test('release allowlist excludes local credentials, generated assets and test payloads while retaining required runtime assets', async () => {
  const { sourceInventory } = await import(
      new URL('../scripts/source-inventory.mjs', import.meta.url).href
    ),
    root = await mkdtemp(join(tmpdir(), 'toaster-release-'));
  try {
    for (const path of [
      '.local/private.json',
      'apps/web/public/vendor/geogebra/huge.js',
      'apps/web/src/view.tsx',
      'apps/web/public/media-effects/selfie_segmenter.tflite',
      'scripts/install.mjs',
      'tests/fixture.ts',
      'docs/INSTALL.md',
      'docs/PROGRESS.md',
      'docs/PRIVATE_OPERATIONS.md',
      'installation/.env',
    ]) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), 'fixture');
    }
    await writeFile(join(root, '.env'), 'PRIVATE=secret');
    await writeFile(join(root, 'package.json'), '{}');
    const release = (await sourceInventory(root, 'release')).map((v: { path: string }) => v.path);
    assert.deepEqual(release, [
      'apps/web/public/media-effects/selfie_segmenter.tflite',
      'apps/web/src/view.tsx',
      'docs/INSTALL.md',
      'package.json',
      'scripts/install.mjs',
    ]);
    const repository = (await sourceInventory(root, 'repository')).map(
      (v: { path: string }) => v.path,
    );
    assert.ok(repository.includes('tests/fixture.ts'));
    await writeFile(join(root, 'apps/web/src/copied.ts'), '-----BEGIN ' + 'PRIVATE KEY-----');
    await assert.rejects(sourceInventory(root), /Credential-like/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
