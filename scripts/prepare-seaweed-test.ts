import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

await mkdir('.local', { recursive: true });
const path = '.local/seaweed-test.json',
  auth = '.local/seaweed-s3.json';
if (!existsSync(path) && !existsSync(auth)) {
  const settings = {
    endpoint: 'http://127.0.0.1:18333',
    region: 'us-east-1',
    bucket: 'toaster-storage-test',
    accessKeyId: randomBytes(16).toString('hex'),
    secretAccessKey: randomBytes(32).toString('hex'),
  };
  await writeFile(path, JSON.stringify(settings), { mode: 0o600, flag: 'wx' });
  await writeFile(
    auth,
    JSON.stringify({
      identities: [
        {
          name: 'toaster-local-test',
          credentials: [{ accessKey: settings.accessKeyId, secretKey: settings.secretAccessKey }],
          actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
        },
      ],
    }),
    { mode: 0o600, flag: 'wx' },
  );
} else if (!existsSync(path) || !existsSync(auth))
  throw new Error('Incomplete test configuration; inspect before replacing it');
const settings = JSON.parse(await readFile(path, 'utf8'));
if (settings.endpoint !== 'http://127.0.0.1:18333' || settings.bucket !== 'toaster-storage-test')
  throw new Error('Refusing unexpected storage configuration');
if (process.argv.includes('--create-bucket')) {
  const client = new S3Client({
    endpoint: settings.endpoint,
    region: settings.region,
    forcePathStyle: true,
    credentials: settings,
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  try {
    try {
      await client.send(new HeadBucketCommand({ Bucket: settings.bucket }), {
        abortSignal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404)
        throw error;
      await client.send(new CreateBucketCommand({ Bucket: settings.bucket }), {
        abortSignal: AbortSignal.timeout(10000),
      });
    }
  } finally {
    client.destroy();
  }
  console.log('Dedicated local SeaweedFS test bucket is ready.');
} else console.log('Local SeaweedFS test configuration ready; credentials remain ignored.');
