#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve4, resolve6 } from 'node:dns/promises';
import { freemem, totalmem } from 'node:os';
import {
  prepareProductionInstallation,
  readPasswordFile,
  validateProductionOptions,
} from './production-installation.mjs';
import { loadInstallation } from './installation-maintenance.mjs';

export function docker(args, { capture = false, timeout = 3600000 } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn('docker', args, {
      shell: false,
      windowsHide: true,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
      timeout,
    });
    let output = '';
    if (capture) {
      child.stdout.on('data', (b) => {
        output += b;
        if (output.length > 4 * 1024 * 1024) child.kill();
      });
      // Do not echo errors that might contain generated environment values.
      child.stderr.resume();
    }
    child.once('error', () =>
      reject(new Error('Docker could not start; install Docker Engine and the Compose v2 plugin')),
    );
    child.once('exit', (code) =>
      code === 0
        ? accept(output.trim())
        : reject(new Error('Docker command failed: ' + args[0] + ' (exit ' + code + ')')),
    );
  });
}
export async function checkDns(host, mediaIp, resolver4 = resolve4, resolver6 = resolve6) {
  for (const domain of [host, 'math.' + host]) {
    const addresses = await resolver4(domain);
    if (!addresses.length || addresses.some((address) => address !== mediaIp))
      throw new Error('DNS A records for ' + domain + ' must point directly to ' + mediaIp);
    let ipv6 = [];
    try {
      ipv6 = await resolver6(domain);
    } catch (e) {
      if (!['ENODATA', 'ENOTFOUND'].includes(e.code)) throw e;
    }
    if (ipv6.length)
      throw new Error(
        'Remove AAAA records for this IPv4 installation before requesting certificates: ' + domain,
      );
  }
}
async function preflight() {
  if (process.platform !== 'linux')
    throw new Error(
      'Production startup requires a Linux Docker host. Configuration generation is portable.',
    );
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('Node.js 24 or newer is required');
  await docker(['info', '--format', '{{.OSType}}'], { capture: true, timeout: 20000 }).then((v) => {
    if (v !== 'linux') throw new Error('Linux containers are required');
  });
  const version = await docker(['compose', 'version', '--short'], {
    capture: true,
    timeout: 20000,
  });
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  if (!match || +match[1] < 2 || (+match[1] === 2 && +match[2] < 24))
    throw new Error('Docker Compose 2.24 or newer is required');
  if (totalmem() < 4 * 1024 ** 3)
    throw new Error('At least 4 GiB RAM is required for the upload scanner; 8 GiB is recommended');
  if (freemem() < 2 * 1024 ** 3)
    console.log('Available RAM is below 2 GiB; free memory before starting the scanner.');
}
export async function startInstallation(directory, { skipDns = false } = {}) {
  await preflight();
  const context = await loadInstallation(directory),
    { env, metadata } = context;
  if (metadata.topology !== 'production')
    throw new Error('Use this command only with a production installation');
  if (!skipDns) await checkDns(env.APP_HOST, metadata.mediaIp);
  const compose = [...context.compose];
  await docker([...compose, 'config', '--quiet']);
  console.log('Downloading MySQL, the upload scanner and the media server...');
  await docker([...compose, 'pull', 'mysql', 'scanner', 'livekit']);
  console.log('Building application and web assets. The GeoGebra bundle is verified during build.');
  await docker([...compose, 'build', 'api', 'web']);
  if (env.PRESENTATIONS_ENABLED === 'true') {
    await mkdir(env.JOBS_DIR, { recursive: true, mode: 0o770 });
    // Converter containers use gid 65532. Host ownership must match this shared directory.
    const { chown, chmod } = await import('node:fs/promises');
    await chown(env.JOBS_DIR, process.getuid(), 65532);
    await chmod(env.JOBS_DIR, 0o2770);
    await docker([
      'build',
      '-t',
      env.CONVERTER_IMAGE,
      '-f',
      join(env.SOURCE_DIR, 'infrastructure/docker/Dockerfile.converter'),
      env.SOURCE_DIR,
    ]);
    await docker([...compose, 'build', 'worker']);
  }
  console.log('Starting the database and applying migrations...');
  await docker([...compose, 'up', '-d', '--wait', '--wait-timeout', '180', 'mysql']);
  await docker([...compose, 'run', '--rm', 'migrate']);
  console.log('Creating the initial administrator before opening the public site...');
  await docker([...compose, '--profile', 'setup', 'run', '--rm', 'bootstrap']);
  // Record a resumable state without storing or printing passwords.
  await writeFile(join(context.root, 'bootstrap.completed'), new Date().toISOString() + '\n', {
    mode: 0o600,
  });
  const services = [
    'api',
    'livekit',
    'scanner',
    'signatures',
    'web',
    ...(env.PRESENTATIONS_ENABLED === 'true' ? ['worker'] : []),
  ];
  await docker([...compose, 'up', '-d', '--wait', '--wait-timeout', '600', ...services]);
  console.log('Services started. Caddy is requesting trusted HTTPS certificates.');
  await doctor(directory, { wait: true });
  console.log('Sign in at ' + metadata.origin + ' with ' + env.ADMIN_EMAIL + '.');
  console.log(
    'The initial password is stored locally in ' +
      join(context.root, 'installation/admin-password') +
      '. Store it securely and change it in account settings.',
  );
}
export async function doctor(directory, { wait = false } = {}) {
  const context = await loadInstallation(directory),
    { env, metadata } = context;
  await checkDns(env.APP_HOST, metadata.mediaIp);
  const rows = (await docker([...context.compose, 'ps', '--format', 'json'], { capture: true }))
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => JSON.parse(line));
  for (const name of [
    'mysql',
    'scanner',
    'signatures',
    'livekit',
    'api',
    'web',
    ...(metadata.documents ? ['worker'] : []),
  ]) {
    const row = rows.find((row) => row.Service === name);
    if (!row || row.State !== 'running' || (row.Health && row.Health !== 'healthy'))
      throw new Error('Service is not ready: ' + name);
  }
  for (let attempt = 0; attempt < (wait ? 60 : 1); attempt++) {
    try {
      const ready = await fetch(metadata.origin + '/api/v1/app/settings', {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!ready.ok) throw new Error('Application check failed');
      const settings = await ready.json();
      if (typeof settings.registrationOpen !== 'boolean')
        throw new Error('Unexpected public application response');
      const math = await fetch(metadata.mathOrigin + '/geogebra/frame.html', {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!math.ok) throw new Error('Math asset origin is not ready');
      const privateRoute = await fetch(metadata.mathOrigin + '/api/v1/app/settings', {
        signal: AbortSignal.timeout(5000),
      });
      if (privateRoute.status !== 404)
        throw new Error('Math origin must not proxy application APIs');
      console.log(
        'Verified: DNS, running services, trusted HTTPS, application response and isolated math origin.',
      );
      console.log(
        'Validate audio/video from two external networks before accepting classroom traffic.',
      );
      return;
    } catch (e) {
      if (!wait || attempt === 59)
        throw new Error(
          'HTTPS application check failed. Check DNS, ports 80/443 and Caddy logs; rerun doctor.',
        );
      if (attempt % 6 === 0)
        console.log('Waiting for HTTPS certificates and public application readiness...');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      directory: { type: 'string' },
      domain: { type: 'string' },
      'media-ip': { type: 'string' },
      email: { type: 'string' },
      'password-file': { type: 'string' },
      source: { type: 'string' },
      documents: { type: 'boolean', default: false },
      'skip-dns': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  const action = positionals[0] ?? 'install';
  if (values.help) {
    console.log(`TOASTER installer (English)
Usage: node scripts/install.mjs [install|configure|start|doctor|plan] [options]
  --directory /opt/toaster/instance    New private configuration directory
  --domain class.example.com          Application domain (no https://)
  --media-ip 203.0.113.10              Server public IPv4 address
  --email admin@example.com           Administrator and certificate email
  --password-file /private/password   Optional private single-line password file
  --source /opt/toaster/source        Source tree (defaults to this checkout)
  --documents                        Enable optional Office conversion worker
  --skip-dns                         Startup only: postpone DNS check (doctor still checks)
configure generates configuration only. plan validates inputs without writing files.
start resumes an existing setup without replacing its secrets. No command deletes volumes.`);
    return;
  }
  if (
    !['install', 'configure', 'start', 'doctor', 'plan'].includes(action) ||
    positionals.length > 1
  )
    throw new Error('Unknown command; use --help');
  if (['start', 'doctor'].includes(action)) {
    if (!values.directory) throw new Error('--directory is required');
    return action === 'start'
      ? startInstallation(values.directory, { skipDns: values['skip-dns'] })
      : doctor(values.directory);
  }
  const input = {
    host: values.domain,
    mediaIp: values['media-ip'],
    email: values.email,
    directory: values.directory,
    source: values.source ?? dirname(dirname(fileURLToPath(import.meta.url))),
    documents: values.documents,
  };
  if (process.stdin.isTTY && action !== 'plan') {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('TOASTER guided setup. Use a Linux server with Docker Engine and Compose v2.');
      for (const [key, prompt] of [
        ['host', 'Application domain'],
        ['mediaIp', 'Server public IPv4'],
        ['email', 'Administrator email'],
        ['directory', 'New installation directory'],
      ])
        if (!input[key]) input[key] = (await terminal.question(prompt + ': ')).trim();
    } finally {
      terminal.close();
    }
  }
  if (!input.directory) throw new Error('--directory is required');
  const password = values['password-file']
    ? await readPasswordFile(values['password-file'])
    : undefined;
  validateProductionOptions({ ...input, password: password ?? 'generated-on-configuration' });
  if (action === 'plan') {
    console.log(
      JSON.stringify(
        {
          ...input,
          password: '[generated or private file]',
          actions: [
            'private configuration',
            'image build',
            'database migration',
            'initial administrator',
            'HTTPS startup',
            'readiness checks',
          ],
        },
        null,
        2,
      ),
    );
    return;
  }
  if (action === 'install') {
    await preflight();
    if (!values['skip-dns']) await checkDns(input.host, input.mediaIp);
  }
  const gid =
    process.platform === 'linux'
      ? await stat('/var/run/docker.sock')
          .then((info) => info.gid)
          .catch((error) => {
            if (action === 'configure' && error.code === 'ENOENT') return 0;
            throw error;
          })
      : 0;
  await prepareProductionInstallation({ ...input, password, dockerGid: gid });
  console.log(
    'Private configuration created in ' +
      resolve(input.directory) +
      '. Existing installations are never overwritten.',
  );
  if (action === 'install')
    await startInstallation(input.directory, { skipDns: values['skip-dns'] });
  else console.log('Next: node scripts/install.mjs start --directory ' + resolve(input.directory));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Setup failed: ' + error.message);
    process.exitCode = 1;
  });
}
