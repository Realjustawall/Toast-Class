import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../apps/api/src/app';
import { testDatabase, hasRealDatabase } from './database';

test('chat categories default to Public and enforce moderator ownership, isolation and history preservation', async () => {
  const { pool, cleanup } = await testDatabase(),
    origin = 'http://localhost:5173';
  const app = await buildApp(pool, {
    origin,
    production: false,
    mediaUrl: '',
    mediaKey: '',
    mediaSecret: '',
  });
  const post = (path: string, payload: unknown, cookie = '') =>
    app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: { origin, cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
  const get = (path: string, cookie: string) =>
    app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
  const account = async (name: string) => {
    const email = name + '@categories.test',
      password = 'chat-category-password';
    const created = await post('/auth/register', { email, password, name });
    assert.equal(created.statusCode, 201);
    const login = await post('/auth/login', { email, password });
    assert.equal(login.statusCode, 200);
    return {
      id: created.json().id,
      email,
      cookie: String(login.headers['set-cookie']).split(';')[0],
    };
  };
  try {
    const owner = await account('owner'),
      student = await account('learner'),
      teacher = await account('teacher');
    const org = (await post('/organizations', { name: 'Chat categories' }, owner.cookie)).json();
    for (const member of [student, teacher])
      assert.equal(
        (
          await post(
            '/organizations/' + org.id + '/members',
            { email: member.email, role: member === teacher ? 'teacher' : 'student' },
            owner.cookie,
          )
        ).statusCode,
        201,
      );
    const room = (
      await post(
        '/organizations/' + org.id + '/classrooms',
        { name: 'Main', enrollmentMode: 'organization' },
        owner.cookie,
      )
    ).json();
    const other = (
      await post(
        '/organizations/' + org.id + '/classrooms',
        { name: 'Other', enrollmentMode: 'organization' },
        owner.cookie,
      )
    ).json();
    const base = '/classrooms/' + room.id,
      categories = base + '/chat-categories';
    assert.deepEqual((await get(categories, student.cookie)).json(), []);
    assert.equal((await get(categories, '')).statusCode, 401);
    assert.equal(
      (await post(categories, { name: 'Unauthorized' }, student.cookie)).statusCode,
      403,
    );
    for (const name of ['', 'x'.repeat(61), 'bad\nname'])
      assert.equal((await post(categories, { name }, owner.cookie)).statusCode, 400);
    assert.equal((await post(categories, { name: 'Public' }, owner.cookie)).statusCode, 409);
    const created = await post(categories, { name: '  تمرین‌ها  ' }, teacher.cookie);
    assert.equal(created.statusCode, 201);
    const category = created.json();
    assert.equal(category.name, 'تمرین‌ها');
    assert.equal((await post(categories, { name: 'تمرین‌ها' }, owner.cookie)).statusCode, 409);
    const plain = await post(
      base + '/messages',
      { body: 'A question? Still public.' },
      student.cookie,
    );
    assert.equal(plain.statusCode, 201);
    const categorized = await post(
      base + '/messages',
      { body: 'Exercise answer', categoryId: category.id },
      student.cookie,
    );
    assert.equal(categorized.statusCode, 201);
    assert.equal(
      (
        await post(
          '/classrooms/' + other.id + '/messages',
          { body: 'Wrong classroom', categoryId: category.id },
          owner.cookie,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await get('/classrooms/' + other.id + '/messages?categoryId=' + category.id, owner.cookie)
      ).json().length,
      0,
    );
    assert.equal(
      (await get(base + '/messages?categoryId=public', student.cookie)).json().length,
      1,
    );
    assert.equal(
      (await get(base + '/messages?categoryId=' + category.id, student.cookie)).json()[0].body,
      'Exercise answer',
    );
    assert.equal((await get(base + '/messages?categoryId=invalid', owner.cookie)).statusCode, 400);
    assert.equal((await get(base + '/messages', owner.cookie)).json().length, 2);
    assert.equal(
      (await post(categories + '/' + category.id + '/delete', {}, student.cookie)).statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          '/classrooms/' + other.id + '/chat-categories/' + category.id + '/delete',
          {},
          owner.cookie,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await post(categories + '/' + category.id + '/delete', {}, owner.cookie)).statusCode,
      200,
    );
    const publicHistory = (await get(base + '/messages?categoryId=public', student.cookie)).json();
    assert.equal(publicHistory.length, 2);
    assert.ok(
      publicHistory.every((message: { category_id: unknown }) => message.category_id === null),
    );
    assert.ok(
      publicHistory.some((message: { id: string }) => message.id === categorized.json().id),
    );
    assert.equal(
      (
        await post(
          base + '/messages',
          { body: 'Deleted category', categoryId: category.id },
          student.cookie,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await post(categories + '/' + category.id + '/delete', {}, owner.cookie)).statusCode,
      404,
    );
    assert.equal((await post(categories + '/public/delete', {}, owner.cookie)).statusCode, 400);
    assert.equal((await post(categories, { name: 'تمرین‌ها' }, owner.cookie)).statusCode, 201);
    for (let index = 0; index < 10; index++)
      assert.equal(
        (await post(categories, { name: 'Category ' + index }, owner.cookie)).statusCode,
        201,
      );
    if (hasRealDatabase) {
      const concurrent = await Promise.all(
        ['One', 'Two'].map((name) => post(categories, { name }, owner.cookie)),
      );
      assert.deepEqual(concurrent.map((result) => result.statusCode).sort(), [201, 409]);
    } else assert.equal((await post(categories, { name: 'Last' }, owner.cookie)).statusCode, 201);
    assert.equal((await get(categories, student.cookie)).json().length, 12);
    assert.equal((await post(categories, { name: 'Too many' }, owner.cookie)).statusCode, 409);
    const audit = (
      await pool.query(
        "SELECT action FROM audit_logs WHERE organization_id=$1 AND action LIKE 'chat.category_%'",
        [org.id],
      )
    ).rows;
    assert.ok(audit.some((entry) => entry.action === 'chat.category_created'));
    assert.ok(audit.some((entry) => entry.action === 'chat.category_deleted'));
  } finally {
    await app.close();
    await cleanup();
  }
});
