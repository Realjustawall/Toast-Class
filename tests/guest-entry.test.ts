import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../apps/api/src/app';
import { testDatabase } from './database';
import { DEFAULT_PLATFORM_OPTIONS } from '../packages/classroom-settings/schema';

test('guest entry is disabled by default, configurable in admin/platform, and enforces 1 guest per IP and device plus capacity', async () => {
  const { pool, cleanup } = await testDatabase();
  const origin = 'http://localhost:5173';
  const app = await buildApp(pool, {
    origin,
    production: false,
    mediaUrl: '',
    mediaKey: '',
    mediaSecret: '',
    mediaWorker: false,
  });

  const post = (path: string, data: unknown, cookie = '', remoteAddress = '127.0.0.1') =>
    app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: { origin, cookie },
      remoteAddress,
      payload: data as object,
    });

  const get = (path: string, cookie = '') =>
    app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });

  const account = async (name: string) => {
    const email = `${name}@guest-entry.test`;
    const r = await post('/auth/register', { name, email, password: 'Password123!' });
    assert.equal(r.statusCode, 201);
    const login = await post('/auth/login', { email, password: 'Password123!' });
    return {
      id: r.json().id as string,
      email,
      cookie: String(login.headers['set-cookie']).split(';')[0],
    };
  };

  try {
    assert.equal(DEFAULT_PLATFORM_OPTIONS.guestEntryEnabled, false);
    assert.equal(DEFAULT_PLATFORM_OPTIONS.guestMaxCapacity, 20);

    const admin = await account('Admin');
    const owner = await account('Owner');
    await pool.query('INSERT INTO platform_admins(user_id) VALUES($1)', [admin.id]);

    const org = (await post('/organizations', { name: 'Guest Test Org' }, owner.cookie)).json();
    const room1 = (
      await post('/organizations/' + org.id + '/classrooms', { name: 'Guest Room 1' }, owner.cookie)
    ).json();
    const room2 = (
      await post('/organizations/' + org.id + '/classrooms', { name: 'Guest Room 2' }, owner.cookie)
    ).json();

    assert.equal(room1.guestEntryEnabled, false);

    // Disabled by default at platform & classroom level
    const defaultInfo = await get(`/classrooms/${room1.id}/guest-info`);
    assert.equal(defaultInfo.statusCode, 200);
    assert.equal(defaultInfo.json().enabled, false);

    const deniedDefault = await post(
      `/classrooms/${room1.id}/guest-join`,
      { name: 'Guest One', deviceId: 'device-11111111' },
      '',
      '10.0.0.1',
    );
    assert.equal(deniedDefault.statusCode, 403);

    // Enable at platform level, still disabled at classroom level
    const currentPlatform = (await get('/platform/settings', admin.cookie)).json();
    const enablePlatform = await post(
      '/platform/settings',
      {
        expectedRevision: currentPlatform.revision,
        registrationOpen: currentPlatform.registrationOpen,
        options: {
          ...currentPlatform.options,
          guestEntryEnabled: true,
          guestMaxCapacity: 2,
        },
      },
      admin.cookie,
    );
    assert.equal(enablePlatform.statusCode, 200);

    const deniedRoomDisabled = await post(
      `/classrooms/${room1.id}/guest-join`,
      { name: 'Guest One', deviceId: 'device-11111111' },
      '',
      '10.0.0.1',
    );
    assert.equal(deniedRoomDisabled.statusCode, 403);

    // Enable at classroom level with max capacity 2
    const enableRoom = await post(
      `/organizations/${org.id}/admin/classrooms/${room1.id}/settings`,
      {
        guestEntryEnabled: true,
        guestMaxCapacity: 2,
      },
      owner.cookie,
    );
    assert.equal(enableRoom.statusCode, 200);
    assert.equal(enableRoom.json().guestEntryEnabled, true);
    assert.equal(enableRoom.json().guestMaxCapacity, 2);

    const enabledInfo = await get(`/classrooms/${room1.id}/guest-info`);
    assert.equal(enabledInfo.statusCode, 200);
    assert.equal(enabledInfo.json().enabled, true);
    assert.equal(enabledInfo.json().maxCapacity, 2);

    // Guest 1 joins from IP 10.0.0.1 and device-11111111
    const join1 = await post(
      `/classrooms/${room1.id}/guest-join`,
      { name: 'Guest One', deviceId: 'device-11111111' },
      '',
      '10.0.0.1',
    );
    assert.equal(join1.statusCode, 201);
    const guest1Cookie = String(join1.headers['set-cookie'])
      .split(',')
      .map((part) => part.split(';')[0].trim())
      .join('; ');

    // Same IP with different device must fail (max 1 per IP)
    const sameIp = await post(
      `/classrooms/${room1.id}/guest-join`,
      { name: 'Guest Same IP', deviceId: 'device-22222222' },
      '',
      '10.0.0.1',
    );
    assert.equal(sameIp.statusCode, 409);

    // Different IP with same device must fail (max 1 per device)
    const sameDevice = await post(
      `/classrooms/${room1.id}/guest-join`,
      { name: 'Guest Same Device', deviceId: 'device-11111111' },
      '',
      '10.0.0.2',
    );
    assert.equal(sameDevice.statusCode, 409);

    // Guest 2 joins from different IP and different device
    const join2 = await post(
      `/classrooms/${room1.id}/guest-join`,
      { name: 'Guest Two', deviceId: 'device-22222222' },
      '',
      '10.0.0.2',
    );
    assert.equal(join2.statusCode, 201);

    // Guest 3 rejected because max capacity (2) reached
    const capacityFull = await post(
      `/classrooms/${room1.id}/guest-join`,
      { name: 'Guest Three', deviceId: 'device-33333333' },
      '',
      '10.0.0.3',
    );
    assert.equal(capacityFull.statusCode, 409);

    // Guest 1 can access room1, cannot access room2
    const accessRoom1 = await get(`/classrooms/${room1.id}`, guest1Cookie);
    assert.equal(accessRoom1.statusCode, 200);
    const accessRoom2 = await get(`/classrooms/${room2.id}`, guest1Cookie);
    assert.equal(accessRoom2.statusCode, 403);

    // Admin overview reports active guestCount = 2
    const overviewBeforeClear = await get(`/organizations/${org.id}/admin/overview`, owner.cookie);
    assert.equal(overviewBeforeClear.statusCode, 200);
    const room1Summary = (
      overviewBeforeClear.json().classrooms as Array<{ id: string; guestCount?: number }>
    ).find((c) => c.id === room1.id);
    assert.equal(room1Summary?.guestCount, 2);

    // Clear guests resets count to 0 and frees capacity/IPs
    const cleared = await post(`/classrooms/${room1.id}/guests/clear`, {}, owner.cookie);
    assert.equal(cleared.statusCode, 200);
    const overviewAfterClear = await get(`/organizations/${org.id}/admin/overview`, owner.cookie);
    const room1AfterClear = (
      overviewAfterClear.json().classrooms as Array<{ id: string; guestCount?: number }>
    ).find((c) => c.id === room1.id);
    assert.equal(room1AfterClear?.guestCount, 0);

    // Disabling guestEntryEnabled revokes active guest access
    const disableRoom = await post(
      `/organizations/${org.id}/admin/classrooms/${room1.id}/settings`,
      { guestEntryEnabled: false },
      owner.cookie,
    );
    assert.equal(disableRoom.statusCode, 200);
    const revokedAccess = await get(`/classrooms/${room1.id}`, guest1Cookie);
    assert.equal(revokedAccess.statusCode, 401);
  } finally {
    await app.close();
    await cleanup();
  }
});
