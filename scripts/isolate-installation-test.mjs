import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { isIP } from 'node:net';
import { runDocker } from './offline-bundle.mjs';

// Test-only adaptation of the actual generated Compose, not a replacement deployment.
const { values } = parseArgs({
  options: { directory: { type: 'string' }, 'allow-test-network': { type: 'boolean' } },
});
if (!values['allow-test-network'] || !values.directory)
  throw new Error('Explicit dedicated installation test opt-in required');
const directory = resolve(values.directory);
const metadata = JSON.parse(await readFile(resolve(directory, 'installation.json'), 'utf8'));
if (
  !metadata.origin.startsWith('https://127.0.0.1:') ||
  metadata.productionCertification !== 'PENDING' ||
  isIP(metadata.mediaIp) !== 4 ||
  metadata.mediaIp.endsWith('.0') ||
  metadata.mediaIp.endsWith('.255')
)
  throw new Error('Use a dedicated loopback-origin test setup with a private /24 media address');
const octets = metadata.mediaIp.split('.').map(Number);
if (!(
  octets[0] === 10 ||
  (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
  (octets[0] === 192 && octets[1] === 168)
))
  throw new Error('Use an isolated private test subnet');
const network = metadata.mediaIp.split('.').slice(0, 3).join('.') + '.0/24';
const configuration = JSON.parse(
  await runDocker(
    [
      'compose',
      '--env-file',
      resolve(directory, '.env'),
      '-f',
      resolve(directory, 'compose.yaml'),
      'config',
      '--format',
      'json',
    ],
    true,
  ),
);
for (const [name, service] of Object.entries(configuration.services)) {
  if (service.network_mode !== 'host') throw new Error('Unexpected source network mode');
  delete service.network_mode;
  if (name === 'mysql') service.networks = { isolated: { ipv4_address: metadata.mediaIp } };
  else service.network_mode = 'service:mysql';
}
configuration.networks = {
  isolated: {
    internal: true,
    enable_ipv6: false,
    driver_opts: { 'com.docker.network.bridge.enable_ip_masquerade': 'false' },
    ipam: { config: [{ subnet: network }] },
  },
};
await writeFile(
  resolve(directory, 'compose.isolated.json'),
  JSON.stringify(configuration, null, 2) + '\n',
  { mode: 0o600, flag: 'wx' },
);
console.log(
  'Private test Compose created: all actual services share an internal network namespace with no Internet egress. Original deployment configuration is preserved.',
);
