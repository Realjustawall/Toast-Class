import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import { OptionalCache } from '../apps/api/src/optional-cache';
import { buildApp } from '../apps/api/src/app';
import { testDatabase } from './database';

// A bounded RESP fixture exercises the installed official node-redis client.
// This is a protocol/failure test; it does not claim a real Redis deployment.
test(
  'optional Redis cache shares versioned data, bounds stalls, isolates namespaces and never caches authorization',
  { timeout: 30000 },
  async () => {
    const values = new Map<string, string>(),
      sockets = new Set<Socket>();
    let stall = false;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length) {
          const end = buffer.indexOf('\r\n');
          if (end < 0) return;
          const count = Number(buffer.subarray(1, end).toString());
          let position = end + 2;
          const args: string[] = [];
          for (let n = 0; n < count; n++) {
            const e = buffer.indexOf('\r\n', position);
            if (e < 0) return;
            const size = Number(buffer.subarray(position + 1, e).toString());
            if (buffer.length < e + 2 + size + 2) return;
            args.push(buffer.subarray(e + 2, e + 2 + size).toString());
            position = e + 2 + size + 2;
          }
          buffer = buffer.subarray(position);
          const command = args[0].toUpperCase();
          if (command === 'GET') {
            if (stall) continue;
            const value = values.get(args[1]);
            socket.write(
              value === undefined
                ? '$-1\r\n'
                : '$' + Buffer.byteLength(value) + '\r\n' + value + '\r\n',
            );
          } else if (command === 'SET') {
            assert.equal(args[3], 'EX');
            assert.equal(args[4], '30');
            values.set(args[1], args[2]);
            socket.write('+OK\r\n');
          } else socket.write('+OK\r\n');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number },
      url = 'redis://127.0.0.1:' + address.port;
    const cache = new OptionalCache(url, 'database-a'),
      peer = new OptionalCache(url, 'database-a'),
      other = new OptionalCache(url, 'database-b');
    const { pool, cleanup } = await testDatabase(),
      origin = 'http://localhost:5173';
    const app = await buildApp(pool, {
      origin,
      redisUrl: url,
      production: false,
      mediaUrl: '',
      mediaKey: '',
      mediaSecret: '',
    });
    try {
      for (let i = 0; i < 100 && (!cache.available || !peer.available || !other.available); i++)
        await pause(10);
      assert.equal(cache.available, true);
      console.info('Redis protocol fixture ready');
      let loads = 0;
      const load = async () => ({ value: ++loads });
      assert.deepEqual(await cache.read('room:1', load), { value: 1 });
      assert.deepEqual(await peer.read('room:1', load), { value: 1 });
      assert.deepEqual(await cache.read('room:2', load), { value: 2 });
      assert.deepEqual(await other.read('room:1', load), { value: 3 });
      console.info('Redis cache sharing and namespace isolation verified');
      const post = (path: string, data: unknown, cookie = '') =>
        app.inject({
          method: 'POST',
          url: '/api/v1' + path,
          headers: { origin, cookie },
          payload: data as object,
        });
      const account = async (name: string) => {
        const email = name + '@redis.test';
        const created = await post('/auth/register', { name, email, password: '123456' });
        assert.equal(created.statusCode, 201);
        const login = await post('/auth/login', { email, password: '123456' });
        return {
          id: created.json().id,
          email,
          cookie: String(login.headers['set-cookie']).split(';')[0],
        };
      };
      const owner = await account('Owner'),
        student = await account('Learner');
      const org = (await post('/organizations', { name: 'Cached chat' }, owner.cookie)).json();
      await post(
        '/organizations/' + org.id + '/members',
        { email: student.email, role: 'student' },
        owner.cookie,
      );
      const room = (
          await post(
            '/organizations/' + org.id + '/classrooms',
            { name: 'Cache', enrollmentMode: 'organization' },
            owner.cookie,
          )
        ).json(),
        base = '/classrooms/' + room.id;
      const get = () =>
        app.inject({
          method: 'GET',
          url: '/api/v1' + base + '/messages',
          headers: { cookie: student.cookie },
        });
      const sent = (await post(base + '/messages', { body: 'one' }, owner.cookie)).json();
      console.info('Cached chat fixture created');
      assert.equal((await get()).json()[0].body, 'one');
      await get();
      await post(
        base + '/messages/' + sent.id + '/edit',
        { body: 'two', expectedBody: 'one' },
        owner.cookie,
      );
      assert.equal((await get()).json()[0].body, 'two');
      await post(base + '/user-permissions/' + student.id, { kicked: true }, owner.cookie);
      assert.equal((await get()).statusCode, 403);
      await post(base + '/user-permissions/' + student.id, { kicked: false }, owner.cookie);
      await post(base + '/messages/clear', {}, owner.cookie);
      assert.deepEqual((await get()).json(), []);
      console.info('Fresh chat authorization and invalidation verified');
      stall = true;
      const start = performance.now();
      assert.deepEqual(await cache.read('stalled', load), { value: 4 });
      assert.ok(
        performance.now() - start < 500,
        'Redis stalls must fall back to the database promptly',
      );
      console.info('Redis stalled command fallback verified');
    } finally {
      cache.close();
      peer.close();
      other.close();
      await app.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await cleanup();
    }
  },
);
