import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { writeEncryptedBackup, openVerifiedBackup } from './backup-format.mjs';
import {
  command,
  commandStream,
  loadInstallation,
  inspectInstallation,
  maintenanceLock,
  mysqlCredentials,
  dumpArguments,
  configurationSnapshot,
} from './installation-maintenance.mjs';

export async function loadBackupKey(path) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== 32 ||
    (process.platform !== 'win32' && info.mode & 0o077)
  )
    throw new Error('Backup key must be a private regular32-byte file(mode0600)');
  return readFile(path);
}
async function* volumeSnapshot(context, name, volume, signal) {
  const helper = 'toaster-backup-' + randomUUID();
  try {
    yield* commandStream(
      [
        'run',
        '--rm',
        '--pull=never',
        '--name',
        helper,
        '--label',
        'toaster.backup=' + context.env.COMPOSE_PROJECT_NAME,
        '--network=none',
        '--read-only',
        '--user=0:0',
        '--cap-drop=ALL',
        '--cap-add=DAC_OVERRIDE',
        '--security-opt=no-new-privileges',
        '--mount',
        'type=volume,source=' + volume + ',target=/snapshot,readonly',
        context.env.APP_IMAGE,
        'tar',
        '--numeric-owner',
        '-C',
        '/snapshot',
        '-cpf',
        '-',
        '.',
      ],
      signal,
    );
  } finally {
    await command(['rm', '-f', helper]).catch(async (error) => {
      const exists = await command(['ps', '-a', '-q', '--filter', 'name=^/' + helper + '$']);
      if (exists.trim()) throw error;
    });
  }
}
export async function backupInstallation({
  directory,
  composeName,
  destination,
  keyFile,
  maintenance,
  allowLiveInterruption = false,
}) {
  if (!maintenance) throw new Error('Use --maintenance to authorize the installation downtime');
  if (process.platform !== 'linux')
    throw new Error('Run installation maintenance on the Linux Docker host');
  const context = await loadInstallation(directory, composeName);
  const output = resolve(destination),
    keyPath = await realpath(keyFile);
  const parent = await lstat(dirname(output));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o022)
    throw new Error('Use a private backup parent before scheduling downtime');
  if ((await lstat(keyFile)).isSymbolicLink()) throw new Error('Backup key must not be a symlink');
  if (output.startsWith(context.root + sep) || keyPath.startsWith(context.root + sep))
    throw new Error('Keep backup and encryption key outside installation configuration');
  try {
    await lstat(output);
    throw new Error('Backup destination already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const key = await loadBackupKey(keyPath),
    lock = await maintenanceLock(context);
  let running = [],
    credentials,
    resumed = false;
  const cancellation = new AbortController();
  const interrupted = () => cancellation.abort();
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    const { services, volumes } = await inspectInstallation(context);
    if (
      services.migrate?.State.Running ||
      Object.values(services).some(
        (record) =>
          record.State.Restarting ||
          (record.State.Running && record.State.Health?.Status === 'starting'),
      )
    )
      throw new Error('Wait for installation startup/migration to finish before maintenance');
    running = ['web', 'livekit', 'worker', 'api']
      .map((name) => services[name])
      .filter((record) => record?.State.Running)
      .map((record) => record.Id);
    await lock.update({ phase: 'quiescing', containersToResume: running });
    if (running.length) await command(['stop', '--time=180', ...running]);
    if (cancellation.signal.aborted) throw new Error('Maintenance interrupted');
    credentials = await mysqlCredentials(context, services.mysql.Id);
    const active = (
      await command([
        'exec',
        services.mysql.Id,
        'mysql',
        '--defaults-extra-file=' + credentials.path,
        '--batch',
        '--skip-column-names',
        '--execute',
        'SELECT COUNT(*) FROM toaster.classroom_sessions WHERE ended_at IS NULL',
      ])
    ).trim();
    if (!/^\d+$/.test(active) || (!allowLiveInterruption && active !== '0'))
      throw new Error(
        'Active classroom sessions require an explicit interrupted-session policy; no backup created',
      );
    const configuration = await configurationSnapshot(context);
    await lock.update({ phase: 'snapshot', containersToResume: running });
    const records = await writeEncryptedBackup(output, key, [
      {
        name: 'configuration.json',
        stream: async function* () {
          yield configuration;
        },
      },
      {
        name: 'database.sql',
        stream: () =>
          commandStream(dumpArguments(services.mysql.Id, credentials.path), cancellation.signal),
      },
      ...['files', 'caddy-data', 'caddy-config'].map((name) => ({
        name: name + '.tar',
        stream: () => volumeSnapshot(context, name, volumes[name], cancellation.signal),
      })),
    ]);
    // Verify the committed ciphertext before reporting a usable backup.
    const verified = await openVerifiedBackup(output, key);
    try {
      if (JSON.stringify(verified.records) !== JSON.stringify(records))
        throw new Error('Backup verification mismatch');
    } finally {
      await verified.close();
    }
    await lock.update({ phase: 'verified', containersToResume: running });
    return {
      version: 1,
      project: context.env.COMPOSE_PROJECT_NAME,
      createdAt: new Date().toISOString(),
      records,
      restoreCertification: 'PENDING_RESTORE_DRILL',
    };
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    key.fill(0);
    let cleanupError;
    if (credentials) {
      try {
        await credentials.close();
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      if (running.length) await command(['start', ...running]);
      resumed = true;
    } finally {
      // Preserve the ownership/phase marker if resumption fails; never silently clear it.
      if (resumed) await lock.release();
    }
    if (cleanupError) throw cleanupError;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const action = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      installation: { type: 'string' },
      compose: { type: 'string' },
      output: { type: 'string' },
      backup: { type: 'string' },
      'key-file': { type: 'string' },
      report: { type: 'string' },
      maintenance: { type: 'boolean' },
      'allow-live-interruption': { type: 'boolean' },
    },
  });
  if (!values['key-file']) throw new Error('--key-file is required');
  if (action === 'keygen') {
    const parent = await lstat(dirname(resolve(values['key-file'])));
    if (!parent.isDirectory() || (process.platform !== 'win32' && parent.mode & 0o022))
      throw new Error('Use a private key directory');
    await writeFile(values['key-file'], randomBytes(32), { mode: 0o600, flag: 'wx' });
    console.log(
      'New private backup key created; keep it separately from backups and installation exports.',
    );
  } else if (action === 'backup') {
    const result = await backupInstallation({
      directory: values.installation,
      composeName: values.compose,
      destination: values.output,
      keyFile: values['key-file'],
      maintenance: values.maintenance,
      allowLiveInterruption: values['allow-live-interruption'],
    });
    if (values.report)
      await writeFile(values.report, JSON.stringify(result, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    console.log(
      'Encrypted database/files/CA/configuration snapshot verified; previously active services resumed. Restore verification is a separate required gate.',
    );
  } else if (action === 'verify') {
    const key = await loadBackupKey(values['key-file']);
    try {
      const verified = await openVerifiedBackup(values.backup, key);
      await verified.close();
    } finally {
      key.fill(0);
    }
    console.log(
      'Entire encrypted backup authenticated and part inventory verified; no installation was changed.',
    );
  } else
    throw new Error(
      'Expected keygen, backup or verify; use installation-restore.mjs for restoration',
    );
}
