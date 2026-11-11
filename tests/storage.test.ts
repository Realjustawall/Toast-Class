import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { S3ObjectStorage } from '../apps/api/src/object-storage';
import { testStorage } from './storage-fixture';

test('S3 adapter transmits conditional-create, exact length and original bytes', async () => {
  const disk = await testStorage(),
    key = randomUUID(),
    bytes = Buffer.from('private storage contract');
  const source = join(disk.root, 'source.txt');
  let received: { condition?: string; length?: string; bytes: Buffer; path?: string };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received = {
      condition: req.headers['if-none-match'] as string | undefined,
      length: req.headers['content-length'],
      bytes: Buffer.concat(chunks),
      path: req.url,
    };
    res.writeHead(200, { ETag: '"test-etag"' }).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture address');
  const storage = new S3ObjectStorage({
    endpoint: `http://127.0.0.1:${address.port}`,
    region: 'us-east-1',
    bucket: 'toaster-contract-test',
    accessKeyId: 'test-only-access',
    secretAccessKey: 'test-only-secret',
  });
  try {
    await writeFile(source, bytes);
    await storage.put(key, source, bytes.length, 'text/plain');
    assert.equal(received!.condition, '*');
    assert.equal(received!.length, String(bytes.length));
    assert.deepEqual(received!.bytes, bytes);
    assert.ok(received!.path?.startsWith('/toaster-contract-test/' + key));
  } finally {
    storage.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await disk.cleanup();
  }
});

test(
  'real S3 provider: immutable put, bytes, ranges, private access and idempotent delete',
  { skip: !process.env.TEST_S3_CONFIG, timeout: 60000 },
  async () => {
    const settings = z
      .object({
        endpoint: z.url(),
        region: z.string().min(1),
        bucket: z.string().endsWith('-test'),
        accessKeyId: z.string().min(1),
        secretAccessKey: z.string().min(1),
      })
      .parse(JSON.parse(await readFile(process.env.TEST_S3_CONFIG!, 'utf8')));
    const storage = new S3ObjectStorage(settings),
      disk = await testStorage(),
      key = randomUUID(),
      raceKey = randomUUID(),
      source = join(disk.root, 'source.bin'),
      replacement = join(disk.root, 'replacement.bin'),
      bytes = randomBytes(300000);
    const collect = async (range?: { start: number; end: number }, objectKey = key) => {
      const stream = await storage.get(objectKey, range);
      const chunks: Buffer[] = [];
      let count = 0;
      for await (const chunk of stream) {
        count += chunk.length;
        if (count > bytes.length) throw new Error('Unexpectedly large storage response');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    };
    try {
      await writeFile(source, bytes);
      await writeFile(replacement, Buffer.from('different content'));
      await storage.put(key, source, bytes.length, 'application/octet-stream');
      assert.deepEqual(await collect(), bytes);
      assert.deepEqual(await collect({ start: 65000, end: 131000 }), bytes.subarray(65000, 131001));
      await assert.rejects(
        storage.put(key, replacement, 17, 'text/plain'),
        (error: unknown) =>
          (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 412,
        'Provider must enforce If-None-Match and preserve the original object',
      );
      assert.deepEqual(await collect(), bytes);
      const anonymous = await fetch(
        settings.endpoint + '/' + encodeURIComponent(settings.bucket) + '/' + key,
        { signal: AbortSignal.timeout(10000) },
      );
      await anonymous.body?.cancel();
      assert.ok(
        [400, 401, 403, 404].includes(anonymous.status),
        'Test bucket must not expose anonymous objects',
      );
      const unauthorized = new S3ObjectStorage({
        ...settings,
        secretAccessKey: randomBytes(32).toString('hex'),
      });
      try {
        await assert.rejects(
          unauthorized.get(key),
          (error: unknown) =>
            (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ===
            403,
        );
      } finally {
        unauthorized.close();
      }
      const raced = await Promise.allSettled([
        storage.put(raceKey, source, bytes.length, 'application/octet-stream'),
        storage.put(raceKey, replacement, 17, 'text/plain'),
      ]);
      assert.equal(
        raced.filter((r) => r.status === 'fulfilled').length,
        1,
        'Concurrent conditional creates must have exactly one winner',
      );
      for (const result of raced)
        if (result.status === 'rejected')
          assert.equal(
            result.reason?.$metadata?.httpStatusCode,
            412,
            'The losing writer must receive a precondition failure',
          );
      assert.deepEqual(
        await collect(undefined, raceKey),
        raced[0].status === 'fulfilled' ? bytes : Buffer.from('different content'),
      );
      await storage.delete(key);
      await storage.delete(key);
      await assert.rejects(
        storage.get(key),
        (error: unknown) =>
          (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404,
      );
      await assert.rejects(storage.get('../outside'));
    } finally {
      try {
        await Promise.all([storage.delete(key), storage.delete(raceKey)]);
      } finally {
        storage.close();
        await disk.cleanup();
      }
    }
  },
);
