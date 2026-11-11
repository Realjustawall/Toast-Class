import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, copyFile, chmod, stat } from 'node:fs/promises';
import { resolve, dirname, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isIP } from 'node:net';
import { parseArgs } from 'node:util';

const root = new URL('../', import.meta.url);
export const offlineImages = Object.freeze({
  APP_IMAGE: 'toaster-local/app:0.1.0',
  WEB_IMAGE: 'toaster-local/web:0.1.0',
  WORKER_IMAGE: 'toaster-local/worker:0.1.0',
  CONVERTER_IMAGE: 'toaster-converter:latest',
  MYSQL_IMAGE: 'mysql:8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902',
  LIVEKIT_IMAGE: 'livekit/livekit-server:v1.13.11',
  CLAMAV_IMAGE: 'clamav/clamav:1.4',
});

export async function prepareOfflineInstallation(options) {
  const { host, mediaIp } = options;
  if (
    typeof host !== 'string' ||
    host.length > 253 ||
    !/^[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*$/.test(host)
  )
    throw new Error('Use a hostname or IPv4 address without a scheme, path or port');
  if (isIP(mediaIp ?? '') !== 4 || ['0.0.0.0', '255.255.255.255'].includes(mediaIp))
    throw new Error('A reachable server IPv4 media address is required');
  const offset = Number(options.portOffset ?? 0),
    dockerGid = Number(options.dockerGid ?? 0);
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 14000 ||
    !Number.isInteger(dockerGid) ||
    dockerGid < 0
  )
    throw new Error('Invalid port offset or Docker socket group');
  const ports = Object.fromEntries(
    Object.entries({
      DB_PORT: 3306,
      API_PORT: 3001,
      SFU_PORT: 7880,
      RTC_PORT: 7881,
      HTTPS_PORT: 443,
      SCANNER_PORT: 3310,
      TURN_PORT: 3478,
      UDP_START: 50000,
      UDP_END: 50100,
      RELAY_START: 40000,
      RELAY_END: 41000,
    }).map(([key, value]) => [key, value + offset]),
  );
  const jobs = options.jobsDir ?? '/var/lib/toaster/conversion-jobs';
  if (
    !posix.isAbsolute(jobs) ||
    jobs === '/' ||
    !/^\/[a-zA-Z0-9_./-]+$/.test(jobs) ||
    jobs.split('/').includes('..')
  )
    throw new Error(
      'Use a private absolute Linux jobs directory without traversal or interpolation',
    );
  const images = options.images ?? offlineImages;
  if (
    Object.keys(images).sort().join() !== Object.keys(offlineImages).sort().join() ||
    Object.values(images).some(
      (ref) => typeof ref !== 'string' || !/^[a-z0-9][a-z0-9._:/@-]+$/.test(ref),
    )
  )
    throw new Error('Invalid complete image inventory');
  if (!options.directory) throw new Error('A new installation directory is required');
  const directory = resolve(options.directory),
    installation = resolve(directory, 'installation');
  await mkdir(dirname(directory), { recursive: true });
  // Never rotate an installed database password or overwrite an existing setup.
  await mkdir(directory, { mode: 0o700 });
  await mkdir(installation, { mode: 0o700 });
  const secret = () => randomBytes(32).toString('hex');
  const rootPassword = secret(),
    runtimePassword = secret(),
    migrationPassword = secret(),
    mediaSecret = secret();
  const origin = new URL(`https://${host}:${ports.HTTPS_PORT}`).origin;
  const configuration = {
    ...images,
    ...ports,
    COMPOSE_PROJECT_NAME: 'toaster-' + randomBytes(6).toString('hex'),
    MYSQL_ROOT_PASSWORD: rootPassword,
    DATABASE_URL: `mysql://toaster:${runtimePassword}@127.0.0.1:${ports.DB_PORT}/toaster`,
    MIGRATION_DATABASE_URL: `mysql://toaster_migrate:${migrationPassword}@127.0.0.1:${ports.DB_PORT}/toaster`,
    APP_HOST: host,
    APP_ORIGIN: origin,
    LIVEKIT_API_KEY: 'toaster-local',
    LIVEKIT_API_SECRET: mediaSecret,
    DOCKER_GID: dockerGid,
    JOBS_DIR: jobs,
  };
  await writeFile(
    resolve(directory, '.env'),
    Object.entries(configuration)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  const files = {
    'mysql-init.sql': `CREATE USER 'toaster'@'%' IDENTIFIED BY '${runtimePassword}';\nGRANT SELECT,INSERT,UPDATE,DELETE ON toaster.* TO 'toaster'@'%';\nCREATE USER 'toaster_migrate'@'%' IDENTIFIED BY '${migrationPassword}';\nGRANT ALL PRIVILEGES ON toaster.* TO 'toaster_migrate'@'%';\n`,
    'mysql-client.cnf': `[client]\nprotocol=TCP\nhost=127.0.0.1\nport=${ports.DB_PORT}\nuser=toaster\npassword=${runtimePassword}\ndatabase=toaster\n`,
    'livekit.yaml':
      JSON.stringify(
        {
          port: ports.SFU_PORT,
          bind_addresses: ['127.0.0.1'],
          rtc: {
            node_ip: mediaIp,
            use_external_ip: false,
            tcp_port: ports.RTC_PORT,
            port_range_start: ports.UDP_START,
            port_range_end: ports.UDP_END,
            stun_servers: [`${mediaIp}:${ports.TURN_PORT}`],
          },
          turn: {
            enabled: true,
            tls_port: 0,
            udp_port: ports.TURN_PORT,
            relay_range_start: ports.RELAY_START,
            relay_range_end: ports.RELAY_END,
            allow_restricted_peer_cidrs: [`${mediaIp}/32`],
          },
          keys: { 'toaster-local': mediaSecret },
          webhook: {
            api_key: 'toaster-local',
            urls: [`http://127.0.0.1:${ports.API_PORT}/api/v1/media/webhook`],
          },
        },
        null,
        2,
      ) + '\n',
    'clamd.conf': `Foreground yes\nTCPSocket ${ports.SCANNER_PORT}\nTCPAddr 127.0.0.1\nLocalSocket /tmp/clamd.sock\nFixStaleSocket yes\nDatabaseDirectory /var/lib/clamav\nTemporaryDirectory /tmp\nMaxThreads 2\nMaxQueue 32\nStreamMaxLength 100M\nMaxFileSize 100M\nMaxScanSize 150M\nMaxRecursion 16\nMaxFiles 10000\nAlertExceedsMax yes\n`,
  };
  // Bind-mounted files are readable inside their trusted service container.
  // The host parent directories are private; never publish this installation tree.
  for (const [name, content] of Object.entries(files))
    await writeFile(resolve(installation, name), content, { mode: 0o444, flag: 'wx' });
  for (const name of ['compose.yaml', 'Caddyfile']) {
    await copyFile(new URL('infrastructure/offline/' + name, root), resolve(directory, name));
    await chmod(resolve(directory, name), 0o600);
  }
  const summary = {
    version: 1,
    projectName: configuration.COMPOSE_PROJECT_NAME,
    origin,
    mediaIp,
    ports,
    images,
    jobsDir: jobs,
    productionCertification: 'PENDING',
  };
  await writeFile(
    resolve(directory, 'installation.json'),
    JSON.stringify(summary, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      directory: { type: 'string' },
      host: { type: 'string' },
      'media-ip': { type: 'string' },
      'port-offset': { type: 'string' },
      'jobs-dir': { type: 'string' },
      'docker-gid': { type: 'string' },
    },
  });
  const dockerGid =
    values['docker-gid'] ??
    (process.platform === 'linux' ? String((await stat('/var/run/docker.sock')).gid) : '0');
  const summary = await prepareOfflineInstallation({
    directory: values.directory,
    host: values.host,
    mediaIp: values['media-ip'],
    portOffset: values['port-offset'],
    jobsDir: values['jobs-dir'],
    dockerGid,
  });
  console.log(
    `Private installation configuration created for ${summary.origin}. Existing installations are never overwritten.`,
  );
}
