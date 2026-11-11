import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
const secret = randomBytes(32).toString('hex');
const nodeIp = Object.values(networkInterfaces())
  .flat()
  .find((a) => a?.family === 'IPv4' && !a.internal)?.address;
if (!nodeIp || !process.env.GITHUB_ENV)
  throw new Error('Run in a Linux GitHub runner with a reachable IPv4 interface');
await mkdir('.local', { recursive: true });
await writeFile(
  '.local/livekit-ci.yaml',
  `port: 7880
bind_addresses: ["127.0.0.1"]
rtc:
  node_ip: ${nodeIp}
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
keys:
  toastertest: ${secret}
webhook:
  api_key: toastertest
  urls: ["http://127.0.0.1:33001/api/v1/media/webhook"]
`,
);
// GitHub runner control command; the ephemeral key is masked in subsequent logs.
console.log(`::add-mask::${secret}`);
await appendFile(
  process.env.GITHUB_ENV,
  `TEST_MEDIA_KEY=toastertest\nTEST_MEDIA_SECRET=${secret}\nTEST_MEDIA_URL=ws://127.0.0.1:7880\nTEST_MEDIA_WEBHOOKS=true\n`,
);
