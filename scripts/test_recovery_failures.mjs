import assert from 'node:assert/strict';
import { readFile, writeFile, lstat, mkdtemp, chmod, rm } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { restoreInstallation } from './installation-restore.mjs';
import { backupInstallation } from './installation-backup.mjs';
import {
  loadInstallation,
  inspectInstallation,
  command,
  mysqlCredentials,
} from './installation-maintenance.mjs';
import { verifyForeignKeys, verifyUniqueKeys } from './mysql-integrity.mjs';

const { values } = parseArgs({
  options: {
    installation: { type: 'string' },
    compose: { type: 'string' },
    backup: { type: 'string' },
    'key-file': { type: 'string' },
    'allow-test-data': { type: 'boolean' },
  },
});
if (!values['allow-test-data'] || process.platform !== 'linux')
  throw new Error('Dedicated Linux recovery drill only; explicit --allow-test-data required');
const context = await loadInstallation(values.installation, values.compose);
if (!context.metadata.recovery)
  throw new Error('Run only against a dedicated restored test installation');
const { services } = await inspectInstallation(context),
  mysql = services.mysql.Id;
const directory = await mkdtemp(join(tmpdir(), 'toaster-recovery-negative-'));
await chmod(directory, 0o700);
let credentials,
  mounted = false;
try {
  credentials = await mysqlCredentials(context, mysql);
  const foreignKeys = await verifyForeignKeys(mysql, credentials.path);
  const uniqueKeys = await verifyUniqueKeys(mysql, credentials.path);
  const organization = randomUUID(),
    user = randomUUID();
  const query = (sql) =>
    command([
      'exec',
      mysql,
      'mysql',
      '--defaults-extra-file=' + credentials.path,
      '--database=toaster',
      '--execute',
      sql,
    ]);
  try {
    await query(
      `SET FOREIGN_KEY_CHECKS=0; INSERT INTO memberships(organization_id,user_id,role) VALUES('${organization}','${user}','student')`,
    );
    await assert.rejects(
      verifyForeignKeys(mysql, credentials.path),
      /Foreign-key integrity failed/,
    );
  } finally {
    await query(
      `DELETE FROM memberships WHERE organization_id='${organization}' AND user_id='${user}'`,
    );
  }
  assert.equal(await verifyForeignKeys(mysql, credentials.path), foreignKeys);
  await credentials.close();
  credentials = null;
  const wrongKey = join(directory, 'wrong.key');
  await writeFile(wrongKey, randomBytes(32), { mode: 0o600 });
  const target = join(directory, 'must-not-exist');
  await assert.rejects(
    restoreInstallation({ backup: values.backup, keyFile: wrongKey, destination: target }),
  );
  assert.equal(await lstat(target).catch(() => null), null);
  const encrypted = await readFile(values.backup);
  assert.ok(encrypted.length < 10 * 1024 * 1024, 'Use a small dedicated drill fixture');
  const corrupt = Buffer.from(encrypted);
  corrupt[35] ^= 1;
  const corrupted = join(directory, 'corrupt.toaster');
  await writeFile(corrupted, corrupt, { mode: 0o600 });
  await assert.rejects(
    restoreInstallation({ backup: corrupted, keyFile: values['key-file'], destination: target }),
  );
  assert.equal(await lstat(target).catch(() => null), null);
  const unchanged = createHash('sha256')
    .update(await readFile(join(context.root, '.env')))
    .digest('hex');
  await assert.rejects(
    restoreInstallation({
      backup: values.backup,
      keyFile: values['key-file'],
      destination: context.root,
    }),
    /must not exist/,
  );
  assert.equal(
    createHash('sha256')
      .update(await readFile(join(context.root, '.env')))
      .digest('hex'),
    unchanged,
  );
  let failureResume = 'NOT_RUN_NEEDS_ROOT';
  if (process.getuid() === 0) {
    const full = join(directory, 'full');
    await execFileSync('mkdir', ['-m', '0700', full]);
    execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=4096,mode=0700', 'tmpfs', full]);
    mounted = true;
    try {
      await assert.rejects(
        backupInstallation({
          directory: context.root,
          composeName: values.compose,
          destination: join(full, 'must-not-publish.toaster'),
          keyFile: values['key-file'],
          maintenance: true,
        }),
        /ENOSPC|no space/i,
      );
      assert.equal(await lstat(join(full, 'must-not-publish.toaster')).catch(() => null), null);
      const after = await inspectInstallation(context);
      for (const name of ['api', 'worker', 'web', 'livekit'])
        assert.equal(after.services[name].State.Running, true);
      assert.equal(await lstat(join(context.root, '.maintenance-lock')).catch(() => null), null);
      failureResume = 'PASSED_ENOSPC';
    } finally {
      execFileSync('umount', [full]);
      mounted = false;
    }
  }
  console.log(
    JSON.stringify({
      foreignKeys,
      uniqueKeys,
      orphanDetectedAndRemoved: true,
      wrongKeyNoMutation: true,
      corruptedNoMutation: true,
      existingTargetPreserved: true,
      failureResume,
    }),
  );
} finally {
  if (credentials) await credentials.close();
  if (mounted) execFileSync('umount', [join(directory, 'full')]);
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('toaster-recovery-negative-'));
  await rm(directory, { recursive: true, force: true });
}
