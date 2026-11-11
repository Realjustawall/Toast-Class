import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TrackSource, AccessToken } from 'livekit-server-sdk';
import { buildApp } from '../apps/api/src/app';
import {
  MediaService,
  allowedSources,
  mediaRoomName,
  type MediaControl,
} from '../apps/api/src/media-control';
import { testDatabase, hasRealDatabase } from './database';

test('publishing policy enumerates only permitted sources and a block overrides all', () => {
  assert.deepEqual(
    allowedSources({
      microphone: true,
      camera: false,
      screen_share: false,
      blocked: false,
      version: 0,
    }),
    [TrackSource.MICROPHONE],
  );
  assert.deepEqual(
    allowedSources({
      microphone: true,
      camera: true,
      screen_share: true,
      blocked: true,
      version: 9,
    }),
    [],
  );
});
test(
  'real database media outbox: permissions, stale grants, bounded retry and session teardown',
  { skip: !hasRealDatabase },
  async (t) => {
    const { pool, cleanup } = await testDatabase();
    const origin = 'http://localhost:5173';
    let failControl = false;
    const calls: { kind: string; room: string; id?: string; version?: number }[] = [];
    const control: MediaControl = {
      async deleteRoom(room) {
        if (failControl) throw new Error('test transport failure');
        calls.push({ kind: 'delete', room });
      },
      async removeParticipant(room, id) {
        if (failControl) throw new Error('test transport failure');
        calls.push({ kind: 'remove', room, id });
      },
      async applyPolicy(room, id, policy) {
        if (failControl) throw new Error('test transport failure');
        calls.push({ kind: 'permissions', room, id, version: policy.version });
      },
      async participants() {
        return [];
      },
    };
    const config = {
      origin,
      production: false,
      mediaKey: 'test-key',
      mediaSecret: 'test-key-secret-that-is-long-enough',
      mediaUrl: 'ws://127.0.0.1:9',
      mediaControl: control,
      mediaWorker: false,
    };
    const app = await buildApp(pool, config);
    const service = new MediaService(pool, config);
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
      await post(
        '/auth/register',
        { email, name: email, password: 'media-policy-test-password' },
        '',
      );
      const r = await post('/auth/login', { email, password: 'media-policy-test-password' }, '');
      return { id: r.json().id, cookie: String(r.headers['set-cookie']).split(';')[0] };
    }
    try {
      const owner = await account('owner@policy.test'),
        student = await account('student@policy.test'),
        other = await account('other@policy.test');
      const org = (await post('/organizations', { name: 'Media policies' }, owner.cookie)).json();
      await post(
        '/organizations/' + org.id + '/members',
        { email: 'student@policy.test', role: 'student' },
        owner.cookie,
      );
      const room = (
        await post(
          '/organizations/' + org.id + '/classrooms',
          { enrollmentMode: 'organization', name: 'Moderation' },
          owner.cookie,
        )
      ).json();
      const base = '/classrooms/' + room.id;
      assert.equal((await post(base + '/join', {}, student.cookie)).statusCode, 409);
      const session = (await post(base + '/session/start', {}, owner.cookie)).json();
      const original = (await post(base + '/join', {}, student.cookie)).json();
      await t.test(
        'media gateway rejects expired signatures, swapped identities and untrusted websocket origins',
        async () => {
          const claims = JSON.parse(
            Buffer.from(original.token.split('.')[1], 'base64url').toString(),
          );
          const expired = new AccessToken(config.mediaKey, config.mediaSecret, {
            identity: student.id,
            metadata: claims.metadata,
            ttl: -10,
          });
          expired.addGrant({
            roomJoin: true,
            room: claims.video.room,
            canPublish: false,
            canSubscribe: true,
          });
          assert.equal(
            (
              await get(
                '/media/signal/rtc/validate?access_token=' +
                  encodeURIComponent(await expired.toJwt()),
                student.cookie,
              )
            ).statusCode,
            401,
          );
          assert.equal(
            (await get('/media/signal/rtc/validate?access_token=invalid', student.cookie))
              .statusCode,
            401,
          );
          await assert.rejects(
            app.injectWS(
              '/api/v1/media/signal/rtc?access_token=' + encodeURIComponent(original.token),
              { headers: { origin: 'http://attacker.invalid', cookie: student.cookie } },
            ),
          );
        },
      );
      const route = base + '/participants/' + student.id + '/permissions';
      const denied = { microphone: false, camera: false, screenShare: false, blocked: false };
      await t.test('student and cross-tenant moderation are denied', async () => {
        assert.equal((await post(route, denied, student.cookie)).statusCode, 403);
        assert.equal((await post(route, denied, other.cookie)).statusCode, 403);
      });
      let command = '';
      await t.test(
        'permission change persists before applying and invalidates stale signaling grants',
        async () => {
          const response = await post(route, denied, owner.cookie);
          assert.equal(response.statusCode, 202);
          command = response.json().commandId;
          assert.equal(
            (
              await get(
                '/media/signal/rtc/validate?access_token=' + encodeURIComponent(original.token),
                student.cookie,
              )
            ).statusCode,
            403,
          );
          const fresh = (await post(base + '/join', {}, student.cookie)).json();
          const claims = JSON.parse(Buffer.from(fresh.token.split('.')[1], 'base64url').toString());
          assert.equal(claims.video.canPublish, false);
          assert.equal(JSON.parse(claims.metadata).policyVersion, 1);
          assert.equal(
            (
              await get(
                '/media/signal/rtc/validate?access_token=' + encodeURIComponent(fresh.token),
                owner.cookie,
              )
            ).statusCode,
            403,
          );
          assert.equal(await service.processOne(), true);
          assert.deepEqual(calls[0], {
            kind: 'permissions',
            room: mediaRoomName(session.id),
            id: student.id,
            version: 1,
          });
          assert.equal(
            (await pool.query('SELECT status FROM media_commands WHERE id=$1', [command])).rows[0]
              .status,
            'succeeded',
          );
        },
      );
      await t.test('superseded policies do not restore stale privileges', async () => {
        await post(
          route,
          { microphone: true, camera: true, screenShare: true, blocked: false },
          owner.cookie,
        );
        await post(
          route,
          { microphone: false, camera: false, screenShare: false, blocked: true },
          owner.cookie,
        );
        const before = calls.length;
        await service.processOne();
        assert.equal(calls.length, before);
        await service.processOne();
        assert.equal(calls.at(-1)?.kind, 'remove');
        assert.equal((await post(base + '/join', {}, student.cookie)).statusCode, 403);
      });
      await t.test(
        'SFU failure has bounded durable retries, visible failure and authorized retry',
        async () => {
          failControl = true;
          const response = await post(route, { ...denied, blocked: false }, owner.cookie);
          const id = response.json().commandId;
          for (let i = 0; i < 8; i++) {
            await pool.query('UPDATE media_commands SET next_attempt_at=$1 WHERE id=$2', [
              new Date(Date.now() - 1000),
              id,
            ]);
            assert.equal(await service.processOne(), true);
          }
          const failed = (await pool.query('SELECT * FROM media_commands WHERE id=$1', [id]))
            .rows[0];
          assert.equal(failed.status, 'failed');
          assert.equal(failed.attempts, 8);
          assert.ok(failed.last_error);
          assert.equal(
            (await post(base + '/media-commands/' + id + '/retry', {}, student.cookie)).statusCode,
            403,
          );
          assert.equal(
            (await post(base + '/media-commands/' + id + '/retry', {}, owner.cookie)).statusCode,
            200,
          );
          failControl = false;
          await service.processOne();
          assert.equal(
            (await pool.query('SELECT status FROM media_commands WHERE id=$1', [id])).rows[0]
              .status,
            'succeeded',
          );
        },
      );
      await t.test(
        'ending session queues actual SFU deletion and prevents old tokens reopening it',
        async () => {
          const ids = [
            owner.id,
            student.id,
            other.id,
            ...Array.from({ length: 797 }, () => randomUUID()),
          ];
          let reads = 0;
          const batched = new MediaService(
            {
              dialect: pool.dialect,
              query: (...args) => {
                reads++;
                return pool.query(...args);
              },
              connect: () => pool.connect(),
              end: () => pool.end(),
            },
            config,
          );
          const policies = await batched.policies(session.id, ids);
          assert.equal(reads, 2, 'An 800-person moderation roster must not enqueue 1600 queries');
          assert.equal(policies.size, 800);
          for (const id of ids.slice(0, 4))
            assert.deepEqual(policies.get(id), await service.policy(session.id, id));
          const token = (await post(base + '/join', {}, student.cookie)).json().token;
          assert.equal((await post(base + '/session/end', {}, owner.cookie)).statusCode, 200);
          assert.equal((await post(base + '/join', {}, owner.cookie)).statusCode, 409);
          assert.equal(
            (
              await get(
                '/media/signal/rtc/validate?access_token=' + encodeURIComponent(token),
                student.cookie,
              )
            ).statusCode,
            403,
          );
          await service.processOne();
          assert.equal(calls.at(-1)?.kind, 'delete');
          assert.equal((await get(base + '/media-commands', student.cookie)).statusCode, 403);
          const commands = (await get(base + '/media-commands', owner.cookie)).json();
          assert.equal(
            commands.find((c: { kind: string }) => c.kind === 'delete_room').status,
            'succeeded',
          );
        },
      );
    } finally {
      await app.close();
      await cleanup();
    }
  },
);
