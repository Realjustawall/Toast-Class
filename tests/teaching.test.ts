import { testDatabase } from './database';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { newDb } from 'pg-mem';
import type pg from 'pg';
import * as Y from 'yjs';
import { buildApp } from '../apps/api/src/app';
test('teaching state, authorization, CRDT persistence and websocket delivery', async (t) => {
  const { pool, cleanup } = await testDatabase();
  const origin = 'http://localhost:5173';
  const app = await buildApp(pool, {
    origin,
    production: false,
    mediaUrl: '',
    mediaKey: '',
    mediaSecret: '',
  });
  const post = (path: string, body: unknown, cookie: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: { origin, cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  const get = (path: string, cookie: string) =>
    app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
  async function account(email: string) {
    assert.equal(
      (await post('/auth/register', { email, password: 'valid-test-password', name: email }, ''))
        .statusCode,
      201,
    );
    const r = await post('/auth/login', { email, password: 'valid-test-password' }, '');
    return String(r.headers['set-cookie']).split(';')[0];
  }
  try {
    const owner = await account('owner@test.org'),
      student = await account('student@test.org'),
      outsider = await account('outsider@test.org');
    const org = (await post('/organizations', { name: 'Teaching test' }, owner)).json().id;
    assert.equal(
      (
        await post(
          '/organizations/' + org + '/members',
          { email: 'student@test.org', role: 'student' },
          owner,
        )
      ).statusCode,
      201,
    );
    const room = (
      await post(
        '/organizations/' + org + '/classrooms',
        {
          enrollmentMode: 'organization',
          name: 'Teaching room',
          permissions: { studentWhiteboardEnabled: true },
        },
        owner,
      )
    ).json().id;
    const base = '/classrooms/' + room;
    await t.test('student and cross-tenant requests cannot start or read sessions', async () => {
      assert.equal((await post(base + '/session/start', {}, student)).statusCode, 403);
      assert.equal((await get(base + '/teaching', outsider)).statusCode, 403);
      assert.equal((await post(base + '/session/start', {}, owner)).statusCode, 201);
      assert.equal((await post(base + '/session/start', {}, owner)).statusCode, 409);
    });
    await t.test(
      'hand raises are idempotent, visible and owner can lower another hand',
      async () => {
        for (let i = 0; i < 2; i++)
          assert.equal((await post(base + '/hand', { raised: true }, student)).statusCode, 200);
        const state = (await get(base + '/teaching', owner)).json();
        assert.equal(state.hands.length, 1);
        assert.equal(
          (await post(base + '/hand', { raised: false, userId: state.hands[0].user_id }, owner))
            .statusCode,
          200,
        );
        assert.equal((await get(base + '/teaching', student)).json().hands.length, 0);
      },
    );
    let poll = '';
    await t.test('poll voting persists once and private results do not leak', async () => {
      const r = await post(
        base + '/polls',
        { question: 'Which protocol?', options: ['WebRTC', 'HTTP'] },
        owner,
      );
      assert.equal(r.statusCode, 201);
      poll = r.json().id;
      assert.equal(
        (await post(base + '/polls', { question: 'x', options: ['A', 'B'] }, student)).statusCode,
        403,
      );
      assert.equal(
        (await post(base + '/polls/' + poll + '/vote', { choice: 10 }, student)).statusCode,
        400,
      );
      assert.equal(
        (await post(base + '/polls/' + poll + '/vote', { choice: 0 }, student)).statusCode,
        200,
      );
      assert.equal(
        (await post(base + '/polls/' + poll + '/vote', { choice: 1 }, student)).statusCode,
        409,
      );
      assert.equal((await get(base + '/teaching', student)).json().polls[0].counts, undefined);
      assert.deepEqual((await get(base + '/teaching', owner)).json().polls[0].counts, [1, 0]);
      await post(base + '/polls/' + poll + '/control', { action: 'publish' }, owner);
      assert.deepEqual((await get(base + '/teaching', student)).json().polls[0].counts, [1, 0]);
    });
    await t.test('poll lifecycle and server deadlines reject late votes', async () => {
      await post(base + '/polls/' + poll + '/control', { action: 'pause' }, owner);
      assert.equal(
        (await post(base + '/polls/' + poll + '/vote', { choice: 0 }, owner)).statusCode,
        409,
      );
      await post(base + '/polls/' + poll + '/control', { action: 'resume' }, owner);
      await pool.query('UPDATE polls SET closes_at=$1 WHERE id=$2', [
        new Date(Date.now() - 10000),
        poll,
      ]);
      assert.equal(
        (await post(base + '/polls/' + poll + '/vote', { choice: 0 }, owner)).statusCode,
        409,
      );
      assert.equal((await get(base + '/teaching', owner)).json().polls[0].status, 'ended');
    });
    await t.test(
      'timer uses persisted deadline, pause and resume enforce transitions',
      async () => {
        assert.equal(
          (await post(base + '/timer', { action: 'start', durationSeconds: 60 }, student))
            .statusCode,
          403,
        );
        assert.equal(
          (await post(base + '/timer', { action: 'start', durationSeconds: 60 }, owner)).statusCode,
          200,
        );
        const timer = (await get(base + '/teaching', student)).json().timer;
        assert.ok(new Date(timer.deadline).getTime() > Date.now() + 55000);
        await post(base + '/timer', { action: 'pause' }, owner);
        assert.equal((await get(base + '/teaching', owner)).json().timer.status, 'paused');
        assert.equal((await post(base + '/timer', { action: 'pause' }, owner)).statusCode, 409);
        assert.equal((await post(base + '/timer', { action: 'resume' }, owner)).statusCode, 200);
        await post(base + '/timer', { action: 'reset' }, owner);
        assert.equal((await get(base + '/teaching', owner)).json().timer.status, 'stopped');
      },
    );
    await t.test(
      'concurrent Yjs edits merge, duplicate retries are safe, read-only enforced',
      async () => {
        const doc = (
          await post(base + '/documents', { name: 'Shared notes', kind: 'notes' }, owner)
        ).json().id;
        const path = base + '/documents/' + doc;
        const a = new Y.Doc(),
          b = new Y.Doc();
        a.getText('content').insert(0, 'سلام');
        b.getText('content').insert(0, 'Hello');
        const updates = [a, b].map((d) => ({
          id: randomUUID(),
          update: Buffer.from(Y.encodeStateAsUpdate(d)).toString('base64'),
        }));
        for (const [i, u] of updates.entries())
          assert.equal((await post(path + '/updates', u, i ? student : owner)).statusCode, 200);
        assert.equal((await post(path + '/updates', updates[0], owner)).statusCode, 200);
        const stored = (await get(path, student)).json();
        assert.equal(stored.updates.length, 2);
        const restored = new Y.Doc();
        for (const u of stored.updates)
          Y.applyUpdate(restored, Buffer.from(u.update_base64, 'base64'));
        assert.match(restored.getText('content').toString(), /سلام/);
        assert.match(restored.getText('content').toString(), /Hello/);
        assert.equal((await get(path, outsider)).statusCode, 403);
        const locked = (
          await post(
            base + '/documents',
            { name: 'Teacher notes', kind: 'notes', teacherOnly: true },
            owner,
          )
        ).json().id;
        assert.equal(
          (await post(base + '/documents/' + locked + '/updates', updates[0], student)).statusCode,
          403,
        );
        assert.equal(
          (await post(path + '/updates', { id: randomUUID(), update: 'YWJj' }, owner)).statusCode,
          400,
        );
        a.destroy();
        b.destroy();
        restored.destroy();
      },
    );
    await t.test('board object validation rejects malformed shapes', async () => {
      const doc = (await post(base + '/documents', { name: 'Board', kind: 'board' }, owner)).json()
        .id;
      const d = new Y.Doc();
      d.getMap('shapes').set(randomUUID(), { type: 'script', points: [] });
      assert.equal(
        (
          await post(
            base + '/documents/' + doc + '/updates',
            { id: randomUUID(), update: Buffer.from(Y.encodeStateAsUpdate(d)).toString('base64') },
            owner,
          )
        ).statusCode,
        400,
      );
      d.destroy();
    });
    await t.test(
      'websocket authorizes upgrades and sends invalidations to independent connections',
      async () => {
        await app.ready();
        await assert.rejects(
          app.injectWS('/api/v1' + base + '/live', { headers: { origin, cookie: outsider } }),
        );
        await assert.rejects(
          app.injectWS('/api/v1' + base + '/live', {
            headers: { origin: 'http://attacker.invalid', cookie: owner },
          }),
        );
        const ws = await app.injectWS('/api/v1' + base + '/live', {
          headers: { origin, cookie: student },
        });
        const duplicate = await app.injectWS('/api/v1' + base + '/live', {
          headers: { origin, cookie: student },
        });
        const studentState = (await get(base + '/teaching', student)).json();
        assert.equal(studentState.participants.length, 1);
        assert.equal(studentState.participants[0].id, studentState.userId);
        const teacherSocket = await app.injectWS('/api/v1' + base + '/live', {
          headers: { origin, cookie: owner },
        });
        assert.equal((await get(base + '/teaching', owner)).json().participants.length, 2);
        try {
          const received = once(ws, 'message');
          await post(base + '/hand', { raised: true }, owner);
          const [data] = await received;
          assert.ok(['ready', 'changed', 'users_changed'].includes(JSON.parse(String(data)).type));
        } finally {
          ws.terminate();
          duplicate.terminate();
          teacherSocket.terminate();
        }
      },
    );
    await t.test('ending session invalidates activities and preserves documents', async () => {
      assert.equal((await post(base + '/session/end', {}, owner)).statusCode, 200);
      assert.equal((await post(base + '/hand', { raised: true }, student)).statusCode, 409);
      assert.equal((await get(base + '/teaching', owner)).json().session, null);
      assert.equal((await get(base + '/documents', student)).json().length, 3);
    });
  } finally {
    await app.close();
    await cleanup();
  }
});
