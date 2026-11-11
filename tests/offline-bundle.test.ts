import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

test('offline bundle rejects tampered bytes, unexpected secrets, symlinks and checksum drift', async () => {
  const { verifyOfflineBundle, bundlePublicFiles } = await import(
    new URL('../scripts/offline-bundle.mjs', import.meta.url).href
  );
  const { offlineImages } = await import(
    new URL('../scripts/prepare-offline-installation.mjs', import.meta.url).href
  );
  const directory = await mkdtemp(join(tmpdir(), 'toaster-bundle-integrity-'));
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  try {
    const files: Record<string, { sha256: string; bytes: number }> = {};
    const id = 'sha256:' + 'a'.repeat(64);
    for (const name of ['images.tar', 'bootstrap-image.id', ...bundlePublicFiles]) {
      await mkdir(dirname(join(directory, name)), { recursive: true });
      const value =
        name === 'bootstrap-image.id'
          ? id + '\n'
          : name === 'bootstrap.sh'
            ? await readFile(
                new URL('../infrastructure/offline/bootstrap.sh', import.meta.url),
                'utf8',
              )
            : 'integrity-fixture';
      await writeFile(join(directory, name), value);
      files[name] = { sha256: hash(value), bytes: Buffer.byteLength(value) };
    }
    const manifest = {
      version: 1,
      files,
      images: Object.fromEntries(
        Object.keys(offlineImages).map((key) => [key, { id, platform: 'linux/amd64' }]),
      ),
    };
    const json = JSON.stringify(manifest);
    await writeFile(join(directory, 'bundle.json'), json);
    const sums =
      Object.entries(files)
        .map(([name, entry]) => entry.sha256 + '  ' + name)
        .join('\n') +
      '\n' +
      hash(json) +
      '  bundle.json\n';
    await writeFile(join(directory, 'SHA256SUMS'), sums);
    assert.equal((await verifyOfflineBundle(directory)).version, 1);
    if (process.platform !== 'win32')
      execFileSync('sh', [join(directory, 'bootstrap.sh'), 'verify'], { stdio: 'pipe' });
    await writeFile(join(directory, '.env'), 'A_SECRET=must-not-be-distributed');
    await assert.rejects(verifyOfflineBundle(directory), /Unexpected bundle content/);
    if (process.platform !== 'win32')
      assert.throws(() =>
        execFileSync('sh', [join(directory, 'bootstrap.sh'), 'verify'], { stdio: 'pipe' }),
      );
    await rm(join(directory, '.env'));
    await writeFile(join(directory, 'images.tar'), 'tampered');
    await assert.rejects(verifyOfflineBundle(directory), /integrity failed/);
    await writeFile(join(directory, 'images.tar'), 'integrity-fixture');
    await writeFile(join(directory, 'SHA256SUMS'), sums + 'untracked');
    await assert.rejects(verifyOfflineBundle(directory), /checksum inventory mismatch/);
    await writeFile(join(directory, 'SHA256SUMS'), sums);
    if (process.platform !== 'win32') {
      await rm(join(directory, 'LICENSE'));
      await symlink('/etc/passwd', join(directory, 'LICENSE'));
      await assert.rejects(verifyOfflineBundle(directory), /symlinks are forbidden/);
    }
    // These are integrity fixtures, not a valid image archive or import evidence.
    assert.ok((await readFile(join(directory, 'bundle.json'), 'utf8')).includes('linux/amd64'));
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('toaster-bundle-integrity-'));
    await rm(directory, { recursive: true, force: true });
  }
});
