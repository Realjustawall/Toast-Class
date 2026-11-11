import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import * as Y from 'yjs';
import { testDatabase, hasRealDatabase } from './database';
import { buildApp } from '../apps/api/src/app';

test('advanced board persistence, merging, authorization and hostile CRDT rejection', async () => {
  const { pool, cleanup } = await testDatabase();
  const origin = 'http://localhost:5173';
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
  const account = async (email: string) => {
    assert.equal(
      (await post('/auth/register', { email, name: email, password: 'board-test-password' }, ''))
        .statusCode,
      201,
    );
    return String(
      (await post('/auth/login', { email, password: 'board-test-password' }, '')).headers[
        'set-cookie'
      ],
    ).split(';')[0];
  };
  try {
    const owner = await account('board-owner@example.org'),
      student = await account('board-student@example.org'),
      outsider = await account('board-outsider@example.org');
    const org = (await post('/organizations', { name: 'Board school' }, owner)).json().id;
    await post(
      `/organizations/${org}/members`,
      { email: 'board-student@example.org', role: 'student' },
      owner,
    );
    const room = (
      await post(
        `/organizations/${org}/classrooms`,
        {
          enrollmentMode: 'organization',
          name: 'Drawing',
          permissions: { studentWhiteboardEnabled: true },
        },
        owner,
      )
    ).json().id;
    const created = await post(
      `/classrooms/${room}/documents`,
      { kind: 'board', name: 'Shapes', boardFormat: 'excalidraw' },
      owner,
    );
    assert.equal(created.statusCode, 201);
    const doc = created.json().id,
      base = `/classrooms/${room}/documents/${doc}/board`;
    const initial = (await get(base, owner)).json();
    assert.equal(initial.revision, 0);
    assert.equal((await get(base, outsider)).statusCode, 403);
    const rectangle = (id: string) => ({
      id,
      type: 'rectangle',
      x: 10,
      y: 20,
      width: 100,
      height: 80,
      angle: 0,
      strokeColor: '#000000',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: Date.now(),
      link: null,
      locked: false,
    });
    const first = new Y.Doc(),
      second = new Y.Doc();
    first.getMap('elements').set('shapeA', rectangle('shapeA'));
    second.getMap('elements').set('shapeB', rectangle('shapeB'));
    const update = (d: Y.Doc) => ({
      id: randomUUID(),
      generation: initial.generation,
      update: Buffer.from(Y.encodeStateAsUpdate(d)).toString('base64'),
    });
    const a = update(first),
      b = update(second);
    assert.equal((await post(base + '/updates', a, owner)).json().revision, 1);
    assert.equal((await post(base + '/updates', a, owner)).json().revision, 1);
    assert.equal((await post(base + '/updates', { ...b, id: a.id }, owner)).statusCode, 409);
    assert.equal((await post(base + '/updates', b, student)).json().revision, 2);
    const saved = (await get(base, student)).json();
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Buffer.from(saved.state, 'base64'));
    assert.deepEqual([...restored.getMap('elements').keys()].sort(), ['shapeA', 'shapeB']);
    assert.equal((await get(base + '?since=1', owner)).json().updates.length, 1);
    assert.equal((await post(base + '/access', { teacherOnly: true }, student)).statusCode, 403);
    assert.equal((await post(base + '/access', { teacherOnly: true }, owner)).statusCode, 200);
    assert.equal((await get(base, student)).json().canEdit, false);
    assert.equal((await post(base + '/updates', update(second), student)).statusCode, 403);
    assert.equal(
      (await post(base + '/updates', { ...update(second), generation: randomUUID() }, owner))
        .statusCode,
      409,
    );
    const hostile = new Y.Doc();
    hostile.getMap('elements').set('bad', { ...rectangle('bad'), link: 'javascript:alert(1)' });
    assert.equal((await post(base + '/updates', update(hostile), owner)).statusCode, 400);
    hostile.getMap('elements').set('bad', { ...rectangle('bad'), type: 'image' });
    assert.equal((await post(base + '/updates', update(hostile), owner)).statusCode, 400);
    const unknown = new Y.Doc();
    unknown.getText('secret-root').insert(0, 'unvalidated');
    assert.equal((await post(base + '/updates', update(unknown), owner)).statusCode, 400);
    const causal = new Y.Doc();
    causal.getMap('elements').set('dependent', rectangle('dependent'));
    const before = Y.encodeStateVector(causal);
    causal.getMap('elements').set('dependent', { ...rectangle('dependent'), x: 40 });
    assert.equal(
      (
        await post(
          base + '/updates',
          {
            ...update(causal),
            update: Buffer.from(Y.encodeStateAsUpdate(causal, before)).toString('base64'),
          },
          owner,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await post(
          `/classrooms/${room}/documents/${doc}/updates`,
          { id: randomUUID(), update: a.update },
          owner,
        )
      ).statusCode,
      400,
    );
    assert.equal((await get(base, owner)).json().revision, 2);
    const versionBody = {
      id: randomUUID(),
      label: 'نسخهٔ آغاز',
      expectedGeneration: initial.generation,
      expectedRevision: 2,
    };
    const version = await post(base + '/versions', versionBody, owner);
    assert.equal(version.statusCode, 200, version.body);
    assert.equal((await post(base + '/versions', versionBody, owner)).json().id, versionBody.id);
    assert.equal(
      (await post(base + '/versions', { ...versionBody, label: 'changed' }, owner)).statusCode,
      409,
    );
    assert.equal((await get(base + '/versions', owner)).json().length, 1);
    assert.equal((await get(base + '/versions', student)).statusCode, 403);
    assert.equal((await get(base + '/versions/' + versionBody.id, student)).statusCode, 403);
    assert.equal((await get(base + '/versions', outsider)).statusCode, 403);
    assert.equal(
      (await post(base + '/versions', { ...versionBody, id: randomUUID() }, student)).statusCode,
      403,
    );
    const restorePath = base + '/versions/' + versionBody.id + '/restore';
    const staleRestore = {
      id: randomUUID(),
      expectedGeneration: initial.generation,
      expectedRevision: 2,
    };
    assert.equal((await post(restorePath, staleRestore, student)).statusCode, 403);
    const otherDoc = (
      await post(
        `/classrooms/${room}/documents`,
        { kind: 'board', name: 'Other', boardFormat: 'excalidraw' },
        owner,
      )
    ).json().id;
    const otherBase = `/classrooms/${room}/documents/${otherDoc}/board`;
    assert.equal((await get(otherBase + '/versions/' + versionBody.id, owner)).statusCode, 404);
    const otherState = (await get(otherBase, owner)).json();
    assert.equal(
      (
        await post(
          otherBase + '/versions/' + versionBody.id + '/restore',
          { id: randomUUID(), expectedGeneration: otherState.generation, expectedRevision: 0 },
          owner,
        )
      ).statusCode,
      404,
    );
    const third = new Y.Doc();
    third.getMap('elements').set('shapeC', rectangle('shapeC'));
    assert.equal((await post(base + '/updates', update(third), owner)).json().revision, 3);
    assert.equal((await post(restorePath, staleRestore, owner)).statusCode, 409);
    const restoreBody = { ...staleRestore, expectedRevision: 3 };
    const reset = await post(restorePath, restoreBody, owner);
    assert.equal(reset.statusCode, 200, reset.body);
    const replacement = reset.json();
    assert.notEqual(replacement.generation, initial.generation);
    assert.equal(replacement.revision, 4);
    assert.deepEqual((await post(restorePath, restoreBody, owner)).json(), replacement);
    assert.equal(
      (await post(restorePath, { ...restoreBody, expectedRevision: 2 }, owner)).statusCode,
      409,
    );
    const latest = (await get(base + '?since=3', owner)).json();
    assert.equal(typeof latest.state, 'string');
    const replaced = new Y.Doc();
    Y.applyUpdate(replaced, Buffer.from(latest.state, 'base64'));
    assert.deepEqual([...replaced.getMap('elements').keys()].sort(), ['shapeA', 'shapeB']);
    assert.equal((await post(base + '/updates', update(third), owner)).statusCode, 409);
    const history = (await get(base + '/versions', owner)).json();
    const beforeVersion = history.find((v: { kind: string }) => v.kind === 'before_restore');
    assert.ok(beforeVersion);
    const backup = (await get(base + '/versions/' + beforeVersion.id, owner)).json();
    const beforeDoc = new Y.Doc();
    Y.applyUpdate(beforeDoc, Buffer.from(backup.state_base64, 'base64'));
    assert.equal(beforeDoc.getMap('elements').size, 3);
    await pool.query('UPDATE board_versions SET digest=$1 WHERE id=$2', [
      '0'.repeat(64),
      versionBody.id,
    ]);
    assert.equal((await get(base + '/versions/' + versionBody.id, owner)).statusCode, 409);
    assert.equal(
      (
        await post(
          restorePath,
          { id: randomUUID(), expectedGeneration: replacement.generation, expectedRevision: 4 },
          owner,
        )
      ).statusCode,
      409,
    );
    assert.equal((await get(base, owner)).json().revision, 4);
    await pool.query('UPDATE board_versions SET digest=$1 WHERE id=$2', [
      version.json().digest,
      versionBody.id,
    ]);
    if (hasRealDatabase) {
      const simultaneous = await Promise.all(
        [1, 2].map(() =>
          post(
            restorePath,
            { id: randomUUID(), expectedGeneration: replacement.generation, expectedRevision: 4 },
            owner,
          ),
        ),
      );
      assert.deepEqual(simultaneous.map((r) => r.statusCode).sort(), [200, 409]);
    }
    let current = (await get(base, owner)).json();
    const drawing = new Y.Doc();
    Y.applyUpdate(drawing, Buffer.from(current.state, 'base64'));
    while (current.revision < 25) {
      const vector = Y.encodeStateVector(drawing);
      drawing.getMap('elements').set('shapeD', { ...rectangle('shapeD'), x: current.revision });
      const accepted = await post(
        base + '/updates',
        {
          id: randomUUID(),
          generation: current.generation,
          update: Buffer.from(Y.encodeStateAsUpdate(drawing, vector)).toString('base64'),
        },
        owner,
      );
      assert.equal(accepted.statusCode, 200, accepted.body);
      current.revision = accepted.json().revision;
    }
    assert.ok(
      (await get(base + '/versions', owner))
        .json()
        .some(
          (v: { kind: string; revision: number }) => v.kind === 'automatic' && v.revision === 25,
        ),
    );
    const auditRows = (
      await pool.query(
        "SELECT action FROM audit_logs WHERE resource_id=$1 AND action='board.version_saved'",
        [doc],
      )
    ).rows;
    assert.equal(auditRows.length, 1, 'Snapshot retry must not duplicate its audit');
    const quotaState = (await get(base, owner)).json();
    const quotaDigest = createHash('sha256')
      .update(Buffer.from(quotaState.state, 'base64'))
      .digest('hex');
    const existingCount = Number(
      (await pool.query('SELECT COUNT(*) AS count FROM board_versions WHERE document_id=$1', [doc]))
        .rows[0].count,
    );
    for (let i = existingCount; i < 128; i++) {
      await pool.query(
        "INSERT INTO board_versions(id,document_id,generation,revision,label,kind,state_base64,digest,author_id) SELECT $1,document_id,generation,revision,$2,'manual',state_base64,$3,$4 FROM board_states WHERE document_id=$5",
        [randomUUID(), 'Quota fixture', quotaDigest, quotaState.document.created_by, doc],
      );
    }
    assert.equal(
      (
        await post(
          base + '/versions',
          {
            id: randomUUID(),
            label: 'Over quota',
            expectedGeneration: quotaState.generation,
            expectedRevision: 25,
          },
          owner,
        )
      ).statusCode,
      413,
    );
    assert.equal(
      (
        await post(
          restorePath,
          { id: randomUUID(), expectedGeneration: quotaState.generation, expectedRevision: 25 },
          owner,
        )
      ).statusCode,
      413,
    );
    assert.equal(
      (await get(base, owner)).json().state,
      quotaState.state,
      'A failed protective snapshot must abort the whole restore',
    );
    assert.equal((await get(base, owner)).json().generation, quotaState.generation);
    for (const d of [third, replaced, beforeDoc, drawing]) d.destroy();
    for (const d of [first, second, restored, hostile, unknown, causal]) d.destroy();
  } finally {
    await app.close();
    await cleanup();
  }
});
