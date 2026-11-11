import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { buildApp } from '../apps/api/src/app';
import { testDatabase } from './database';

test(
  'temporary authorization storage errors preserve live access, then real revocation closes with policy code',
  { timeout: 65000 },
  async () => {
    const { pool, cleanup } = await testDatabase();
    let unavailable = false,
      failures = 0;
    const unstable = new Proxy(pool, {
      get(target, key) {
        if (key === 'query')
          return (...args: unknown[]) => {
            if (unavailable && String(args[0]).includes('JOIN auth_sessions')) {
              failures++;
              return Promise.reject(new Error('Simulated temporary storage outage'));
            }
            return (target.query as Function).apply(target, args);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const origin = 'http://localhost:5173';
    const app = await buildApp(unstable, {
      origin,
      production: false,
      mediaUrl: '',
      mediaKey: '',
      mediaSecret: '',
      mediaWorker: false,
      breakoutWorker: false,
    });
    let socket: WebSocket | undefined;
    const post = (path: string, body: object, cookie = '') =>
      app.inject({
        method: 'POST',
        url: '/api/v1' + path,
        headers: { origin, cookie },
        payload: body,
      });
    const message = (type: string) =>
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error('Heartbeat deadline exceeded')), 20000);
        const receive = (data: WebSocket.RawData) => {
          if (JSON.parse(data.toString()).type === type) finish();
        };
        const closed = () => finish(new Error('Live socket unexpectedly closed'));
        const finish = (error?: Error) => {
          clearTimeout(timeout);
          socket!.off('message', receive);
          socket!.off('close', closed);
          error ? reject(error) : resolve();
        };
        socket!.on('message', receive);
        socket!.once('close', closed);
      });
    try {
      const email = randomUUID() + '@live-auth.test',
        password = 'valid-authorization-test';
      const user = (
        await post('/auth/register', { email, password, name: 'Live authorization' })
      ).json();
      const login = await post('/auth/login', { email, password });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const org = (await post('/organizations', { name: 'Live auth test' }, cookie)).json();
      const room = (
        await post('/organizations/' + org.id + '/classrooms', { name: 'Live room' }, cookie)
      ).json();
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      socket = new WebSocket(
        address.replace('http:', 'ws:') + '/api/v1/classrooms/' + room.id + '/live',
        { headers: { origin, cookie } },
      );
      await message('ready');
      unavailable = true;
      await message('heartbeat');
      assert.ok(failures > 0, 'The test must exercise a storage failure');
      assert.equal(
        socket.readyState,
        WebSocket.OPEN,
        'Storage pressure must not permanently deny a valid user',
      );
      unavailable = false;
      await message('heartbeat');
      await pool.query('DELETE FROM auth_sessions WHERE user_id=$1', [user.id]);
      const code = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Revocation was not enforced')), 20000);
        socket!.once('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      assert.equal(code, 1008, 'Revoked sessions must close as unauthorized');
    } finally {
      socket?.terminate();
      await app.close();
      await cleanup();
    }
  },
);
