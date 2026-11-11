import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  lstat,
  realpath,
  readdir,
  stat,
} from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { offlineImages, prepareOfflineInstallation } from './prepare-offline-installation.mjs';

const source = new URL('../', import.meta.url);
const publicFiles = [
  'LICENSE',
  'scripts/offline-bundle.mjs',
  'scripts/prepare-offline-installation.mjs',
  'infrastructure/offline/compose.yaml',
  'infrastructure/offline/Caddyfile',
  'docs/OFFLINE_INSTALL.md',
  'docs/ATTRIBUTION.md',
  'bootstrap.sh',
  'scripts/installation-smoke.mjs',
  'scripts/backup-format.mjs',
  'scripts/installation-maintenance.mjs',
  'scripts/installation-backup.mjs',
  'scripts/installation-restore.mjs',
  'scripts/mysql-dump-fingerprint.mjs',
  'scripts/mysql-integrity.mjs',
  'scripts/restore-volume.py',
  'docs/BACKUP_RECOVERY.md',
  'docs/WHITEBOARD.md',
  'docs/ADVANCED_BOARDS.md',
  'docs/CLASSROOM_UI.md',
  'third_party/bigbluebutton/NOTICE.md',
  'third_party/bigbluebutton/LICENSE.LGPL-3.0',
  'third_party/bigbluebutton/LICENSE.GPL-3.0',
  'third_party/bigbluebutton/upstream/actions-bar__styles.js',
  'third_party/bigbluebutton/upstream/nav-bar__styles.js',
  'third_party/bigbluebutton/upstream/sidebar-navigation__styles.ts',
  'third_party/bigbluebutton/upstream/layout__defaultValues.js',
  'apps/web/src/classroom-shell.css',
  'infrastructure/docker/Dockerfile.converter',
  'apps/worker/src/convert_document.py',
];
export { publicFiles as bundlePublicFiles };
export function runDocker(args, capture = false) {
  return new Promise((accept, reject) => {
    const child = spawn('docker', args, {
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    let output = '';
    if (capture)
      child.stdout.on('data', (part) => {
        output += part;
      });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? accept(output)
        : reject(new Error('Docker command failed: ' + args[0] + ' (' + code + ')')),
    );
  });
}
async function checksum(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
export async function exportOfflineBundle(directory) {
  const target = resolve(directory),
    images = {};
  // Inspect only cached images; export must never silently pull a missing dependency.
  for (const [key, reference] of Object.entries(offlineImages)) {
    const [record] = JSON.parse(await runDocker(['image', 'inspect', reference], true));
    if (record.Os !== 'linux' || !/^sha256:[a-f0-9]{64}$/.test(record.Id))
      throw new Error('Unsupported image: ' + key);
    images[key] = { reference, id: record.Id, platform: record.Os + '/' + record.Architecture };
  }
  if (new Set(Object.values(images).map((value) => value.platform)).size !== 1)
    throw new Error('Bundle images must have one tested platform');
  await mkdir(dirname(target), { recursive: true });
  await mkdir(target, { mode: 0o755 });
  for (const name of publicFiles) {
    await mkdir(dirname(resolve(target, name)), { recursive: true });
    await copyFile(
      new URL(name === 'bootstrap.sh' ? 'infrastructure/offline/bootstrap.sh' : name, source),
      resolve(target, name),
    );
  }
  await writeFile(resolve(target, 'bootstrap-image.id'), images.APP_IMAGE.id + '\n', {
    flag: 'wx',
  });
  await runDocker([
    'image',
    'save',
    '--output',
    resolve(target, 'images.tar'),
    ...new Set(Object.values(images).map((value) => value.id)),
  ]);
  const files = {};
  for (const name of ['images.tar', 'bootstrap-image.id', ...publicFiles])
    files[name] = {
      sha256: await checksum(resolve(target, name)),
      bytes: (await lstat(resolve(target, name))).size,
    };
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    images,
    files,
    certification: 'LOCAL_TESTING_NOT_RELEASE_CERTIFIED',
  };
  await writeFile(resolve(target, 'bundle.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  });
  await writeFile(
    resolve(target, 'SHA256SUMS'),
    Object.entries(files)
      .map(([name, value]) => value.sha256 + '  ' + name)
      .join('\n') +
      '\n' +
      (await checksum(resolve(target, 'bundle.json'))) +
      '  bundle.json\n',
    { flag: 'wx' },
  );
  return manifest;
}
export async function verifyOfflineBundle(directory) {
  const target = await realpath(resolve(directory));
  const expected = new Set([
    'images.tar',
    'bootstrap-image.id',
    'bundle.json',
    'SHA256SUMS',
    ...publicFiles,
  ]);
  const walk = async (prefix = '') => {
    for (const entry of await readdir(resolve(target, prefix), { withFileTypes: true })) {
      const name = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Bundle symlinks are forbidden: ' + name);
      if (entry.isDirectory() && [...expected].some((path) => path.startsWith(name + '/')))
        await walk(name);
      else if (!entry.isFile() || !expected.has(name))
        throw new Error('Unexpected bundle content: ' + name);
    }
  };
  await walk();
  if ((await lstat(resolve(target, 'bundle.json'))).size > 1024 * 1024)
    throw new Error('Oversized bundle manifest');
  const manifest = JSON.parse(await readFile(resolve(target, 'bundle.json'), 'utf8'));
  if (
    manifest.version !== 1 ||
    !manifest.files ||
    !manifest.images ||
    Object.keys(manifest.files).sort().join() !==
      ['images.tar', 'bootstrap-image.id', ...publicFiles].sort().join() ||
    Object.keys(manifest.images).sort().join() !== Object.keys(offlineImages).sort().join()
  )
    throw new Error('Invalid bundle inventory');
  for (const value of Object.values(manifest.images))
    if (!/^sha256:[a-f0-9]{64}$/.test(value.id) || !/^linux\/(amd64|arm64)$/.test(value.platform))
      throw new Error('Invalid image identity');
  if (new Set(Object.values(manifest.images).map((image) => image.platform)).size !== 1)
    throw new Error('Mixed bundle platforms');
  for (const name of ['images.tar', 'bootstrap-image.id', ...publicFiles]) {
    const path = resolve(target, name),
      entry = manifest.files[name],
      info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !(await realpath(path)).startsWith(target + sep) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      info.size !== entry.bytes ||
      (await checksum(path)) !== entry.sha256
    )
      throw new Error('Bundle integrity failed: ' + name);
  }
  if (
    (await readFile(resolve(target, 'bootstrap-image.id'), 'utf8')).trim() !==
    manifest.images.APP_IMAGE.id
  )
    throw new Error('Bootstrap image identity mismatch');
  const sums =
    Object.entries(manifest.files)
      .map(([name, entry]) => entry.sha256 + '  ' + name)
      .join('\n') +
    '\n' +
    (await checksum(resolve(target, 'bundle.json'))) +
    '  bundle.json\n';
  if ((await readFile(resolve(target, 'SHA256SUMS'), 'utf8')) !== sums)
    throw new Error('Bootstrap checksum inventory mismatch');
  return manifest;
}
export async function importOfflineBundle(directory) {
  const manifest = await verifyOfflineBundle(directory);
  await runDocker(['image', 'load', '--input', resolve(directory, 'images.tar')]);
  for (const value of Object.values(manifest.images)) {
    const [record] = JSON.parse(await runDocker(['image', 'inspect', value.id], true));
    if (record.Id !== value.id || record.Os + '/' + record.Architecture !== value.platform)
      throw new Error('Loaded image identity mismatch');
  }
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      directory: { type: 'string' },
      installation: { type: 'string' },
      host: { type: 'string' },
      'media-ip': { type: 'string' },
      'port-offset': { type: 'string' },
      'docker-gid': { type: 'string' },
      'jobs-dir': { type: 'string' },
    },
  });
  if (!values.directory) throw new Error('--directory is required');
  if (command === 'export') {
    await exportOfflineBundle(values.directory);
    console.log(
      'Local images and public installation files exported. No installation secrets included.',
    );
  } else if (command === 'verify') {
    await verifyOfflineBundle(values.directory);
    console.log(
      'All bundle file hashes and inventory verified. Verify manifest authenticity through a trusted channel separately.',
    );
  } else if (command === 'import') {
    await importOfflineBundle(values.directory);
    console.log('Verified images imported by immutable image ID. No services started.');
  } else if (command === 'configure') {
    const manifest = await verifyOfflineBundle(values.directory);
    const dockerGid =
      values['docker-gid'] ??
      (process.platform === 'linux' ? String((await stat('/var/run/docker.sock')).gid) : '0');
    const configuration = await prepareOfflineInstallation({
      directory: values.installation,
      host: values.host,
      mediaIp: values['media-ip'],
      portOffset: values['port-offset'],
      dockerGid,
      jobsDir: values['jobs-dir'],
      images: Object.fromEntries(
        Object.entries(manifest.images).map(([key, value]) => [key, value.id]),
      ),
    });
    console.log(
      'Private installation created for ' +
        configuration.origin +
        '. Service images use verified immutable IDs.',
    );
  } else throw new Error('Expected export, verify, import or configure');
}
