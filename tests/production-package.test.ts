import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import yauzl from 'yauzl';

test('thin ZIP configures an installation from an extracted source tree without host npm dependencies', async () => {
  const { packRelease } = await import(
    new URL('../scripts/pack-release.mjs', import.meta.url).href
  );
  const parent = await mkdtemp(join(tmpdir(), 'toaster-package-'));
  try {
    const destination = join(parent, 'source.zip'),
      result = await packRelease({ root: process.cwd(), destination });
    assert.ok(result.archiveBytes < 5 * 1024 ** 2);
    assert.ok((await readFile(destination + '.sha256', 'utf8')).startsWith(result.sha256));
    await new Promise<void>((accept, reject) => {
      yauzl.open(destination, { lazyEntries: true }, (error, zip) => {
        if (error || !zip) return reject(error);
        zip.on('error', reject);
        zip.on('end', accept);
        zip.on('entry', async (entry) => {
          try {
            assert.ok(
              entry.fileName.startsWith('toaster/') && !entry.fileName.split('/').includes('..'),
            );
            assert.ok(
              !entry.fileName.includes('/node_modules/') && !entry.fileName.includes('/.local/'),
            );
            const bytes = await new Promise<Buffer>((resolve, fail) =>
              zip.openReadStream(entry, (error, stream) => {
                if (error || !stream) return fail(error);
                const parts: Buffer[] = [];
                stream.on('data', (bytes) => parts.push(bytes));
                stream.on('end', () => resolve(Buffer.concat(parts)));
                stream.on('error', fail);
              }),
            );
            const output = join(parent, entry.fileName);
            await mkdir(dirname(output), { recursive: true });
            await writeFile(output, bytes);
            zip.readEntry();
          } catch (error) {
            zip.close();
            reject(error);
          }
        });
        zip.readEntry();
      });
    });
    const configured = spawnSync(
      process.execPath,
      [
        join(parent, 'toaster/scripts/install.mjs'),
        'configure',
        '--directory',
        join(parent, 'instance'),
        '--source',
        '/opt/toaster/source',
        '--domain',
        'class.package.test',
        '--media-ip',
        '192.0.2.5',
        '--email',
        'admin@package.test',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(configured.status, 0, configured.stderr);
    assert.match(
      await readFile(join(parent, 'instance/Caddyfile'), 'utf8'),
      /Content-Security-Policy/,
    );
    assert.match(
      await readFile(join(parent, 'instance/compose.yaml'), 'utf8'),
      /bootstrap-admin.js/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
