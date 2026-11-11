import { readFile, writeFile, mkdir, stat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

export const GEOGEBRA_VERSION = '5.4.934.0';
const digest = 'bb55da6967d949949204c20b598bd5c6dc2116100b1908efd9461ffa7f6ce1d0';
const root = fileURLToPath(new URL('../', import.meta.url));
export async function prepareGeoGebra() {
  const output = resolve(root, 'apps/web/public/vendor/geogebra'),
    manifest = resolve(output, 'manifest.json');
  try {
    const current = JSON.parse(await readFile(manifest, 'utf8'));
    if (current.sha256 === digest) {
      await stat(resolve(output, 'GeoGebra/deployggb.js'));
      return;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const cache = resolve(root, '.local/vendor'),
    archive = resolve(cache, 'geogebra-math-apps-bundle-5-4-934-0.zip');
  await mkdir(cache, { recursive: true });
  if (!(await stat(archive).catch(() => null))) {
    const total = 33399930,
      chunkSize = 2 * 1024 * 1024,
      count = Math.ceil(total / chunkSize),
      parts = resolve(cache, 'geogebra-parts');
    await mkdir(parts, { recursive: true });
    let next = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < count) {
          const index = next++,
            start = index * chunkSize,
            end = Math.min(total - 1, start + chunkSize - 1),
            part = resolve(parts, index + '.part');
          if ((await stat(part).catch(() => ({ size: 0 }))).size === end - start + 1) continue;
          const response = await fetch(
            'https://download.geogebra.org/installers/5.4/geogebra-math-apps-bundle-5-4-934-0.zip',
            {
              headers: { Range: 'bytes=' + start + '-' + end },
              signal: AbortSignal.timeout(180000),
            },
          );
          if (
            response.status !== 206 ||
            response.headers.get('content-range') !== 'bytes ' + start + '-' + end + '/' + total
          )
            throw new Error('Invalid official GeoGebra range response');
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length !== end - start + 1) throw new Error('Incomplete GeoGebra archive');
          await writeFile(part, bytes);
        }
      }),
    );
    const handle = await open(archive, 'wx');
    try {
      for (let index = 0; index < count; index++)
        await handle.write(await readFile(resolve(parts, index + '.part')));
    } finally {
      await handle.close();
    }
  }
  if (
    createHash('sha256')
      .update(await readFile(archive))
      .digest('hex') !== digest
  )
    throw new Error('GeoGebra archive checksum mismatch');
  await mkdir(output, { recursive: true });
  await new Promise((resolveDone, reject) =>
    yauzl.open(
      archive,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) {
          reject(error ?? new Error('Invalid GeoGebra archive'));
          return;
        }
        let count = 0,
          total = 0;
        zip.on('error', reject);
        zip.on('end', resolveDone);
        zip.on('entry', async (entry) => {
          try {
            const target = resolve(output, entry.fileName);
            total += entry.uncompressedSize;
            count++;
            if (
              !target.startsWith(output + sep) ||
              entry.fileName.includes('\\') ||
              total > 256 * 1024 * 1024 ||
              count > 5000 ||
              ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
            )
              throw new Error('Unsafe GeoGebra archive path');
            if (entry.fileName.endsWith('/')) {
              await mkdir(target, { recursive: true });
              zip.readEntry();
              return;
            }
            await mkdir(dirname(target), { recursive: true });
            await new Promise((done, fail) =>
              zip.openReadStream(entry, (error, input) => {
                if (error || !input) return fail(error);
                pipeline(input, createWriteStream(target)).then(done, fail);
              }),
            );
            zip.readEntry();
          } catch (error) {
            zip.close();
            reject(error);
          }
        });
        zip.readEntry();
      },
    ),
  );
  await writeFile(
    manifest,
    JSON.stringify(
      {
        version: GEOGEBRA_VERSION,
        sha256: digest,
        source: 'https://github.com/geogebra/geogebra',
        archive:
          'https://download.geogebra.org/installers/5.4/geogebra-math-apps-bundle-5-4-934-0.zip',
        license: 'https://www.geogebra.org/license',
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Prepared official GeoGebra ' + GEOGEBRA_VERSION + ' locally.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await prepareGeoGebra();
