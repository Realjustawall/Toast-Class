import { readFile, readdir, mkdir, writeFile, lstat, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const destination = resolve(process.argv[2] ?? 'apps/web/dist/licenses/dependencies');
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
await mkdir(destination, { recursive: true });
const inventory = [];
for (const location of Object.keys(lock.packages)
  .filter((path) => path.startsWith('node_modules/'))
  .sort()) {
  if (location.split('/').includes('..')) throw new Error('Invalid package location');
  let metadata;
  try {
    metadata = JSON.parse(await readFile(join(location, 'package.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  const notices = [];
  const key = createHash('sha256').update(location).digest('hex').slice(0, 12);
  for (const name of (await readdir(location)).sort()) {
    if (!/^(licen[cs]e|copying|notice|copyright|authors)([._-].*)?$/i.test(name)) continue;
    const original = join(location, name),
      info = await lstat(original);
    if (!info.isFile() || info.isSymbolicLink()) continue;
    if (info.size > 2 * 1024 * 1024) throw new Error('Unexpectedly large dependency notice');
    await mkdir(join(destination, key), { recursive: true });
    await copyFile(original, join(destination, key, name));
    notices.push(key + '/' + name);
  }
  if (['@fontsource/manrope', '@fontsource/vazirmatn'].includes(metadata.name) && !notices.length)
    throw new Error('Required font license missing');
  inventory.push({
    name: metadata.name,
    version: metadata.version,
    declaredLicense: metadata.license ?? null,
    noticeFiles: notices,
  });
}
await writeFile(
  join(destination, 'inventory.json'),
  JSON.stringify(
    {
      description:
        'Installed build dependency inventory; not every package is bundled. Source/notice legal review remains required before release.',
      packages: inventory,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  'Preserved dependency notices and font licenses for ' + inventory.length + ' installed packages.',
);
