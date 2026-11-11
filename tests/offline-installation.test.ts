import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';

test('offline installation creates isolated secrets and rejects overwrite and config injection', async () => {
  const { prepareOfflineInstallation } = await import(
    new URL('../scripts/prepare-offline-installation.mjs', import.meta.url).href
  );
  const parent = await mkdtemp(join(tmpdir(), 'toaster-install-config-'));
  const options = {
    directory: join(parent, 'first'),
    host: 'learn.school.test',
    mediaIp: '192.168.1.20',
    jobsDir: '/var/lib/toaster/jobs',
    portOffset: 11000,
    dockerGid: 1001,
  };
  try {
    const a = await prepareOfflineInstallation(options);
    const b = await prepareOfflineInstallation({ ...options, directory: join(parent, 'second') });
    assert.equal(a.origin, 'https://learn.school.test:11443');
    assert.equal(a.ports.UDP_END, 61100);
    const environment = await readFile(join(options.directory, '.env'), 'utf8');
    const other = await readFile(join(parent, 'second', '.env'), 'utf8');
    const passwords = [
      ...environment.matchAll(
        /(?:mysql:\/\/[^:]+:|MYSQL_ROOT_PASSWORD=|LIVEKIT_API_SECRET=)([a-f0-9]{64})/g,
      ),
    ].map((match) => match[1]);
    assert.equal(passwords.length, 4);
    assert.equal(new Set(passwords).size, 4);
    for (const secret of passwords) {
      assert.ok(!other.includes(secret));
      assert.ok(!JSON.stringify(a).includes(secret));
    }
    assert.notDeepEqual(a, b); // Unique project/secret state must not be reused between installations.
    const yaml = JSON.parse(
      await readFile(join(options.directory, 'installation/livekit.yaml'), 'utf8'),
    );
    assert.equal(yaml.rtc.use_external_ip, false);
    assert.deepEqual(yaml.rtc.stun_servers, ['192.168.1.20:14478']);
    assert.deepEqual(yaml.turn.allow_restricted_peer_cidrs, ['192.168.1.20/32']);
    const sql = await readFile(join(options.directory, 'installation/mysql-init.sql'), 'utf8');
    assert.match(sql, /GRANT SELECT,INSERT,UPDATE,DELETE ON toaster\.\*/);
    assert.match(sql, /GRANT ALL PRIVILEGES ON toaster\.\* TO 'toaster_migrate'/);
    const compose = await readFile(join(options.directory, 'compose.yaml'), 'utf8');
    assert.match(compose, /MIGRATION_DATABASE_URL/);
    assert.match(compose, /pull_policy: never/);
    assert.ok(!compose.includes('MYSQL_USER:'));
    if (process.platform !== 'win32') {
      assert.equal((await stat(options.directory)).mode & 0o777, 0o700);
      assert.equal((await stat(join(options.directory, '.env'))).mode & 0o777, 0o600);
    }
    await assert.rejects(prepareOfflineInstallation(options), /EEXIST/);
    assert.equal(await readFile(join(options.directory, '.env'), 'utf8'), environment);
    for (const invalid of [
      { host: 'learn.test\nEVIL=1' },
      { mediaIp: '127.0.0.1\nkeys: evil' },
      { portOffset: 65535 },
      { dockerGid: -1 },
      { jobsDir: '/tmp/../etc' },
      { jobsDir: '/tmp/$(command)' },
      { images: { APP_IMAGE: 'unsafe' } },
    ])
      await assert.rejects(
        prepareOfflineInstallation({ ...options, directory: join(parent, 'invalid'), ...invalid }),
      );
  } finally {
    assert.equal(dirname(resolve(parent)), resolve(tmpdir()));
    assert.ok(basename(parent).startsWith('toaster-install-config-'));
    await rm(parent, { recursive: true, force: true });
  }
});
