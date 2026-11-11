import { readFile, writeFile, mkdir, lstat, unlink } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { openVerifiedBackup } from './backup-format.mjs';
import { mysqlDumpFingerprint } from './mysql-dump-fingerprint.mjs';
import { verifyForeignKeys, verifyUniqueKeys } from './mysql-integrity.mjs';
import { loadBackupKey } from './installation-backup.mjs';
import {
  command,
  commandStream,
  loadInstallation,
  mysqlCredentials,
  dumpArguments,
  configurationFiles,
} from './installation-maintenance.mjs';

const imageKeys = [
  'APP_IMAGE',
  'WEB_IMAGE',
  'WORKER_IMAGE',
  'CONVERTER_IMAGE',
  'MYSQL_IMAGE',
  'LIVEKIT_IMAGE',
  'CLAMAV_IMAGE',
];
function unpackConfiguration(bytes) {
  const archive = JSON.parse(bytes.toString('utf8'));
  if (
    archive.version !== 1 ||
    !archive.files ||
    Object.keys(archive.files).sort().join() !== [...configurationFiles].sort().join()
  )
    throw new Error('Unexpected configuration archive');
  const files = {};
  for (const name of configurationFiles) {
    const encoded = archive.files[name];
    if (typeof encoded !== 'string' || encoded.length > 2 * 1024 * 1024)
      throw new Error('Invalid configuration file');
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.toString('base64') !== encoded)
      throw new Error('Noncanonical configuration encoding');
    files[name] = decoded;
  }
  const env = {};
  for (const line of files['.env'].toString().split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const pair = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!pair || Object.hasOwn(env, pair[1])) throw new Error('Invalid archived environment');
    env[pair[1]] = pair[2];
  }
  const metadata = JSON.parse(files['installation.json'].toString());
  if (
    archive.project !== env.COMPOSE_PROJECT_NAME ||
    metadata.projectName !== archive.project ||
    !/^toaster-[a-f0-9]{12}$/.test(archive.project)
  )
    throw new Error('Archived project mismatch');
  for (const key of imageKeys)
    if (!/^sha256:[a-f0-9]{64}$/.test(env[key]) || metadata.images[key] !== env[key])
      throw new Error('Restore requires immutable installed image identities');
  const runtime = new URL(env.DATABASE_URL),
    migration = new URL(env.MIGRATION_DATABASE_URL);
  for (const [url, user] of [
    [runtime, 'toaster'],
    [migration, 'toaster_migrate'],
  ])
    if (
      url.protocol !== 'mysql:' ||
      url.hostname !== '127.0.0.1' ||
      url.pathname !== '/toaster' ||
      url.username !== user ||
      !/^[a-f0-9]{64}$/.test(url.password)
    )
      throw new Error('Unsupported generated database credentials');
  if (!/^[a-f0-9]{64}$/.test(env.MYSQL_ROOT_PASSWORD))
    throw new Error('Unsupported MySQL root configuration');
  return { archive, files, env, metadata, runtime, migration };
}
async function archiveOperation(image, code, chunks, volume, owner = 0) {
  const helper = 'toaster-restore-' + randomUUID();
  const args = [
    'run',
    '--rm',
    '-i',
    '--pull=never',
    '--name',
    helper,
    '--network=none',
    '--read-only',
    '--user=0:0',
    '--cap-drop=ALL',
    '--cap-add=CHOWN',
    '--cap-add=DAC_OVERRIDE',
    '--cap-add=FOWNER',
    '--security-opt=no-new-privileges',
    '--pids-limit=64',
    '--memory=1g',
  ];
  if (volume) args.push('--mount', 'type=volume,source=' + volume + ',target=/restore');
  args.push('--entrypoint=python3', image, '-c', code);
  if (volume) args.push('--destination', '/restore', '--owner', String(owner));
  try {
    return JSON.parse(await command(args, chunks));
  } finally {
    await command(['rm', '-f', helper]).catch(async (error) => {
      if ((await command(['ps', '-a', '-q', '--filter', 'name=^/' + helper + '$'])).trim())
        throw error;
    });
  }
}
export async function restoreInstallation({ backup, keyFile, destination }) {
  if (process.platform !== 'linux') throw new Error('Run recovery on the Linux Docker host');
  const target = resolve(destination);
  try {
    await lstat(target);
    throw new Error('Restore destination must not exist');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const key = await loadBackupKey(keyFile);
  let verified;
  try {
    verified = await openVerifiedBackup(backup, key);
  } finally {
    key.fill(0);
  }
  let created = false,
    credentials,
    context;
  try {
    const code = await readFile(new URL('./restore-volume.py', import.meta.url), 'utf8');
    let configuration, expectedDatabaseHash;
    const expectedVolumes = {};
    // Every archive part is authenticated before this pass. Validate tar paths
    // without mounts before creating any installation/database/volume.
    await verified.consume(async (name, chunks) => {
      if (name === 'configuration.json') {
        const buffers = [];
        let length = 0;
        for await (const bytes of chunks) {
          length += bytes.length;
          if (length > 2 * 1024 * 1024) throw new Error('Configuration limit exceeded');
          buffers.push(bytes);
        }
        configuration = unpackConfiguration(Buffer.concat(buffers));
        for (const key of imageKeys) {
          const [image] = JSON.parse(await command(['image', 'inspect', configuration.env[key]]));
          if (image.Id !== configuration.env[key] || image.Os !== 'linux')
            throw new Error('Required original image not loaded');
        }
      } else if (name === 'database.sql') expectedDatabaseHash = await mysqlDumpFingerprint(chunks);
      else if (name.endsWith('.tar'))
        expectedVolumes[name] = await archiveOperation(
          configuration.env.CONVERTER_IMAGE,
          code,
          chunks,
        );
      else
        for await (const unused of chunks) {
          void unused;
        }
    });
    const project = 'toaster-' + randomBytes(6).toString('hex');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await mkdir(target, { mode: 0o700 });
    created = true;
    await mkdir(join(target, 'installation'), { mode: 0o700 });
    configuration.files['.env'] = Buffer.from(
      configuration.files['.env']
        .toString()
        .replace(/^COMPOSE_PROJECT_NAME=.*$/m, 'COMPOSE_PROJECT_NAME=' + project),
    );
    configuration.metadata.projectName = project;
    configuration.metadata.recovery = {
      sourceProject: configuration.archive.project,
      backedUpAt: configuration.archive.backedUpAt,
    };
    configuration.files['installation.json'] = Buffer.from(
      JSON.stringify(configuration.metadata, null, 2) + '\n',
    );
    // Regenerate bootstrap roles from the CURRENT archived URL values, not old
    // initialization files left behind after a legitimate hex-secret rotation.
    configuration.files['installation/mysql-init.sql'] = Buffer.from(
      `CREATE USER 'toaster'@'%' IDENTIFIED BY '${configuration.runtime.password}';\nGRANT SELECT,INSERT,UPDATE,DELETE ON toaster.* TO 'toaster'@'%';\nCREATE USER 'toaster_migrate'@'%' IDENTIFIED BY '${configuration.migration.password}';\nGRANT ALL PRIVILEGES ON toaster.* TO 'toaster_migrate'@'%';\n`,
    );
    configuration.files['installation/mysql-client.cnf'] = Buffer.from(
      `[client]\nprotocol=TCP\nhost=127.0.0.1\nport=${configuration.runtime.port || 3306}\nuser=toaster\npassword=${configuration.runtime.password}\ndatabase=toaster\n`,
    );
    for (const name of configurationFiles)
      await writeFile(join(target, name), configuration.files[name], {
        mode: name.startsWith('installation/') ? 0o444 : 0o600,
        flag: 'wx',
      });
    await writeFile(
      join(target, 'restore.in-progress.json'),
      JSON.stringify({
        sourceProject: configuration.archive.project,
        project,
        startedAt: new Date().toISOString(),
      }) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    context = await loadInstallation(target);
    const model = JSON.parse(await command([...context.compose, 'config', '--format', 'json']));
    for (const name of ['files', 'caddy-data', 'caddy-config', 'mysql']) {
      if (model.volumes[name]?.name !== project + '_' + name)
        throw new Error('Restore must use new independently named volumes');
      const existing = (await command(['volume', 'ls', '--format', '{{.Name}}'])).split(/\r?\n/);
      if (existing.includes(model.volumes[name].name))
        throw new Error('Restore volume already exists');
    }
    await command([
      ...context.compose,
      'up',
      '-d',
      '--pull',
      'never',
      '--wait',
      '--wait-timeout',
      '180',
      'mysql',
    ]);
    const mysql = (await command([...context.compose, 'ps', '-q', 'mysql'])).trim();
    if (!/^[a-f0-9]{64}$/.test(mysql)) throw new Error('Invalid restored MySQL identity');
    const [record] = JSON.parse(await command(['inspect', mysql]));
    if (record.Config.Labels['com.docker.compose.project'] !== project)
      throw new Error('Restored MySQL ownership mismatch');
    credentials = await mysqlCredentials(context, mysql);
    const count = (
      await command([
        'exec',
        mysql,
        'mysql',
        '--defaults-extra-file=' + credentials.path,
        '--batch',
        '--skip-column-names',
        '--execute',
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='toaster'",
      ])
    ).trim();
    if (count !== '0') throw new Error('Restore database is not empty');
    const volumes = {};
    for (const name of ['files', 'caddy-data', 'caddy-config']) {
      const volume = model.volumes[name].name;
      await command([
        'volume',
        'create',
        '--label',
        'com.docker.compose.project=' + project,
        '--label',
        'com.docker.compose.volume=' + name,
        volume,
      ]);
      volumes[name + '.tar'] = volume;
    }
    const actualVolumes = {};
    await verified.consume(async (name, chunks) => {
      if (name === 'database.sql')
        await command(
          [
            'exec',
            '-i',
            mysql,
            'mysql',
            '--defaults-extra-file=' + credentials.path,
            '--binary-mode',
            '--local-infile=0',
            '--database=toaster',
          ],
          chunks,
        );
      else if (name.endsWith('.tar'))
        actualVolumes[name] = await archiveOperation(
          context.env.CONVERTER_IMAGE,
          code,
          chunks,
          volumes[name],
          name === 'files.tar' ? 1000 : 0,
        );
      else
        for await (const unused of chunks) {
          void unused;
        }
    });
    if (JSON.stringify(actualVolumes) !== JSON.stringify(expectedVolumes))
      throw new Error('Restored volume content verification failed');
    const databaseHash = await mysqlDumpFingerprint(
      commandStream(dumpArguments(mysql, credentials.path)),
    );
    if (databaseHash !== expectedDatabaseHash)
      throw new Error('Restored database canonical dump mismatch');
    const foreignKeysChecked = await verifyForeignKeys(mysql, credentials.path);
    const uniqueKeysChecked = await verifyUniqueKeys(mysql, credentials.path);
    await credentials.close();
    credentials = null;
    const report = {
      version: 1,
      project,
      sourceProject: configuration.archive.project,
      restoredAt: new Date().toISOString(),
      databaseHash,
      fingerprintRule: 'mysql8.4-redundant-charset-v1',
      foreignKeysChecked,
      uniqueKeysChecked,
      archiveSha256: verified.archiveSha256,
      volumes: actualVolumes,
      servicesStarted: ['mysql'],
      activation: 'OPERATOR_REQUIRED_AFTER_ORIGINAL_INSTALLATION_IS_STOPPED',
    };
    await writeFile(join(target, 'restore.verified.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    await unlink(join(target, 'restore.in-progress.json'));
    return report;
  } catch (error) {
    if (created)
      await writeFile(
        join(target, 'restore.failed.json'),
        JSON.stringify({
          failedAt: new Date().toISOString(),
          status: 'INCOMPLETE_DO_NOT_ACTIVATE',
        }) + '\n',
        { mode: 0o600, flag: 'wx' },
      ).catch(() => {});
    throw error;
  } finally {
    try {
      if (credentials) await credentials.close();
    } finally {
      await verified.close();
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      backup: { type: 'string' },
      'key-file': { type: 'string' },
      destination: { type: 'string' },
    },
  });
  await restoreInstallation({
    backup: values.backup,
    keyFile: values['key-file'],
    destination: values.destination,
  });
  console.log(
    'New installation database/volumes restored and content-verified. Only MySQL is running; stop the original installation before explicit activation.',
  );
}
