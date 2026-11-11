import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { buildApp } from '../apps/api/src/app';
import { testDatabase, hasRealDatabase } from './database';
import { MediaService, type MediaControl } from '../apps/api/src/media-control';
import { unlockedPolicy } from '../apps/api/src/classroom-lock-policy';
test('shared workspace and granular locks persist, authorize requests and constrain both initial and explicit media policies', async () => {
  const { pool, cleanup } = await testDatabase(),
    origin = 'http://localhost:5173',
    applied: unknown[] = [];
  const control: MediaControl = {
    deleteRoom: async () => {},
    removeParticipant: async () => {},
    participants: async () => [],
    applyPolicy: async (room, id, policy) => {
      applied.push({ room, id, policy });
    },
  };
  const config = {
    origin,
    production: false,
    mediaUrl: 'ws://localhost:37890',
    mediaKey: 'test-key',
    mediaSecret: '0123456789abcdef0123456789abcdef',
    mediaControl: control,
    mediaWorker: false,
    breakoutWorker: false,
  };
  const app = await buildApp(pool, config),
    media = new MediaService(pool, config);
  const post = (path: string, data: unknown, cookie = '') =>
    app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: { origin, cookie },
      payload: data as object,
    });
  const get = (path: string, cookie: string) =>
    app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
  const account = async (name: string) => {
    const email = name + '@shared-policy.test',
      r = await post('/auth/register', { name, email, password: '123456' });
    assert.equal(r.statusCode, 201);
    const login = await post('/auth/login', { email, password: '123456' });
    return { id: r.json().id, email, cookie: String(login.headers['set-cookie']).split(';')[0] };
  };
  try {
    const owner = await account('Owner'),
      learner = await account('Learner');
    const org = (await post('/organizations', { name: 'Shared workspace' }, owner.cookie)).json();
    await post(
      '/organizations/' + org.id + '/members',
      { email: learner.email, role: 'student' },
      owner.cookie,
    );
    const room = (
        await post(
          '/organizations/' + org.id + '/classrooms',
          { name: 'Shared class', enrollmentMode: 'organization' },
          owner.cookie,
        )
      ).json(),
      base = '/classrooms/' + room.id;
    const board = (await post(base + '/board-book', {}, owner.cookie)).json(),
      page = (await post(base + '/documents/' + board.id + '/pages', {}, owner.cookie)).json();
    const geo = (await post(base + '/geogebra', { name: 'Geometry' }, owner.cookie)).json();
    const firstState = (await get(base + '/documents/' + board.id + '/board', owner.cookie)).json();
    const colored = new Y.Doc();
    colored.getMap('settings').set('backgroundColor', '#fef3c7');
    assert.equal(
      (
        await post(
          base + '/documents/' + board.id + '/board/updates',
          {
            id: randomUUID(),
            generation: firstState.generation,
            update: Buffer.from(Y.encodeStateAsUpdate(colored)).toString('base64'),
          },
          owner.cookie,
        )
      ).statusCode,
      200,
    );
    colored.destroy();
    const colorState = (await get(base + '/documents/' + board.id + '/board', owner.cookie)).json(),
      restored = new Y.Doc();
    Y.applyUpdate(restored, Buffer.from(colorState.state, 'base64'));
    assert.equal(restored.getMap('settings').get('backgroundColor'), '#fef3c7');
    restored.destroy();
    const initial = (await get(base + '/workspace', learner.cookie)).json();
    assert.equal(initial.documentId, board.id);
    assert.equal(
      (
        await post(
          base + '/workspace',
          { kind: 'geogebra', geogebraId: geo.id, expectedRevision: 0 },
          learner.cookie,
        )
      ).statusCode,
      403,
    );
    const selected = await post(
      base + '/workspace',
      { kind: 'geogebra', geogebraId: geo.id, expectedRevision: 0 },
      owner.cookie,
    );
    assert.equal(selected.statusCode, 200);
    assert.equal((await get(base + '/workspace', learner.cookie)).json().geogebraId, geo.id);
    assert.equal(
      (
        await post(
          base + '/workspace',
          { kind: 'document', documentId: page.id, expectedRevision: 0 },
          owner.cookie,
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await post(
          base + '/workspace',
          { kind: 'document', documentId: page.id, expectedRevision: 1 },
          owner.cookie,
        )
      ).statusCode,
      200,
    );
    const other = (
      await post('/organizations/' + org.id + '/classrooms', { name: 'Other' }, owner.cookie)
    ).json();
    assert.equal(
      (
        await post(
          '/classrooms/' + other.id + '/workspace',
          { kind: 'document', documentId: board.id, expectedRevision: 0 },
          owner.cookie,
        )
      ).statusCode,
      404,
    );
    const permission = base + '/user-permissions/' + learner.id;
    assert.equal(
      (await post(permission, { interactionLocked: true }, owner.cookie)).statusCode,
      200,
    );
    const session = (await post(base + '/session/start', {}, owner.cookie)).json();
    const lockedJoin = await post(base + '/join', {}, learner.cookie);
    assert.equal(lockedJoin.statusCode, 200);
    for (const key of ['microphone', 'camera', 'screen_share'])
      assert.equal(lockedJoin.json().policy[key], false, key + ' locked before session start');
    await post(
      permission,
      { interactionLocked: false, isPresenter: true, canWhiteboard: true, canScreenShare: true },
      owner.cookie,
    );
    const locks = {
      ...unlockedPolicy,
      microphone: true,
      screenShare: true,
      whiteboard: true,
      sharedNotes: true,
    };
    assert.equal(
      (await post(base + '/locks', { locks, expectedRevision: 0 }, learner.cookie)).statusCode,
      403,
    );
    assert.equal(
      (await post(base + '/locks', { locks, expectedRevision: 0 }, owner.cookie)).statusCode,
      200,
    );
    assert.equal(
      (await post(base + '/locks', { locks, expectedRevision: 0 }, owner.cookie)).statusCode,
      409,
    );
    const teaching = (await get(base + '/teaching', learner.cookie)).json();
    for (const key of ['canMicrophone', 'canScreenShare', 'canWhiteboard', 'canSharedNotes'])
      assert.equal(teaching.myPermissions[key], false, key);
    assert.equal(
      (await get(base + '/documents/' + board.id + '/board', learner.cookie)).json().canEdit,
      false,
    );
    const joined = await post(base + '/join', {}, learner.cookie);
    assert.equal(joined.json().policy.microphone, false);
    assert.equal(joined.json().policy.screen_share, false);
    const effective = await media.policies(session.id, [learner.id]);
    assert.equal(effective.get(learner.id)?.microphone, false);
    if (hasRealDatabase) {
      while (await media.processOne()) {}
      assert.ok(applied.length > 0);
    } else {
      // pg-mem cannot execute FOR UPDATE SKIP LOCKED; native MySQL verifies delivery.
      assert.ok(
        (await pool.query('SELECT id FROM media_commands WHERE session_id=$1', [session.id])).rows
          .length > 0,
      );
    }
    const notes = (
      await post(base + '/documents', { name: 'Notes', kind: 'notes' }, owner.cookie)
    ).json();
    const y = new Y.Doc();
    const update = Buffer.from(Y.encodeStateAsUpdate(y)).toString('base64');
    y.destroy();
    assert.equal(
      (
        await post(
          base + '/documents/' + notes.id + '/updates',
          { id: randomUUID(), update },
          learner.cookie,
        )
      ).statusCode,
      403,
    );
    const future = await account('Future');
    await post(
      '/organizations/' + org.id + '/members',
      { email: future.email, role: 'student' },
      owner.cookie,
    );
    assert.equal((await post(base + '/join', {}, future.cookie)).json().policy.microphone, false);
    const member = (await get(base + '/user-permissions', owner.cookie))
      .json()
      .members.find((m: { userId: string }) => m.userId === learner.id);
    assert.equal(
      (
        await post(
          permission,
          {
            expectedRevision: member.revision,
            lockExempt: true,
            canMicrophone: true,
            canWhiteboard: true,
          },
          owner.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await post(
          permission,
          { expectedRevision: member.revision, canCamera: false },
          owner.cookie,
        )
      ).statusCode,
      409,
    );
    assert.equal((await post(base + '/join', {}, learner.cookie)).json().policy.microphone, true);
    assert.equal(
      (await post(base + '/locks', { locks: unlockedPolicy, expectedRevision: 1 }, owner.cookie))
        .statusCode,
      200,
    );
    assert.equal((await post(base + '/join', {}, future.cookie)).json().policy.microphone, true);
  } finally {
    await app.close();
    await cleanup();
  }
});
