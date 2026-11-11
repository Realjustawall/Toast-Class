import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './database';
import { buildApp } from '../apps/api/src/app';

test('organization operations uses persisted data, bounded pages and owner-only tenant isolation', async () => {
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
    await post('/auth/register', { email, name: email, password: 'admin-test-password' }, '');
    return String(
      (await post('/auth/login', { email, password: 'admin-test-password' }, '')).headers[
        'set-cookie'
      ],
    ).split(';')[0];
  }
  try {
    const owner = await account('admin-owner@example.org'),
      teacher = await account('admin-teacher@example.org'),
      student = await account('admin-student@example.org'),
      outsider = await account('admin-other@example.org');
    const org = (await post('/organizations', { name: 'First school' }, owner)).json().id;
    const other = (await post('/organizations', { name: 'Private school' }, outsider)).json().id;
    for (const role of ['teacher', 'student'])
      await post(
        `/organizations/${org}/members`,
        { email: `admin-${role}@example.org`, role },
        owner,
      );
    const room = (
      await post(
        `/organizations/${org}/classrooms`,
        { enrollmentMode: 'organization', name: 'Live workshop' },
        owner,
      )
    ).json().id;
    await post(`/classrooms/${room}/session/start`, {}, owner);
    const base = `/organizations/${org}/admin`;
    for (const endpoint of ['/overview', '/members', '/audit']) {
      assert.equal((await get(base + endpoint, '')).statusCode, 401);
      for (const cookie of [teacher, student, outsider])
        assert.equal((await get(base + endpoint, cookie)).statusCode, 403);
      assert.equal((await get(`/organizations/${other}/admin` + endpoint, owner)).statusCode, 403);
    }
    const r = await get(base + '/overview', owner);
    assert.equal(r.statusCode, 200, r.body);
    const overview = r.json();
    assert.equal(overview.classroomCount, 1);
    assert.equal(overview.activeSessionCount, 1);
    assert.equal(overview.activeSessions[0].name, 'Live workshop');
    assert.equal(
      overview.members.reduce((sum: number, row: { count: string }) => sum + Number(row.count), 0),
      3,
    );
    const members = (await get(base + '/members?limit=2', owner)).json();
    assert.equal(members.items.length, 2);
    assert.equal(members.hasMore, true);
    const tail = (await get(base + '/members?limit=2&offset=2', owner)).json();
    assert.equal(tail.items.length, 1);
    assert.equal(tail.hasMore, false);
    assert.equal(new Set([...members.items, ...tail.items].map((row) => row.id)).size, 3);
    assert.equal(members.items[0].password_hash, undefined);
    const logs = (await get(base + '/audit?limit=1', owner)).json();
    assert.equal(logs.items.length, 1);
    assert.equal(logs.hasMore, true);
    assert.equal(logs.items[0].details, undefined);
    const action = logs.items[0].action;
    const filtered = (await get(base + '/audit?action=' + action, owner)).json();
    assert.ok(filtered.items.every((row: { action: string }) => row.action === action));
    assert.equal((await get(base + '/members?limit=101', owner)).statusCode, 400);
    assert.equal((await get(base + '/audit?action=bad%27', owner)).statusCode, 400);
    await post(`/classrooms/${room}/session/end`, {}, owner);
    assert.equal((await get(base + '/overview', owner)).json().activeSessionCount, 0);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('classroom themes, admin theme defaults, RBAC role changes and granular room security policies', async () => {
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
    const reg = await post(
      '/auth/register',
      { email, name: email, password: 'theme-security-password' },
      '',
    );
    const cookie = String(
      (await post('/auth/login', { email, password: 'theme-security-password' }, '')).headers[
        'set-cookie'
      ],
    ).split(';')[0];
    return { id: reg.json().id as string, cookie };
  }
  try {
    const owner = await account('theme-owner@example.org');
    const teacher = await account('theme-teacher@example.org');
    const student = await account('theme-student@example.org');
    const orgRes = await post('/organizations', { name: 'Theme Academy' }, owner.cookie);
    assert.equal(orgRes.statusCode, 201);
    const org = orgRes.json();
    assert.equal(org.default_classroom_theme, 'classic-bbb');

    await post(
      `/organizations/${org.id}/members`,
      { email: 'theme-teacher@example.org', role: 'teacher' },
      owner.cookie,
    );
    await post(
      `/organizations/${org.id}/members`,
      { email: 'theme-student@example.org', role: 'student' },
      owner.cookie,
    );

    // Default classroom inherits classic-bbb (Option 1)
    const defaultRoomRes = await post(
      `/organizations/${org.id}/classrooms`,
      { enrollmentMode: 'organization', name: 'Default BBB Room' },
      owner.cookie,
    );
    assert.equal(defaultRoomRes.statusCode, 201);
    const defaultRoom = defaultRoomRes.json();
    assert.equal(defaultRoom.theme, 'classic-bbb');
    assert.equal(defaultRoom.permissions.chatEnabled, true);
    assert.equal(defaultRoom.permissions.locked, false);

    // Owner updates organization default theme to modular-skyroom and applies to existing
    assert.equal(
      (
        await post(
          `/organizations/${org.id}/admin/theme`,
          { defaultClassroomTheme: 'modular-skyroom' },
          teacher.cookie,
        )
      ).statusCode,
      403,
    );
    const themeUpdate = await post(
      `/organizations/${org.id}/admin/theme`,
      { defaultClassroomTheme: 'modular-skyroom', applyToExisting: true },
      owner.cookie,
    );
    assert.equal(themeUpdate.statusCode, 200);
    assert.equal(
      (await get(`/classrooms/${defaultRoom.id}`, student.cookie)).json().theme,
      'modular-skyroom',
    );

    // Owners configure classroom types; assigned teachers run the teaching session.
    const customRoomRes = await post(
      `/organizations/${org.id}/classrooms`,
      {
        enrollmentMode: 'organization',
        name: 'Strict Glass Room',
        theme: 'immersive-glass',
        permissions: {
          chatEnabled: false,
          handRaiseEnabled: false,
          studentWhiteboardEnabled: false,
          defaultMicrophone: false,
          defaultCamera: false,
          defaultScreenShare: false,
          locked: false,
        },
      },
      owner.cookie,
    );
    assert.equal(customRoomRes.statusCode, 201);
    const customRoom = customRoomRes.json();
    assert.equal(customRoom.theme, 'immersive-glass');
    assert.equal(customRoom.permissions.chatEnabled, false);

    // Start session and verify student cannot raise hand or post chat when disabled
    await post(`/classrooms/${customRoom.id}/session/start`, {}, teacher.cookie);
    assert.equal(
      (await post(`/classrooms/${customRoom.id}/messages`, { body: 'Hello' }, student.cookie))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          `/classrooms/${customRoom.id}/messages`,
          { body: 'Teacher announcement' },
          teacher.cookie,
        )
      ).statusCode,
      201,
    );
    assert.equal(
      (await post(`/classrooms/${customRoom.id}/hand`, { raised: true }, student.cookie))
        .statusCode,
      403,
    );

    // Student cannot clear chat or update settings
    assert.equal(
      (await post(`/classrooms/${customRoom.id}/messages/clear`, {}, student.cookie)).statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          `/classrooms/${customRoom.id}/settings`,
          { theme: 'studio-hybrid' },
          student.cookie,
        )
      ).statusCode,
      403,
    );

    // Teachers cannot alter the configured classroom type or base access policy.
    assert.equal(
      (
        await post(
          `/classrooms/${customRoom.id}/settings`,
          { theme: 'studio-hybrid' },
          teacher.cookie,
        )
      ).statusCode,
      403,
    );
    // Owner locks classroom and switches type from administration.
    const lockRes = await post(
      `/classrooms/${customRoom.id}/settings`,
      {
        theme: 'studio-hybrid',
        permissions: { locked: true, chatEnabled: true, handRaiseEnabled: true },
      },
      owner.cookie,
    );
    assert.equal(lockRes.statusCode, 200);
    assert.equal(lockRes.json().theme, 'studio-hybrid');
    assert.equal(lockRes.json().permissions.locked, true);

    // Student is blocked from accessing a locked classroom, while teacher/owner can access
    assert.equal((await get(`/classrooms/${customRoom.id}`, student.cookie)).statusCode, 403);
    assert.equal(
      (await get(`/classrooms/${customRoom.id}/teaching`, student.cookie)).statusCode,
      403,
    );
    assert.equal((await get(`/classrooms/${customRoom.id}`, teacher.cookie)).statusCode, 200);

    // Admin unlocks classroom from admin endpoint
    const adminUnlock = await post(
      `/organizations/${org.id}/admin/classrooms/${customRoom.id}/settings`,
      { theme: 'classic-bbb', permissions: { locked: false } },
      owner.cookie,
    );
    assert.equal(adminUnlock.statusCode, 200);
    assert.equal((await get(`/classrooms/${customRoom.id}`, student.cookie)).statusCode, 200);
    assert.equal(
      (await post(`/classrooms/${customRoom.id}/messages`, { body: 'Now allowed' }, student.cookie))
        .statusCode,
      201,
    );
    assert.equal(
      (await post(`/classrooms/${customRoom.id}/messages/clear`, {}, teacher.cookie)).statusCode,
      200,
    );
    assert.equal(
      (await get(`/classrooms/${customRoom.id}/messages`, student.cookie)).json().length,
      0,
    );

    // Individual Per-User Permissions:
    // 1. Mute individual student chat even when room-wide chat is enabled
    const muteSingleUserChat = await post(
      `/classrooms/${customRoom.id}/user-permissions/${student.id}`,
      { canChat: false, isPresenter: true },
      teacher.cookie,
    );
    assert.equal(muteSingleUserChat.statusCode, 200);
    assert.equal(muteSingleUserChat.json().effective.canChat, false);
    assert.equal(muteSingleUserChat.json().effective.isPresenter, true);
    assert.equal(muteSingleUserChat.json().effective.canWhiteboard, true);
    assert.equal(
      (
        await post(
          `/classrooms/${customRoom.id}/messages`,
          { body: 'Individually muted' },
          student.cookie,
        )
      ).statusCode,
      403,
    );

    // 2. Kick individual student from classroom
    await post(
      `/classrooms/${customRoom.id}/user-permissions/${student.id}`,
      { kicked: true },
      teacher.cookie,
    );
    assert.equal(
      (await get(`/classrooms/${customRoom.id}/teaching`, student.cookie)).statusCode,
      403,
    );

    // 3. Restore kicked student and allow individual chat
    await post(
      `/classrooms/${customRoom.id}/user-permissions/${student.id}`,
      { kicked: false, canChat: true },
      teacher.cookie,
    );
    assert.equal(
      (await get(`/classrooms/${customRoom.id}/teaching`, student.cookie)).statusCode,
      200,
    );

    // 4. Live participant status & pinned announcement
    assert.equal(
      (await post(`/classrooms/${customRoom.id}/status`, { status: 'applause' }, student.cookie))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await post(
          `/classrooms/${customRoom.id}/notice`,
          { pinnedNotice: 'Midterm exam at 14:00', externalMediaUrl: 'https://example.com/video' },
          teacher.cookie,
        )
      ).statusCode,
      200,
    );
    const updatedTeaching = (
      await get(`/classrooms/${customRoom.id}/teaching`, student.cookie)
    ).json();
    assert.equal(updatedTeaching.pinnedNotice, 'Midterm exam at 14:00');
    assert.equal(updatedTeaching.statuses.length, 1);
    assert.equal(updatedTeaching.statuses[0].status, 'applause');

    // Owner can promote student to teacher and demote back, but cannot demote owner
    assert.equal(
      (
        await post(
          `/organizations/${org.id}/admin/members/${owner.id}/role`,
          { role: 'student' },
          owner.cookie,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          `/organizations/${org.id}/admin/members/${student.id}/role`,
          { role: 'teacher' },
          owner.cookie,
        )
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
    await cleanup();
  }
});
