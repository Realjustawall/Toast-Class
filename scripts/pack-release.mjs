import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import yazl from 'yazl';
import { sourceInventory } from './source-inventory.mjs';
export async function packRelease({ root, destination }) {
  const entries = await sourceInventory(root, 'release'),
    total = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (total > 15 * 1024 ** 2) throw new Error('Source release exceeds the 15 MiB size budget');
  await mkdir(dirname(destination), { recursive: true });
  const zip = new yazl.ZipFile(),
    output = createWriteStream(destination, { flags: 'wx' });
  const completed = new Promise((accept, reject) => {
    output.once('close', accept);
    output.once('error', reject);
    zip.outputStream.once('error', reject);
  });
  zip.outputStream.pipe(output);
  for (const entry of entries)
    zip.addFile(join(root, entry.path), 'toaster/' + entry.path, {
      mode: parseInt(entry.mode, 8),
      mtime: new Date('2026-01-01T00:00:00Z'),
    });
  zip.addBuffer(
    Buffer.from(JSON.stringify({ version: 1, files: entries }, null, 2) + '\n'),
    'toaster/RELEASE-MANIFEST.json',
  );
  zip.end();
  await completed;
  const body = await readFile(destination),
    sha256 = createHash('sha256').update(body).digest('hex');
  const result = {
    file: destination,
    sha256,
    archiveBytes: body.length,
    sourceBytes: total,
    fileCount: entries.length,
  };
  await writeFile(
    destination + '.sha256',
    sha256 + '  ' + destination.split(/[\\/]/).at(-1) + '\n',
    { flag: 'wx' },
  );
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  console.log(
    JSON.stringify(
      await packRelease({
        root: dirname(dirname(fileURLToPath(import.meta.url))),
        destination: resolve(values.output ?? '.local/releases/toaster-source-0.1.0.zip'),
      }),
      null,
      2,
    ),
  );
}
