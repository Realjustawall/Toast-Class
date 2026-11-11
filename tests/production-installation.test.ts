import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('production installer creates private resumable configuration, isolated domains and opt-in conversion without leaking passwords', async () => {
  const { prepareProductionInstallation, readPasswordFile } = await import(
    new URL('../scripts/production-installation.mjs', import.meta.url).href
  );
  const { checkDns } = await import(new URL('../scripts/install.mjs', import.meta.url).href);
  const parent = await mkdtemp(join(tmpdir(), 'toaster-production-'));
  const options = {
    directory: join(parent, 'instance'),
    source: '/opt/toaster/source',
    host: 'class.school.test',
    mediaIp: '192.0.2.5',
    email: 'admin@school.test',
    password: 'sixsix',
    dockerGid: 998,
  };
  try {
    const summary = await prepareProductionInstallation(options),
      env = await readFile(join(options.directory, '.env'), 'utf8'),
      compose = await readFile(join(options.directory, 'compose.yaml'), 'utf8'),
      caddy = await readFile(join(options.directory, 'Caddyfile'), 'utf8');
    assert.equal(summary.origin, 'https://class.school.test');
    assert.equal(summary.mathOrigin, 'https://math.class.school.test');
    assert.equal(summary.documents, false);
    assert.ok(!JSON.stringify(summary).includes(options.password));
    assert.ok(!env.includes(options.password));
    assert.match(env, /PRESENTATIONS_ENABLED=false/);
    assert.match(env, /COMPOSE_PROFILES=\n/);
    assert.match(compose, /profiles: \[documents\]/);
    assert.match(compose, /profiles: \[setup\]/);
    assert.match(compose, /bootstrap-admin.js/);
    assert.match(compose, /ADMIN_PASSWORD_FILE: \/run\/admin-password/);
    assert.ok(!compose.includes(options.password));
    assert.match(compose, /REDIS_URL: \$\{REDIS_URL:-false\}/);
    assert.match(compose, /freshclam/);
    assert.match(compose, /signatures:\/var\/lib\/clamav:ro/);
    assert.match(caddy, /math\.\{\$APP_HOST\}/);
    assert.ok(!caddy.includes('tls internal'));
    assert.ok(!caddy.includes('7880'));
    assert.ok(!compose.includes('FILE_ALLOW_UNSCANNED'));
    const media = JSON.parse(
      await readFile(join(options.directory, 'installation/livekit.yaml'), 'utf8'),
    );
    assert.deepEqual(media.bind_addresses, ['127.0.0.1']);
    await assert.rejects(prepareProductionInstallation(options), /EEXIST/);
    assert.equal(await readFile(join(options.directory, '.env'), 'utf8'), env);
    for (const bad of [
      { host: 'https://x.test' },
      { host: 'a..test' },
      { host: 'a'.repeat(64) + '.test' },
      { email: 'a#X=1@b.test' },
      { source: '/tmp/$(id)' },
      { password: 'short' },
      { password: 'sixsix\nBAD=1' },
    ])
      await assert.rejects(
        prepareProductionInstallation({ ...options, directory: join(parent, 'bad'), ...bad }),
      );
    const passwordFile = join(parent, 'input-password');
    await writeFile(passwordFile, 'sixsix\n', { mode: 0o600 });
    assert.equal(await readPasswordFile(passwordFile), 'sixsix');
    if (process.platform !== 'win32') {
      await symlink(passwordFile, join(parent, 'symlink'));
      await assert.rejects(readPasswordFile(join(parent, 'symlink')));
    }
    const config2 = join(parent, 'documents');
    await prepareProductionInstallation({ ...options, directory: config2, documents: true });
    assert.match(await readFile(join(config2, '.env'), 'utf8'), /COMPOSE_PROFILES=documents/);
    const lookedUp: string[] = [];
    await checkDns(
      options.host,
      options.mediaIp,
      async (domain: string) => {
        lookedUp.push(domain);
        return [options.mediaIp];
      },
      async () => [],
    );
    assert.deepEqual(lookedUp, [options.host, 'math.' + options.host]);
    await assert.rejects(
      checkDns(
        options.host,
        options.mediaIp,
        async () => ['192.0.2.9'],
        async () => [],
      ),
      /DNS A/,
    );
    await assert.rejects(
      checkDns(
        options.host,
        options.mediaIp,
        async () => [options.mediaIp],
        async () => ['::1'],
      ),
      /AAAA/,
    );
    const plan = spawnSync(
      process.execPath,
      [
        'scripts/install.mjs',
        'plan',
        '--domain',
        options.host,
        '--media-ip',
        options.mediaIp,
        '--email',
        options.email,
        '--source',
        options.source,
        '--directory',
        join(parent, 'plan'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(plan.status, 0, plan.stderr);
    assert.ok(!plan.stdout.includes(options.password));
    const help = spawnSync(process.execPath, ['scripts/install.mjs', '--help'], {
      encoding: 'utf8',
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /English/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
