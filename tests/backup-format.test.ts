import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, chmod, stat } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';

test('encrypted backup streams exact parts, authenticates before restore and refuses overwrite', async () => {
  const { backupParts, writeEncryptedBackup, openVerifiedBackup } = await import(
    new URL('../scripts/backup-format.mjs', import.meta.url).href
  );
  const directory = await mkdtemp(join(tmpdir(), 'toaster-backup-test-'));
  await chmod(directory, 0o700);
  try {
    const key = randomBytes(32),
      path = join(directory, 'snapshot.backup');
    const payloads = backupParts.map((name: string, i: number) =>
      Buffer.concat([
        Buffer.from(name + ' فارسی 😀'),
        randomBytes(i === 2 ? 2_100_000 : i ? 150_000 : 0),
      ]),
    );
    const sources = backupParts.map((name: string, i: number) => ({
      name,
      stream: async function* () {
        yield payloads[i].subarray(0, 5);
        yield payloads[i].subarray(5);
      },
    }));
    const records = await writeEncryptedBackup(path, key, sources);
    const ciphertext = await readFile(path);
    assert.ok(!ciphertext.includes(Buffer.from('فارسی')));
    const verified = await openVerifiedBackup(path, key);
    try {
      assert.deepEqual(verified.records, records);
      assert.equal(verified.archiveSha256, createHash('sha256').update(ciphertext).digest('hex'));
      const restored: Buffer[] = [];
      await verified.consume(async (_name: string, chunks: AsyncIterable<Buffer>) => {
        const pieces = [];
        for await (const piece of chunks) pieces.push(piece);
        restored.push(Buffer.concat(pieces));
      });
      assert.deepEqual(restored, payloads);
      // Mutating the operator's original file cannot change the verified private snapshot.
      const corrupt = Buffer.from(ciphertext);
      corrupt[35] ^= 1;
      await writeFile(path, corrupt);
      const again: Buffer[] = [];
      await verified.consume(async (_name: string, chunks: AsyncIterable<Buffer>) => {
        for await (const chunk of chunks) again.push(chunk);
      });
      assert.ok(again.length > 0);
    } finally {
      await verified.close();
    }
    await assert.rejects(openVerifiedBackup(path, key));
    await writeFile(path, ciphertext);
    await assert.rejects(openVerifiedBackup(path, randomBytes(32)));
    await assert.rejects(writeEncryptedBackup(path, key, sources), /EEXIST/);
    assert.deepEqual(await readFile(path), ciphertext);
    await writeFile(join(directory, 'truncated'), ciphertext.subarray(0, ciphertext.length - 10));
    await assert.rejects(openVerifiedBackup(join(directory, 'truncated'), key));
    await assert.rejects(
      writeEncryptedBackup(join(directory, 'invalid'), key, sources.slice(0, 1)),
      /inventory/,
    );
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('toaster-backup-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});
