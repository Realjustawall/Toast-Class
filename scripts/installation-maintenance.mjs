import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFile, lstat, realpath, mkdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function dockerProcess(args, signal) {
  const timeout = Number(process.env.TOASTER_MAINTENANCE_TIMEOUT_MS ?? 3600000);
  if (!Number.isInteger(timeout) || timeout < 30000 || timeout > 86400000)
    throw new Error('Invalid maintenance timeout');
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], timeout, signal });
  let errors = '';
  child.stderr.on('data', (bytes) => {
    if (errors.length < 2048) errors += bytes.toString().slice(0, 2048 - errors.length);
  });
  const completed = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? accept()
        : reject(new Error('Docker ' + args[0] + ' failed (' + code + '): ' + errors)),
    );
  });
  completed.catch(() => {});
  return { child, completed };
}
export async function command(args, input) {
  const { child, completed } = dockerProcess(args);
  const result = [];
  const output = (async () => {
    for await (const bytes of child.stdout) {
      result.push(bytes);
      if (result.reduce((sum, part) => sum + part.length, 0) > 8 * 1024 * 1024)
        throw new Error('Unexpectedly large Docker response');
    }
  })();
  try {
    if (input) await pipeline(Readable.from(input), child.stdin);
    else child.stdin.end();
    await output;
    await completed;
    return Buffer.concat(result).toString();
  } catch (error) {
    child.kill('SIGTERM');
    await completed.catch(() => {});
    throw error;
  }
}
export async function* commandStream(args, signal) {
  const { child, completed } = dockerProcess(args, signal);
  child.stdin.end();
  try {
    for await (const bytes of child.stdout) yield bytes;
    await completed;
  } finally {
    child.kill('SIGTERM');
    await completed.catch(() => {});
  }
}
export async function loadInstallation(directory, composeName = 'compose.yaml') {
  const root = await realpath(resolve(directory));
  if (!['compose.yaml', 'compose.isolated.json'].includes(composeName) || root.includes(','))
    throw new Error('Unsupported installation path/topology');
  const env = {};
  for (const line of (await readFile(join(root, '.env'), 'utf8')).split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(env, match[1]))
      throw new Error('Unsupported installation environment');
    env[match[1]] = match[2];
  }
  const metadata = JSON.parse(await readFile(join(root, 'installation.json'), 'utf8'));
  if (
    !/^toaster-[a-f0-9]{12}$/.test(env.COMPOSE_PROJECT_NAME) ||
    metadata.projectName !== env.COMPOSE_PROJECT_NAME
  )
    throw new Error('Installation project identity mismatch');
  const database = new URL(env.MIGRATION_DATABASE_URL);
  if (
    database.protocol !== 'mysql:' ||
    database.hostname !== '127.0.0.1' ||
    database.pathname !== '/toaster' ||
    !/^sha256:[a-f0-9]{64}$|^[a-z0-9][a-z0-9./:@_-]+$/.test(env.APP_IMAGE)
  )
    throw new Error('Unsupported database/image configuration');
  return {
    root,
    env,
    metadata,
    database,
    compose: ['compose', '--env-file', join(root, '.env'), '-f', join(root, composeName)],
  };
}
export async function inspectInstallation(context) {
  const ids = (await command([...context.compose, 'ps', '-a', '-q']))
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!ids.length || ids.some((id) => !/^[a-f0-9]{64}$/.test(id)))
    throw new Error('Installation has no owned containers');
  const records = JSON.parse(await command(['inspect', ...ids])),
    services = {};
  for (const record of records) {
    const labels = record.Config.Labels,
      name = labels['com.docker.compose.service'];
    if (
      labels['com.docker.compose.project'] !== context.env.COMPOSE_PROJECT_NAME ||
      ![
        'mysql',
        'migrate',
        'api',
        'worker',
        'web',
        'livekit',
        'scanner',
        'signatures',
        'bootstrap',
      ].includes(name) ||
      services[name]
    )
      throw new Error('Unexpected installation container');
    services[name] = record;
  }
  for (const name of [
    'mysql',
    'api',
    'web',
    'livekit',
    'scanner',
    ...(context.env.PRESENTATIONS_ENABLED === 'false' ? [] : ['worker']),
  ])
    if (!services[name]) throw new Error('Missing installation service: ' + name);
  if (!services.mysql.State.Running) throw new Error('MySQL must be running');
  const volumes = {};
  for (const [name, service, destination] of [
    ['files', 'api', '/var/lib/toaster/storage'],
    ['caddy-data', 'web', '/data'],
    ['caddy-config', 'web', '/config'],
  ]) {
    const mount = services[service].Mounts.find((value) => value.Destination === destination);
    if (mount?.Type !== 'volume' || !/^[a-z0-9_.-]+$/.test(mount.Name))
      throw new Error('Expected private named volume: ' + name);
    const [volume] = JSON.parse(await command(['volume', 'inspect', mount.Name]));
    if (
      volume.Labels['com.docker.compose.project'] !== context.env.COMPOSE_PROJECT_NAME ||
      volume.Labels['com.docker.compose.volume'] !== name
    )
      throw new Error('Volume ownership mismatch');
    volumes[name] = mount.Name;
  }
  return { services, volumes };
}
export async function maintenanceLock(context) {
  const path = join(context.root, '.maintenance-lock'),
    nonce = randomUUID();
  await mkdir(path, { mode: 0o700 });
  await writeFile(
    join(path, 'owner.json'),
    JSON.stringify({
      nonce,
      startedAt: new Date().toISOString(),
      project: context.env.COMPOSE_PROJECT_NAME,
    }) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  const release = async () => {
    const info = await lstat(path),
      owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
    if (!info.isDirectory() || info.isSymbolicLink() || owner.nonce !== nonce)
      throw new Error('Maintenance lock ownership changed');
    await unlink(join(path, 'owner.json'));
    await rmdir(path);
  };
  return {
    release,
    update: async (details) => {
      const owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
      if (owner.nonce !== nonce) throw new Error('Maintenance lock ownership changed');
      await writeFile(
        join(path, 'owner.json'),
        JSON.stringify({ ...owner, ...details, nonce }) + '\n',
        { mode: 0o600 },
      );
    },
  };
}
export async function mysqlCredentials(context, container) {
  const path = '/tmp/toaster-maintenance-' + randomUUID() + '.cnf';
  const quote = (value) =>
    '"' +
    value
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('\n', '\\n')
      .replaceAll('\r', '\\r') +
    '"';
  const body = `[client]\nprotocol=TCP\nhost=127.0.0.1\nport=${context.database.port || 3306}\nuser=${quote(decodeURIComponent(context.database.username))}\npassword=${quote(decodeURIComponent(context.database.password))}\ndefault-character-set=utf8mb4\n`;
  // Only a generated literal path enters shell code. Credentials enter over stdin.
  await command(
    ['exec', '-i', container, 'sh', '-c', 'umask 077; cat > ' + path],
    [Buffer.from(body)],
  );
  return { path, close: () => command(['exec', container, 'rm', '-f', path]) };
}
export const dumpArguments = (container, credentials) => [
  'exec',
  container,
  'mysqldump',
  '--defaults-extra-file=' + credentials,
  '--single-transaction',
  '--no-tablespaces',
  '--set-gtid-purged=OFF',
  '--hex-blob',
  '--column-statistics=0',
  '--routines',
  '--events',
  '--order-by-primary',
  '--skip-comments',
  '--skip-dump-date',
  'toaster',
];
export const configurationFiles = Object.freeze([
  '.env',
  'installation.json',
  'compose.yaml',
  'Caddyfile',
  'installation/mysql-init.sql',
  'installation/mysql-client.cnf',
  'installation/livekit.yaml',
  'installation/clamd.conf',
]);
export async function configurationSnapshot(context) {
  const files = {};
  let bytes = 0;
  for (const name of configurationFiles) {
    const path = join(context.root, name),
      info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024)
      throw new Error('Unexpected installation configuration file');
    const data = await readFile(path);
    bytes += data.length;
    if (bytes > 1024 * 1024) throw new Error('Configuration archive limit exceeded');
    files[name] = data.toString('base64');
  }
  return Buffer.from(
    JSON.stringify({
      version: 1,
      project: context.env.COMPOSE_PROJECT_NAME,
      backedUpAt: new Date().toISOString(),
      files,
    }),
  );
}
