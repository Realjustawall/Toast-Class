import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { testDatabase, hasRealDatabase } from './database';
import { buildApp } from '../apps/api/src/app';

test('presenter views persist, authorize every write, fence generations and serialize competing teachers', async () => {
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
  async function account(name: string) {
    const email = name + '@presenter.test';
    assert.equal(
      (await post('/auth/register', { email, name, password: 'presenter-password' }, ''))
        .statusCode,
      201,
    );
    const r = await post('/auth/login', { email, password: 'presenter-password' }, '');
    return String(r.headers['set-cookie']).split(';')[0];
  }
  try {
    const teacher = await account('Teacher'),
      student = await account('Student'),
      other = await account('Other'),
      outsider = await account('Outsider');
    const org = (await post('/organizations', { name: 'Presenter school' }, teacher)).json().id;
    await post(
      `/organizations/${org}/members`,
      { email: 'Student@presenter.test', role: 'student' },
      teacher,
    );
    await post(
      `/organizations/${org}/members`,
      { email: 'Other@presenter.test', role: 'teacher' },
      teacher,
    );
    const room = (
      await post(
        `/organizations/${org}/classrooms`,
        { enrollmentMode: 'organization', name: 'Viewport class' },
        teacher,
      )
    ).json().id;
    const room2 = (
      await post(
        `/organizations/${org}/classrooms`,
        { enrollmentMode: 'organization', name: 'Other class' },
        teacher,
      )
    ).json().id;
    const doc = (
      await post(
        `/classrooms/${room}/documents`,
        { name: 'Follow board', kind: 'board', boardFormat: 'excalidraw' },
        teacher,
      )
    ).json().id;
    const base = `/classrooms/${room}/documents/${doc}/board`,
      generation = (await get(base, teacher)).json().generation;
    const data = {
      generation,
      revision: 0,
      operationId: randomUUID(),
      active: true,
      viewport: { centerX: -123.5, centerY: 456.75, zoom: 1.5 },
    };
    assert.equal((await get(base + '/view', student)).json().active, false);
    assert.equal((await get(base + '/view', outsider)).statusCode, 403);
    assert.equal((await post(base + '/view', data, outsider)).statusCode, 403);
    assert.equal((await post(base + '/view', data, student)).statusCode, 403);
    assert.equal(
      (await post(base + '/view', { ...data, viewport: { ...data.viewport, zoom: 0 } }, teacher))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await post(
          base + '/view',
          { ...data, viewport: { ...data.viewport, centerX: 1e8 } },
          teacher,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (await post(base + '/view', { ...data, actorId: 'forged' }, teacher)).statusCode,
      400,
    );
    assert.equal(
      (await get(`/classrooms/${room2}/documents/${doc}/board/view`, teacher)).statusCode,
      404,
    );
    const notices: unknown[] = [];
    const socket = await app.injectWS(
      '/api/v1' + base + '/presence/live?clientId=' + randomUUID(),
      { headers: { origin, cookie: student } },
    );
    socket.on('message', (bytes) => {
      const value = JSON.parse(bytes.toString());
      if (value.type === 'view_changed') notices.push(value);
    });
    assert.equal((await post(base + '/view', data, teacher)).statusCode, 200);
    for (let attempt = 0; attempt < 40 && !notices.length; attempt++) await pause(25);
    assert.deepEqual(
      notices[0],
      { type: 'view_changed' },
      'socket invalidates only; private state requires a freshly authorized HTTP read',
    );
    assert.equal((await post(base + '/view', data, teacher)).json().revision, 1);
    assert.equal((await post(base + '/view', { ...data, active: false }, teacher)).statusCode, 409);
    const saved = (await get(base + '/view', student)).json();
    assert.equal(saved.active, true);
    assert.equal(saved.canPresent, false);
    assert.deepEqual(saved.viewport, data.viewport);
    assert.equal(saved.revision, 1);
    const competingWrite = (cookie: string) =>
      post(
        base + '/view',
        {
          ...data,
          revision: 1,
          operationId: randomUUID(),
          viewport: { centerX: 900, centerY: 800, zoom: 2 },
        },
        cookie,
      );
    // pg-mem has no row locks: concurrency proof belongs to the native MySQL run.
    const writes = hasRealDatabase
      ? await Promise.all([teacher, other].map(competingWrite))
      : [await competingWrite(teacher), await competingWrite(other)];
    assert.deepEqual(writes.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal((await get(base + '/view', student)).json().revision, 2);
    assert.equal(
      (await get(base, teacher)).json().revision,
      0,
      'viewport movement must not edit CRDT history',
    );
    const snapshot = await post(
      base + '/versions',
      {
        id: randomUUID(),
        expectedGeneration: generation,
        expectedRevision: 0,
        label: 'Before restore',
      },
      teacher,
    );
    assert.equal(snapshot.statusCode, 200, snapshot.body);
    const version = snapshot.json();
    // History restoration changes the generation. A stale view cannot become active again.
    const restore = await post(
      base + `/versions/${version.id}/restore`,
      { id: randomUUID(), expectedGeneration: generation, expectedRevision: 0 },
      teacher,
    );
    assert.equal(restore.statusCode, 200, restore.body);
    assert.equal((await get(base + '/view', student)).json().active, false);
    assert.equal(
      (await post(base + '/view', { ...data, revision: 2, operationId: randomUUID() }, teacher))
        .statusCode,
      409,
    );
    const currentGeneration = (await get(base, teacher)).json().generation;
    const otherId = (
      await pool.query('SELECT id FROM users WHERE email=$1', ['other@presenter.test'])
    ).rows[0].id;
    assert.equal(
      (
        await post(
          base + '/view',
          { ...data, generation: currentGeneration, revision: 2, operationId: randomUUID() },
          other,
        )
      ).statusCode,
      200,
    );
    await pool.query('UPDATE memberships SET role=$1 WHERE organization_id=$2 AND user_id=$3', [
      'student',
      org,
      otherId,
    ]);
    assert.equal(
      (await get(base + '/view', student)).json().active,
      false,
      'revoked presenter no longer controls readers',
    );
    assert.equal(
      (
        await post(
          base + '/view',
          { ...data, generation: currentGeneration, revision: 3, operationId: randomUUID() },
          other,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT COUNT(*) AS n FROM audit_logs WHERE action='board.presentation_started'",
            [],
          )
        ).rows[0].n,
      ) >= 1,
      true,
    );
  } finally {
    await app.close();
    await cleanup();
  }
});
