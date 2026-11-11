import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// Test-only localhost Garage configuration. Never rotate a running service.
await mkdir('.local', { recursive: true });
const paths = ['.local/garage-test.toml', '.local/storage-test.env', '.local/storage-test.json'];
if (paths.some(existsSync)) {
  if (!paths.every(existsSync))
    throw new Error('Incomplete local storage configuration; inspect before replacing it');
  const settings = JSON.parse(await readFile(paths[2], 'utf8'));
  if (settings.endpoint !== 'http://127.0.0.1:13900' || settings.bucket !== 'toaster-storage-test')
    throw new Error('Existing storage configuration does not match this test service');
  console.log('Reusing local storage test credentials without rotation.');
} else {
  const accessKeyId = 'GK' + randomBytes(16).toString('hex'),
    secretAccessKey = randomBytes(32).toString('hex'),
    bucket = 'toaster-storage-test';
  await writeFile(
    paths[0],
    `# Generated TOASTER test-only configuration
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "127.0.0.1:13901"
rpc_public_addr = "127.0.0.1:13901"
rpc_secret = "${randomBytes(32).toString('hex')}"
[s3_api]
s3_region = "garage"
api_bind_addr = "127.0.0.1:13900"
root_domain = ".s3.garage.localhost"
[admin]
api_bind_addr = "127.0.0.1:13903"
admin_token = "${randomBytes(32).toString('hex')}"
`,
    { mode: 0o600, flag: 'wx' },
  );
  await writeFile(
    paths[1],
    `GARAGE_DEFAULT_ACCESS_KEY=${accessKeyId}\nGARAGE_DEFAULT_SECRET_KEY=${secretAccessKey}\nGARAGE_DEFAULT_BUCKET=${bucket}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  await writeFile(
    paths[2],
    JSON.stringify({
      endpoint: 'http://127.0.0.1:13900',
      region: 'garage',
      bucket,
      accessKeyId,
      secretAccessKey,
    }),
    { mode: 0o600, flag: 'wx' },
  );
  console.log('Created ignored local storage test configuration; secrets were not printed.');
}
