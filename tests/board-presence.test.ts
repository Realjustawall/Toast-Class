import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { testDatabase } from './database';
import { buildApp } from '../apps/api/src/app';

test(
  'board cursor channels enforce identity, generation, tenants, read-only, reconnect replacement and bounded messages',
  { timeout: 30000 },
  async () => {
    const { pool, cleanup } = await testDatabase(),
      origin = 'http://localhost:5173';
    const app = await buildApp(pool, {
      origin,
      production: false,
      mediaUrl: '',
      mediaKey: '',
      mediaSecret: '',
    });
    const post = (path: string, payload: unknown, cookie: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1' + path,
        headers: { origin, cookie, 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
    const get = (path: string, cookie: string) =>
      app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
    const sockets: Awaited<ReturnType<typeof app.injectWS>>[] = [];
    async function account(name: string) {
      const email = name + '@presence.test';
      assert.equal(
        (await post('/auth/register', { email, name, password: 'presence-test-password' }, ''))
          .statusCode,
        201,
      );
      const response = await post('/auth/login', { email, password: 'presence-test-password' }, '');
      return String(response.headers['set-cookie']).split(';')[0];
    }
    async function eventually(check: () => Promise<boolean>) {
      for (let i = 0; i < 80; i++) {
        if (await check()) return;
        await pause(25);
      }
      assert.fail('Presence state did not converge');
    }
    try {
      const owner = await account('Teacher'),
        student = await account('Student'),
        outsider = await account('Outsider');
      const org = (await post('/organizations', { name: 'Presence school' }, owner)).json().id;
      await post(
        `/organizations/${org}/members`,
        { email: 'Student@presence.test', role: 'student' },
        owner,
      );
      const room = (
        await post(
          `/organizations/${org}/classrooms`,
          {
            enrollmentMode: 'organization',
            name: 'Live board',
            permissions: { studentWhiteboardEnabled: true },
          },
          owner,
        )
      ).json().id;
      const document = (
        await post(
          `/classrooms/${room}/documents`,
          { kind: 'board', name: 'Live cursors', boardFormat: 'excalidraw' },
          owner,
        )
      ).json().id;
      const base = `/classrooms/${room}/documents/${document}/board`,
        generation = (await get(base, owner)).json().generation;
      await app.ready();
      const connect = async (cookie: string, clientId = randomUUID()) => {
        const socket = await app.injectWS(
          '/api/v1' + base + '/presence/live?clientId=' + clientId,
          {
            headers: { origin, cookie },
          },
        );
        sockets.push(socket);
        return socket;
      };
      await assert.rejects(
        app.injectWS('/api/v1' + base + '/presence/live', {
          headers: { origin, cookie: outsider },
        }),
      );
      await assert.rejects(
        app.injectWS('/api/v1' + base + '/presence/live', {
          headers: { origin: 'https://attacker.invalid', cookie: owner },
        }),
      );
      assert.equal((await get(base + '/presence', outsider)).statusCode, 403);
      const ownerId = randomUUID(),
        a = await connect(owner, ownerId),
        b = await connect(student);
      const message = { generation, pointer: { x: 45, y: 65, tool: 'pointer' }, button: 'up' };
      a.send(JSON.stringify(message));
      await eventually(
        async () => (await get(base + '/presence', student)).json().peers.length === 1,
      );
      const peer = (await get(base + '/presence', student)).json().peers[0];
      assert.equal(peer.name, 'Teacher');
      assert.equal(peer.pointer.x, 45);
      assert.equal(
        (await get(base, owner)).json().revision,
        0,
        'Cursors must not mutate persistent content',
      );
      const otherDocument = (
        await post(
          `/classrooms/${room}/documents`,
          { kind: 'board', name: 'Separate board', boardFormat: 'excalidraw' },
          owner,
        )
      ).json().id;
      assert.deepEqual(
        (await get(`/classrooms/${room}/documents/${otherDocument}/board/presence`, student)).json()
          .peers,
        [],
      );
      assert.notEqual(peer.id, ownerId);
      b.send(JSON.stringify({ ...message, pointer: { x: 90, y: 70, tool: 'laser' } }));
      await eventually(
        async () => (await get(base + '/presence', owner)).json().peers.length === 2,
      );
      const replaced = once(a, 'close');
      const a2 = await connect(owner, ownerId);
      await replaced;
      a2.send(JSON.stringify(message));
      await eventually(
        async () => (await get(base + '/presence', owner)).json().peers.length === 2,
      );
      assert.equal(
        (await get(base + '/presence', owner))
          .json()
          .peers.filter((p: { name: string }) => p.name === 'Teacher').length,
        1,
      );
      await post(base + '/access', { teacherOnly: true }, owner);
      const afterLock = (await get(base + '/presence', owner)).json().peers;
      assert.equal(afterLock.length, 1);
      assert.equal(afterLock[0].name, 'Teacher');
      const denied = once(b, 'close');
      b.send(JSON.stringify(message));
      await denied;
      const spy = await connect(owner);
      const bad = once(spy, 'close');
      spy.send(JSON.stringify({ ...message, name: 'Forged teacher' }));
      await bad;
      const huge = await connect(owner);
      const tooBig = once(huge, 'close');
      huge.send('x'.repeat(3000));
      await tooBig;
      const stale = await connect(owner);
      const wrongGeneration = once(stale, 'close');
      stale.send(JSON.stringify({ ...message, generation: randomUUID() }));
      await wrongGeneration;
      const oldCount = (await get(base + '/presence', owner)).json().peers.length;
      assert.equal(oldCount, 1);
      const hidden = await connect(owner);
      hidden.send(JSON.stringify({ ...message, pointer: null }));
      await pause(50);
      assert.equal((await get(base + '/presence', owner)).json().peers.length, 1);
      const gone = once(a2, 'close');
      a2.terminate();
      await gone;
      await eventually(
        async () => (await get(base + '/presence', owner)).json().peers.length === 0,
      );
      const connections = await Promise.all([1, 2, 3].map(() => connect(owner)));
      await assert.rejects(connect(owner), /429/);
      for (const connection of connections) connection.terminate();
    } finally {
      for (const socket of sockets) socket.terminate();
      await app.close();
      await cleanup();
    }
  },
);
