import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { testDatabase, hasRealDatabase } from './database';
import { buildApp } from '../apps/api/src/app';
import { BreakoutService, balancedAssignment } from '../apps/api/src/breakouts';
import { MediaService, type MediaControl } from '../apps/api/src/media-control';
import { unlockedPolicy } from '../apps/api/src/classroom-lock-policy';
test('balanced random allocation includes every student once and balances room sizes', () => {
  const ids = Array.from({ length: 25 }, () => randomUUID());
  const result = balancedAssignment(ids, 6);
  assert.deepEqual(result.map((v) => v.userId).sort(), [...ids].sort());
  const sizes = Array.from({ length: 6 }, (_, i) => result.filter((v) => v.roomIndex === i).length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
});
test('breakout access, independent data, lifecycle, imports and authoritative duration', async (t) => {
  const { pool, cleanup } = await testDatabase();
  const origin = 'http://localhost:5173';
  const removed: { room: string; user: string }[] = [];
  const deleted: string[] = [];
  const control: MediaControl = {
    async deleteRoom(room) {
      deleted.push(room);
    },
    async removeParticipant(room, user) {
      removed.push({ room, user });
    },
    async applyPolicy() {},
    async participants() {
      return [];
    },
  };
  const config = {
    origin,
    production: false,
    mediaUrl: 'ws://127.0.0.1:9',
    mediaKey: 'test-key',
    mediaSecret: 'test-secret-that-is-long-enough',
    mediaControl: control,
    mediaWorker: false,
    breakoutWorker: false,
  };
  const app = await buildApp(pool, config);
  const media = new MediaService(pool, config);
  const service = new BreakoutService(pool, media);
  const post = (path: string, data: unknown, cookie: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: { origin, cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(data),
    });
  const get = (path: string, cookie: string) =>
    app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
  async function account(email: string) {
    assert.equal(
      (await post('/auth/register', { email, name: email, password: 'breakout-test-password' }, ''))
        .statusCode,
      201,
    );
    const r = await post('/auth/login', { email, password: 'breakout-test-password' }, '');
    return { id: r.json().id, cookie: String(r.headers['set-cookie']).split(';')[0] };
  }
  try {
    const owner = await account('teacher@breakout.test'),
      a = await account('alpha@breakout.test'),
      b = await account('beta@breakout.test'),
      other = await account('other@breakout.test');
    const org = (await post('/organizations', { name: 'Workshop' }, owner.cookie)).json();
    for (const email of ['alpha@breakout.test', 'beta@breakout.test'])
      await post('/organizations/' + org.id + '/members', { email, role: 'student' }, owner.cookie);
    const room = (
      await post(
        '/organizations/' + org.id + '/classrooms',
        { enrollmentMode: 'organization', name: 'Main classroom' },
        owner.cookie,
      )
    ).json();
    const base = '/classrooms/' + room.id;
    const session = (await post(base + '/session/start', {}, owner.cookie)).json();
    const oldMain = (await post(base + '/join', {}, a.cookie)).json();
    const payload = {
      rooms: [{ name: 'Alpha group' }, { name: 'Beta group' }],
      durationSeconds: 180,
      allowSelfSelect: false,
      allocation: {
        mode: 'manual',
        assignments: [
          { userId: a.id, roomIndex: 0 },
          { userId: b.id, roomIndex: 1 },
        ],
      },
    };
    await t.test('creation rejects student/tenant escalation and invalid assignments', async () => {
      assert.equal((await post(base + '/breakouts', payload, a.cookie)).statusCode, 403);
      assert.equal((await post(base + '/breakouts', payload, other.cookie)).statusCode, 403);
      assert.equal(
        (
          await post(
            base + '/breakouts',
            {
              ...payload,
              allocation: { mode: 'manual', assignments: [{ userId: other.id, roomIndex: 0 }] },
            },
            owner.cookie,
          )
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await post(
            base + '/breakouts',
            {
              ...payload,
              allocation: {
                mode: 'manual',
                assignments: [
                  { userId: a.id, roomIndex: 0 },
                  { userId: a.id, roomIndex: 1 },
                ],
              },
            },
            owner.cookie,
          )
        ).statusCode,
        400,
      );
    });
    let groupId = '',
      alpha = '',
      beta = '',
      sourceDoc = '';
    await t.test(
      'creation persists independent sessions and exposes only authorized rooms',
      async () => {
        assert.equal(
          (
            await post(
              base + '/locks',
              { locks: { ...unlockedPolicy, camera: true }, expectedRevision: 0 },
              owner.cookie,
            )
          ).statusCode,
          200,
        );
        const created = await post(base + '/breakouts', payload, owner.cookie);
        assert.equal(created.statusCode, 201);
        groupId = created.json().id;
        assert.equal((await post(base + '/breakouts', payload, owner.cookie)).statusCode, 409);
        const state = (await get(base + '/breakouts', owner.cookie)).json();
        [alpha, beta] = state.groups[0].rooms.map((r: { id: string }) => r.id);
        assert.equal(
          (await get('/classrooms/' + alpha + '/locks', owner.cookie)).json().locks.camera,
          true,
        );
        assert.equal(
          (await post('/classrooms/' + alpha + '/join', {}, a.cookie)).json().policy.camera,
          false,
        );
        assert.equal(
          (
            await post(
              base + '/locks',
              { locks: { ...unlockedPolicy, microphone: true }, expectedRevision: 1 },
              owner.cookie,
            )
          ).statusCode,
          200,
        );
        for (const child of [alpha, beta]) {
          const inherited = (await get('/classrooms/' + child + '/locks', owner.cookie)).json();
          assert.equal(inherited.locks.microphone, true);
          assert.equal(inherited.locks.camera, false);
        }
        assert.equal(
          (
            await post(
              base + '/locks',
              { locks: unlockedPolicy, expectedRevision: 2 },
              owner.cookie,
            )
          ).statusCode,
          200,
        );
        assert.equal(state.groups[0].rooms.length, 2);
        assert.equal((await get(base + '/breakouts', a.cookie)).json().groups[0].rooms.length, 1);
        assert.equal(
          (await get('/organizations/' + org.id + '/classrooms', a.cookie)).json().length,
          1,
        );
        assert.equal((await get('/classrooms/' + alpha + '/teaching', a.cookie)).statusCode, 200);
        assert.equal((await get('/classrooms/' + beta + '/teaching', a.cookie)).statusCode, 403);
        assert.equal(
          (await get('/classrooms/' + alpha + '/messages', other.cookie)).statusCode,
          403,
        );
        const ja = (await post('/classrooms/' + alpha + '/join', {}, a.cookie)).json(),
          jb = (await post('/classrooms/' + beta + '/join', {}, b.cookie)).json();
        assert.notEqual(
          JSON.parse(Buffer.from(ja.token.split('.')[1], 'base64url').toString()).video.room,
          JSON.parse(Buffer.from(jb.token.split('.')[1], 'base64url').toString()).video.room,
        );
        assert.equal((await post(base + '/join', {}, a.cookie)).statusCode, 403);
        assert.equal(
          (
            await get(
              '/media/signal/rtc/validate?access_token=' + encodeURIComponent(oldMain.token),
              a.cookie,
            )
          ).statusCode,
          403,
        );
        await assert.rejects(
          app.injectWS('/api/v1/classrooms/' + beta + '/live', {
            headers: { origin, cookie: a.cookie },
          }),
        );
        assert.equal(
          (await post('/classrooms/' + alpha + '/session/end', {}, owner.cookie)).statusCode,
          403,
        );
        assert.equal(
          (await post('/classrooms/' + alpha + '/breakouts', payload, owner.cookie)).statusCode,
          400,
        );
      },
    );
    await t.test('breakout chat and documents are separated at server boundaries', async () => {
      assert.equal(
        (
          await post(
            '/classrooms/' + alpha + '/messages',
            { body: 'Alpha private group discussion' },
            a.cookie,
          )
        ).statusCode,
        201,
      );
      assert.equal((await get('/classrooms/' + beta + '/messages', b.cookie)).json().length, 0);
      assert.equal((await get('/classrooms/' + alpha + '/messages', b.cookie)).statusCode, 403);
      sourceDoc = (
        await post(
          '/classrooms/' + alpha + '/documents',
          { name: 'Alpha notes', kind: 'notes' },
          owner.cookie,
        )
      ).json().id;
      const doc = new Y.Doc();
      doc.getText('content').insert(0, 'Group notes - shared result');
      const update = {
        id: randomUUID(),
        update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
      };
      assert.equal(
        (
          await post(
            '/classrooms/' + alpha + '/documents/' + sourceDoc + '/updates',
            update,
            a.cookie,
          )
        ).statusCode,
        200,
      );
      assert.equal(
        (await get('/classrooms/' + alpha + '/documents/' + sourceDoc, b.cookie)).statusCode,
        403,
      );
      doc.destroy();
      assert.equal(
        (
          await post(
            base + '/breakouts/' + groupId + '/announce',
            { body: 'Return in two minutes' },
            owner.cookie,
          )
        ).statusCode,
        201,
      );
      for (const member of [a, b])
        assert.equal(
          (await get(base + '/breakouts', member.cookie)).json().groups[0].announcements[0].body,
          'Return in two minutes',
        );
    });
    await t.test(
      'moves revoke old-room access and keep assignments across reconnects',
      async () => {
        const oldToken = (await post('/classrooms/' + alpha + '/join', {}, a.cookie)).json().token;
        assert.equal(
          (
            await post(
              base + '/breakouts/' + groupId + '/assign',
              { userId: a.id, roomId: beta },
              b.cookie,
            )
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await post(
              base + '/breakouts/' + groupId + '/assign',
              { userId: a.id, roomId: beta },
              owner.cookie,
            )
          ).statusCode,
          200,
        );
        assert.equal((await get('/classrooms/' + alpha + '/messages', a.cookie)).statusCode, 403);
        assert.equal(
          (
            await get(
              '/media/signal/rtc/validate?access_token=' + encodeURIComponent(oldToken),
              a.cookie,
            )
          ).statusCode,
          403,
        );
        assert.equal((await get(base + '/breakouts', a.cookie)).json().destination.id, beta);
        assert.equal(
          (
            await post(
              base + '/breakouts/' + groupId + '/assign',
              { userId: a.id, roomId: null },
              a.cookie,
            )
          ).statusCode,
          200,
        );
        assert.equal((await post(base + '/join', {}, a.cookie)).statusCode, 200);
        assert.equal((await get(base + '/breakouts', a.cookie)).json().destination.id, room.id);
      },
    );
    await t.test(
      'latest relocation commands cannot disconnect a later legitimate location',
      { skip: !hasRealDatabase },
      async () => {
        for (let i = 0; i < 30; i++) if (!(await media.processOne())) break;
        // Current revision returns Alpha to main; old parent-removal commands must be skipped.
        assert.ok(!removed.some((v) => v.user === a.id && v.room === 'toaster-' + session.id));
        assert.ok(removed.some((v) => v.user === a.id && v.room !== 'toaster-' + session.id));
      },
    );
    await t.test(
      'duration changes, early close and main-room document import are persisted',
      async () => {
        const before = (await get(base + '/breakouts', owner.cookie)).json().groups[0].endsAt;
        assert.equal(
          (await post(base + '/breakouts/' + groupId + '/extend', { seconds: 60 }, a.cookie))
            .statusCode,
          403,
        );
        assert.equal(
          (await post(base + '/breakouts/' + groupId + '/extend', { seconds: 60 }, owner.cookie))
            .statusCode,
          200,
        );
        assert.ok(
          new Date(
            (await get(base + '/breakouts', owner.cookie)).json().groups[0].endsAt,
          ).getTime() > new Date(before).getTime(),
        );
        assert.equal(
          (await post(base + '/breakouts/' + groupId + '/close', {}, owner.cookie)).statusCode,
          200,
        );
        assert.equal((await post('/classrooms/' + beta + '/join', {}, b.cookie)).statusCode, 403);
        assert.equal((await post(base + '/join', {}, b.cookie)).statusCode, 200);
        const commands = (await get(base + '/media-commands', owner.cookie)).json();
        const childSessionIds = (
          await pool.query('SELECT session_id FROM breakout_rooms WHERE group_id=$1', [groupId])
        ).rows.map((r) => r.session_id);
        assert.ok(
          commands.some(
            (command: { kind: string; session_id: string }) =>
              command.kind === 'delete_room' && childSessionIds.includes(command.session_id),
          ),
        );
        const failedChild = commands.find(
          (command: { kind: string; session_id: string }) =>
            command.kind === 'delete_room' && childSessionIds.includes(command.session_id),
        );
        await pool.query("UPDATE media_commands SET status='failed' WHERE id=$1", [failedChild.id]);
        assert.equal(
          (await post(base + '/media-commands/' + failedChild.id + '/retry', {}, a.cookie))
            .statusCode,
          403,
        );
        assert.equal(
          (await post(base + '/media-commands/' + failedChild.id + '/retry', {}, owner.cookie))
            .statusCode,
          200,
        );
        assert.equal(
          (await get('/classrooms/' + alpha + '/documents', owner.cookie)).statusCode,
          200,
        );
        const imported = await post(
          base + '/breakouts/' + groupId + '/import',
          { documentId: sourceDoc },
          owner.cookie,
        );
        assert.equal(imported.statusCode, 201);
        const stored = (await get(base + '/documents/' + imported.json().id, a.cookie)).json();
        assert.equal(stored.document.source_document_id, sourceDoc);
        const sourceBoard = (
          await post(
            '/classrooms/' + alpha + '/documents',
            { name: 'Group pages', kind: 'board', boardFormat: 'excalidraw' },
            owner.cookie,
          )
        ).json();
        assert.equal(
          (
            await post(
              '/classrooms/' + alpha + '/documents/' + sourceBoard.id + '/pages',
              {},
              owner.cookie,
            )
          ).statusCode,
          201,
        );
        const copiedBook = await post(
          base + '/breakouts/' + groupId + '/import',
          { documentId: sourceBoard.id },
          owner.cookie,
        );
        assert.equal(copiedBook.statusCode, 201);
        const mainDocs = (await get(base + '/documents', owner.cookie)).json();
        const copyPages = mainDocs.filter(
          (d: { id: string; board_book_id: string | null }) =>
            d.id === copiedBook.json().id || d.board_book_id === copiedBook.json().id,
        );
        assert.equal(copyPages.length, 2);
        for (const page of copyPages)
          assert.equal(
            (await get(base + '/documents/' + page.id + '/board', a.cookie)).statusCode,
            200,
          );
        const restored = new Y.Doc();
        for (const update of stored.updates)
          Y.applyUpdate(restored, Buffer.from(update.update_base64, 'base64'));
        assert.equal(restored.getText('content').toString(), 'Group notes - shared result');
        restored.destroy();
        assert.equal(
          (
            await post(
              base + '/breakouts/' + groupId + '/import',
              { documentId: sourceDoc },
              a.cookie,
            )
          ).statusCode,
          403,
        );
      },
    );
    await t.test('self selection respects group identity and server expiration', async () => {
      const created = await post(
        base + '/breakouts',
        {
          ...payload,
          allowSelfSelect: true,
          allocation: { mode: 'balanced-random', userIds: [a.id, b.id] },
        },
        owner.cookie,
      );
      assert.equal(created.statusCode, 201);
      const id = created.json().id;
      const state = (await get(base + '/breakouts', owner.cookie)).json().groups[0];
      assert.equal(state.rooms[0].assignedCount, 1);
      assert.equal(state.rooms[1].assignedCount, 1);
      const destination = state.rooms[0].id;
      assert.equal(
        (
          await post(
            base + '/breakouts/' + id + '/assign',
            { userId: a.id, roomId: destination },
            a.cookie,
          )
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await post(
            base + '/breakouts/' + id + '/assign',
            { userId: b.id, roomId: destination },
            a.cookie,
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await post(
            base + '/breakouts/' + id + '/assign',
            { userId: a.id, roomId: alpha },
            owner.cookie,
          )
        ).statusCode,
        400,
      );
      await pool.query('UPDATE breakout_groups SET ends_at=$1 WHERE id=$2', [
        new Date(Date.now() - 1000),
        id,
      ]);
      assert.equal(
        (await post('/classrooms/' + destination + '/join', {}, a.cookie)).statusCode,
        403,
      );
      await service.expire();
      const expired = (await pool.query('SELECT status FROM breakout_groups WHERE id=$1', [id]))
        .rows[0];
      assert.equal(expired.status, 'closed');
      const event = (
        await pool.query(
          "SELECT actor_kind,actor_id FROM audit_logs WHERE action='breakout.expired'",
        )
      ).rows[0];
      assert.equal(event.actor_kind, 'system');
      assert.equal(event.actor_id, null);
    });
    await t.test('ending main session atomically ends all active children', async () => {
      const created = await post(base + '/breakouts', payload, owner.cookie);
      assert.equal(created.statusCode, 201);
      const id = created.json().id;
      assert.equal((await post(base + '/session/end', {}, owner.cookie)).statusCode, 200);
      assert.equal(
        (await pool.query('SELECT status FROM breakout_groups WHERE id=$1', [id])).rows[0].status,
        'closed',
      );
      const children = (
        await pool.query(
          'SELECT s.ended_at,s.active_key FROM breakout_rooms r JOIN classroom_sessions s ON s.id=r.session_id WHERE r.group_id=$1',
          [id],
        )
      ).rows;
      assert.ok(children.every((s) => s.ended_at && s.active_key === null));
    });
  } finally {
    await app.close();
    await cleanup();
  }
});
