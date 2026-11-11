import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || /[\r\n]/.test(databaseUrl) || !new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('Use a dedicated TEST_DATABASE_URL ending in _test');
const nodeIp =
  process.env.TEST_MEDIA_NODE_IP ??
  Object.values(networkInterfaces())
    .flat()
    .find((i) => i?.family === 'IPv4' && !i.internal)?.address;
if (!nodeIp || !isIPv4(nodeIp))
  throw new Error('Set TEST_MEDIA_NODE_IP to the reachable Linux SFU IPv4 address');
await mkdir('.local', { recursive: true });
const configPath = '.local/livekit-linux.yaml';
const envPath = '.local/linux-test.env';
if ((existsSync(configPath) || existsSync(envPath)) && !process.argv.includes('--rotate')) {
  const [config, environment] = await Promise.all([
    readFile(configPath, 'utf8'),
    readFile(envPath, 'utf8'),
  ]);
  if (
    !config.startsWith('# Generated TOASTER local Linux test configuration\n') ||
    !config.includes(`  node_ip: ${nodeIp}\n`) ||
    !environment.includes(`TEST_DATABASE_URL=${databaseUrl}\n`)
  )
    throw new Error('Existing configuration differs. Stop its SFU, then run with --rotate.');
  console.log('Reusing matching local Linux test configuration without rotating credentials.');
} else {
  const secret = randomBytes(32).toString('hex');
  const apiKey = 'toaster-local-test';
  await writeFile(
    '.local/livekit-linux.yaml',
    `# Generated TOASTER local Linux test configuration
port: 17880
bind_addresses: ["127.0.0.1"]
rtc:
  node_ip: ${nodeIp}
  tcp_port: 17881
  port_range_start: 52000
  port_range_end: 52100
keys:
  ${apiKey}: ${secret}
webhook:
  api_key: ${apiKey}
  urls: ["http://127.0.0.1:33001/api/v1/media/webhook"]
`,
    { mode: 0o600 },
  );
  await writeFile(
    '.local/linux-test.env',
    `TEST_DATABASE_URL=${databaseUrl}
TEST_MEDIA_URL=ws://127.0.0.1:17880
TEST_MEDIA_KEY=${apiKey}
TEST_MEDIA_SECRET=${secret}
TEST_MEDIA_WEBHOOKS=true
TEST_API_HOST=0.0.0.0
`,
    { mode: 0o600 },
  );
  console.log(
    'Wrote ignored Linux SFU configuration and test environment. Credentials were not printed.',
  );
}
