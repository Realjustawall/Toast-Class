import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { testDatabase, hasRealDatabase } from './database';
import { buildApp } from '../apps/api/src/app';
test('private threads isolate participants, target socket events, survive retries and enforce independent public/private policies with fresh authorization', async () => {
  const { pool, cleanup } = await testDatabase(),
    origin = 'http://localhost:5173',
    app = await buildApp(pool, {
      origin,
      production: false,
      mediaUrl: '',
      mediaKey: '',
      mediaSecret: '',
    }),
    sockets: WebSocket[] = [];
  const post = (path: string, data: object, cookie: string, requestOrigin = origin) =>
      app.inject({
        method: 'POST',
        url: '/api/v1' + path,
        headers: { origin: requestOrigin, cookie },
        payload: data,
      }),
    get = (path: string, cookie: string) =>
      app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
  const account = async (name: string) => {
    const email = name + '@private-chat.test',
      r = await post('/auth/register', { name, email, password: '123456' }, '');
    assert.equal(r.statusCode, 201);
    const login = await post('/auth/login', { email, password: '123456' }, '');
    return { id: r.json().id, email, cookie: String(login.headers['set-cookie']).split(';')[0] };
  };
  try {
    const owner = await account('Owner'),
      alice = await account('Alice'),
      bob = await account('Bob'),
      carol = await account('Carol'),
      foreign = await account('Foreign'),
      org = (await post('/organizations', { name: 'Private conversations' }, owner.cookie)).json();
    for (const u of [alice, bob, carol])
      await post(
        '/organizations/' + org.id + '/members',
        { email: u.email, role: 'student' },
        owner.cookie,
      );
    const room = (
        await post(
          '/organizations/' + org.id + '/classrooms',
          { name: 'Assigned class', memberIds: [alice.id, bob.id] },
          owner.cookie,
        )
      ).json(),
      base = '/classrooms/' + room.id,
      thread = (peer: string) => base + '/private-chats/' + peer + '/messages';
    const initial = (await get(base + '/chat-policy', alice.cookie)).json();
    assert.equal(initial.publicEnabled, true);
    assert.equal(initial.privateEnabled, true);
    assert.deepEqual(
      initial.participants.map((p: { id: string }) => p.id).sort(),
      [owner.id, bob.id].sort(),
    );
    assert.equal((await get(base + '/chat-policy', carol.cookie)).statusCode, 403);
    assert.equal((await get(base + '/chat-policy', foreign.cookie)).statusCode, 403);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const eventLists: string[][] = [];
    for (const user of [owner, alice, bob]) {
      const events: string[] = [],
        socket = new WebSocket('ws://127.0.0.1:' + address.port + '/api/v1' + base + '/live', {
          headers: { origin, cookie: user.cookie },
        });
      sockets.push(socket);
      eventLists.push(events);
      socket.on('message', (bytes) => {
        const value = JSON.parse(bytes.toString());
        if (value.type === 'private_chat_changed') assert.deepEqual(Object.keys(value), ['type']);
        events.push(value.type);
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
    }
    const payload = { body: '**A private lesson**', clientMessageId: randomUUID() },
      sent = await post(thread(bob.id), payload, alice.cookie);
    assert.equal(sent.statusCode, 201, sent.body);
    const id = sent.json().id;
    for (let i = 0; i < 100 && !eventLists[2].includes('private_chat_changed'); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(eventLists[1].includes('private_chat_changed'));
    assert.ok(eventLists[2].includes('private_chat_changed'));
    assert.equal(eventLists[0].includes('private_chat_changed'), false);
    assert.equal((await get(base + '/messages', owner.cookie)).json().length, 0);
    assert.equal((await get(thread(bob.id), owner.cookie)).json().length, 0);
    assert.equal((await get(thread(alice.id), bob.cookie)).json()[0].body, payload.body);
    assert.equal((await get(base + '/chat-policy', bob.cookie)).json().unread.length, 0);
    assert.equal((await post(thread(bob.id), payload, alice.cookie)).json().id, id);
    assert.equal(
      (await post(thread(bob.id), { ...payload, body: 'Different' }, alice.cookie)).statusCode,
      409,
    );
    assert.equal(
      (
        await post(
          thread(carol.id),
          { body: 'Forbidden peer', clientMessageId: randomUUID() },
          alice.cookie,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (await post(thread(alice.id), { body: 'Self', clientMessageId: randomUUID() }, alice.cookie))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await post(
          thread(alice.id) + '/' + id + '/edit',
          { body: 'Intrusion', expectedBody: payload.body },
          bob.cookie,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await post(
          thread(bob.id) + '/' + id + '/edit',
          { body: 'Intrusion', expectedBody: payload.body },
          owner.cookie,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await post(
          thread(bob.id) + '/' + id + '/edit',
          { body: 'Edited privately', expectedBody: payload.body },
          alice.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await post(
          thread(bob.id) + '/' + id + '/edit',
          { body: 'Stale', expectedBody: payload.body },
          alice.cookie,
        )
      ).statusCode,
      409,
    );
    assert.equal((await get(thread(alice.id), bob.cookie)).json()[0].body, 'Edited privately');
    assert.equal(
      (await post(base + '/messages/' + id + '/delete', {}, owner.cookie)).statusCode,
      404,
    );
    assert.equal(
      (await post(thread(alice.id) + '/' + id + '/delete', {}, bob.cookie)).statusCode,
      404,
    );
    assert.equal(
      (await post(thread(bob.id) + '/' + id + '/delete', {}, alice.cookie)).statusCode,
      200,
    );
    assert.equal((await post(thread(bob.id), payload, alice.cookie)).json().id, id);
    assert.equal((await get(thread(alice.id), bob.cookie)).json().length, 0);
    const policy = async (pub: boolean, priv: boolean, cookie = owner.cookie) => {
      const old = (await get(base + '/chat-policy', cookie)).json();
      return post(
        base + '/chat-policy',
        { publicEnabled: pub, privateEnabled: priv, expectedRevision: old.revision },
        cookie,
      );
    };
    assert.equal((await policy(false, true, alice.cookie)).statusCode, 403);
    assert.equal((await policy(false, true)).statusCode, 200);
    assert.equal(
      (await post(base + '/messages', { body: 'Blocked public' }, alice.cookie)).statusCode,
      403,
    );
    assert.equal(
      (await post(base + '/messages', { body: 'Blocked public moderator' }, owner.cookie))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          thread(bob.id),
          { body: 'Private remains open', clientMessageId: randomUUID() },
          alice.cookie,
        )
      ).statusCode,
      201,
    );
    assert.equal((await policy(true, false)).statusCode, 200);
    assert.equal(
      (await post(base + '/messages', { body: 'Public remains open' }, alice.cookie)).statusCode,
      201,
    );
    assert.equal(
      (
        await post(
          thread(bob.id),
          { body: 'Blocked private', clientMessageId: randomUUID() },
          alice.cookie,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (await get(thread(alice.id), bob.cookie)).json().length,
      1,
      'Disabled writing preserves readable history',
    );
    assert.equal(
      (
        await post(
          base + '/chat-policy',
          { publicEnabled: true, privateEnabled: true, expectedRevision: 0 },
          owner.cookie,
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await post(
          base + '/chat-policy',
          { publicEnabled: true, privateEnabled: true, expectedRevision: 2 },
          owner.cookie,
          'https://untrusted.test',
        )
      ).statusCode,
      403,
    );
    await policy(true, true);
    await post(base + '/user-permissions/' + alice.id, { canChat: false }, owner.cookie);
    assert.equal(
      (await post(thread(bob.id), { body: 'Locked', clientMessageId: randomUUID() }, alice.cookie))
        .statusCode,
      403,
    );
    await post(base + '/user-permissions/' + alice.id, { canChat: null }, owner.cookie);
    if (hasRealDatabase) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [room.id]);
        const pending = post(
          thread(bob.id),
          { body: 'Queued before revocation', clientMessageId: randomUUID() },
          alice.cookie,
        );
        await c.query(
          'UPDATE classroom_chat_policies SET private_enabled=false,revision=revision+1 WHERE classroom_id=$1',
          [room.id],
        );
        await c.query('COMMIT');
        assert.equal((await pending).statusCode, 403);
      } finally {
        c.release();
      }
      await policy(true, true);
      const same = { body: 'Concurrent only once', clientMessageId: randomUUID() },
        responses = await Promise.all(
          Array.from({ length: 5 }, () => post(thread(bob.id), same, alice.cookie)),
        );
      assert.ok(responses.every((r) => r.statusCode === 201));
      assert.equal(new Set(responses.map((r) => r.json().id)).size, 1);
    }
    await post(base + '/user-permissions/' + bob.id, { kicked: true }, owner.cookie);
    assert.equal(
      (
        await post(
          thread(bob.id),
          { body: 'Removed recipient', clientMessageId: randomUUID() },
          alice.cookie,
        )
      ).statusCode,
      403,
    );
  } finally {
    for (const socket of sockets) socket.terminate();
    await app.close();
    await cleanup();
  }
});
