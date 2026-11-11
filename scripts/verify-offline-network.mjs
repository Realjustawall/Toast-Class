import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';

// Run inside the isolated Linux test namespace, never on the developer's host.
assert.equal(process.env.TOASTER_OFFLINE_TEST, 'true', 'Explicit offline test opt-in required');
assert.equal(process.platform, 'linux');
for (const key of [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
])
  assert.ok(!process.env[key], 'Offline test must not inherit an external proxy: ' + key);
const routes = (await readFile('/proc/net/route', 'utf8')).trim().split('\n').slice(1);
assert.ok(
  routes.every((line) => line.trim().split(/\s+/)[1] !== '00000000'),
  'IPv4 default route is forbidden',
);
const v6 = (await readFile('/proc/net/ipv6_route', 'utf8')).trim().split('\n').filter(Boolean);
assert.ok(
  v6.every((line) => {
    const fields = line.trim().split(/\s+/);
    // Linux reports an unreachable ::/0 sentinel on lo; it is not an egress route.
    return fields[0] !== '0'.repeat(32) || fields[1] !== '00' || fields.at(-1) === 'lo';
  }),
  'IPv6 default egress route is forbidden',
);
const socketResult = (host, port) =>
  new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(2000);
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('timeout');
    });
    socket.once('error', (error) => {
      socket.destroy();
      resolve(error.code);
    });
  });
const databasePort = Number(process.env.TOASTER_TEST_DB_PORT ?? 3306);
assert.ok(Number.isInteger(databasePort) && databasePort > 0 && databasePort < 65536);
assert.equal(
  await socketResult('127.0.0.1', databasePort),
  'connected',
  'Local MySQL must be reachable',
);
assert.notEqual(
  await socketResult('1.1.1.1', 443),
  'connected',
  'Public network must be inaccessible',
);
console.log(
  'Offline namespace verified: local MySQL reachable, no IPv4/IPv6 default egress, no proxy, public TCP unavailable.',
);
