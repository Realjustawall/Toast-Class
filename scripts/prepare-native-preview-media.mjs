import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

const directory = resolve('.local/runtime');
const env = dotenv.parse(await readFile(resolve(directory, 'native-preview.env')));
if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET)
  throw new Error('The private preview media credentials are missing.');
// This is the local Windows preview only. Never NAT-map all native interfaces
// to 127.0.0.1: Windows cannot send from a LAN-bound socket to that address.
// Preserve real ICE addresses, and resolve privacy-protected mDNS listeners
// without asking them to open a microphone or camera.
const config = `# Local Windows preview; credentials remain on drive E.
port: 37890
bind_addresses: [127.0.0.1]
rtc:
  use_external_ip: false
  enable_loopback_candidate: true
  use_mdns: true
  tcp_port: 37891
  udp_port: 37893
keys:
  ${JSON.stringify(env.LIVEKIT_API_KEY)}: ${JSON.stringify(env.LIVEKIT_API_SECRET)}
webhook:
  api_key: ${JSON.stringify(env.LIVEKIT_API_KEY)}
  urls: ["http://127.0.0.1:3002/api/v1/media/webhook"]
logging:
  level: warn
`;
const target = resolve(directory, 'preview-livekit.yaml');
if (
  (await readFile(target, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  })) !== config
)
  await writeFile(target, config, { mode: 0o600 });
