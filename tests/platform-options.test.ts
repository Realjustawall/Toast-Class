import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../apps/api/src/app';
import { testDatabase } from './database';
import { DEFAULT_PLATFORM_OPTIONS } from '../packages/classroom-settings/schema';
test('platform options are admin-only, revisioned and enforced by organization, chat, image, feature and classroom APIs', async () => {
  const { pool, cleanup } = await testDatabase(),
    origin = 'http://localhost:5173';
  const app = await buildApp(pool, {
    origin,
    production: false,
    mediaUrl: '',
    mediaKey: '',
    mediaSecret: '',
    mediaWorker: false,
  });
  const post = (path: string, data: unknown, cookie = '') =>
    app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: { origin, cookie },
      payload: data as object,
    });
  const get = (path: string, cookie = '') =>
    app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
  const account = async (name: string) => {
    const email = name + '@platform-options.test',
      r = await post('/auth/register', { name, email, password: '123456' });
    assert.equal(r.statusCode, 201);
    const login = await post('/auth/login', { email, password: '123456' });
    return { id: r.json().id, email, cookie: String(login.headers['set-cookie']).split(';')[0] };
  };
  try {
    const admin = await account('Admin'),
      owner = await account('Owner');
    await pool.query('INSERT INTO platform_admins(user_id) VALUES($1)', [admin.id]);
    const org = (await post('/organizations', { name: 'Existing' }, owner.cookie)).json();
    const room = (
        await post(
          '/organizations/' + org.id + '/classrooms',
          { name: 'Existing class' },
          owner.cookie,
        )
      ).json(),
      base = '/classrooms/' + room.id;
    const board = (await post(base + '/board-book', {}, owner.cookie)).json(),
      geo = (await post(base + '/geogebra', { name: 'Before disable' }, owner.cookie)).json();
    await post(
      base + '/workspace',
      { kind: 'geogebra', geogebraId: geo.id, expectedRevision: 0 },
      owner.cookie,
    );
    for (let i = 0; i < 25; i++)
      assert.equal(
        (await post(base + '/messages', { body: 'Message ' + i }, owner.cookie)).statusCode,
        201,
      );
    assert.equal((await get('/platform/settings', owner.cookie)).statusCode, 403);
    const options = {
      ...DEFAULT_PLATFORM_OPTIONS,
      siteName: 'مدرسهٔ آزمایش',
      welcomeText: 'ورود به مدرسه',
      supportUrl: 'https://example.org/help',
      defaultLanguage: 'en',
      defaultTheme: 'studio-hybrid',
      allowOrgCreation: false,
      chatHistoryLimit: 20,
      chatMessageMaxLength: 200,
      chatImageMaxMiB: 1,
      geoEnabled: false,
      pdfImportEnabled: false,
      defaultPermissions: {
        ...DEFAULT_PLATFORM_OPTIONS.defaultPermissions,
        defaultMicrophone: false,
      },
      defaultLocks: { ...DEFAULT_PLATFORM_OPTIONS.defaultLocks, camera: true },
    };
    assert.equal(
      (
        await post(
          '/platform/settings',
          { options, registrationOpen: true, expectedRevision: 0 },
          owner.cookie,
        )
      ).statusCode,
      403,
    );
    const saved = await post(
      '/platform/settings',
      { options, registrationOpen: true, expectedRevision: 0 },
      admin.cookie,
    );
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().revision, 1);
    assert.equal((await get('/app/settings')).json().options.siteName, options.siteName);
    assert.equal((await get(base + '/workspace', owner.cookie)).json().documentId, board.id);
    assert.equal(
      (
        await post(
          '/platform/settings',
          { options, registrationOpen: true, expectedRevision: 0 },
          admin.cookie,
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await post(
          '/platform/settings',
          {
            options: { ...options, supportUrl: 'javascript:alert(1)' },
            registrationOpen: true,
            expectedRevision: 1,
          },
          admin.cookie,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (await post('/organizations', { name: 'Forbidden' }, owner.cookie)).statusCode,
      403,
    );
    const nextOrg = await post('/organizations', { name: 'Admin creates' }, admin.cookie);
    assert.equal(nextOrg.statusCode, 201);
    const nextRoom = (
      await post(
        '/organizations/' + nextOrg.json().id + '/classrooms',
        { name: 'Default class' },
        admin.cookie,
      )
    ).json();
    assert.equal(nextRoom.theme, 'studio-hybrid');
    assert.equal(nextRoom.permissions.defaultMicrophone, false);
    assert.equal(
      (await get('/classrooms/' + nextRoom.id + '/locks', admin.cookie)).json().locks.camera,
      true,
    );
    assert.equal((await get(base + '/messages', owner.cookie)).json().length, 20);
    assert.equal(
      Number(
        (
          await pool.query('SELECT COUNT(*) AS count FROM messages WHERE classroom_id=$1', [
            room.id,
          ])
        ).rows[0].count,
      ),
      25,
    );
    assert.equal(
      (await post(base + '/messages', { body: 'a'.repeat(201) }, owner.cookie)).statusCode,
      400,
    );
    assert.equal((await get(base + '/geogebra', owner.cookie)).statusCode, 403);
    assert.equal(
      (await post(base + '/geogebra', { name: 'Disabled' }, owner.cookie)).statusCode,
      403,
    );
    const blockedPdf = await app.inject({
      method: 'POST',
      url: '/api/v1' + base + '/files?boardImage=1',
      headers: {
        origin,
        cookie: owner.cookie,
        'x-toaster-file-size': '10',
        'content-type': 'multipart/form-data; boundary=empty',
      },
      payload: '--empty--\r\n',
    });
    assert.equal(blockedPdf.statusCode, 403);
    const locale = await account('NewLanguage');
    assert.equal((await get('/account', locale.cookie)).json().locale, 'en');
    assert.equal(
      (await post('/platform/registration', { open: false, expectedRevision: 1 }, admin.cookie))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await post('/auth/register', {
          name: 'Closed',
          email: 'closed@platform-options.test',
          password: '123456',
        })
      ).statusCode,
      403,
    );
    assert.equal((await get('/app/settings')).json().options.chatMessageMaxLength, 200);
  } finally {
    await app.close();
    await cleanup();
  }
});
