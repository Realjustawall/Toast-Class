import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZipFile } from 'yazl';
import { buildApp } from '../apps/api/src/app';
import { testDatabase } from './database';
import { validateGeoGebra } from '../apps/api/src/geogebra';
async function construction(xml: string) {
  const zip = new ZipFile(),
    parts: Buffer[] = [];
  zip.outputStream.on('data', (part) => parts.push(part));
  const ready = new Promise<Buffer>((resolve) =>
    zip.outputStream.on('end', () => resolve(Buffer.concat(parts))),
  );
  zip.addBuffer(Buffer.from(xml), 'geogebra.xml');
  zip.end();
  return (await ready).toString('base64');
}
test('GeoGebra validates archives, isolates classrooms and enforces editing grants, revision conflicts and safe retry', async () => {
  const { pool, cleanup } = await testDatabase(),
    origin = 'http://localhost:5173',
    app = await buildApp(pool, {
      origin,
      production: false,
      mediaUrl: '',
      mediaKey: '',
      mediaSecret: '',
    });
  const post = (path: string, data: unknown, cookie = '') =>
    app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: { origin, cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(data),
    });
  const get = (path: string, cookie: string) =>
    app.inject({ method: 'GET', url: '/api/v1' + path, headers: { cookie } });
  const account = async (name: string) => {
    const email = name + '@geogebra.test',
      password = 'geogebra-test-password';
    const created = await post('/auth/register', { email, password, name });
    assert.equal(created.statusCode, 201);
    const login = await post('/auth/login', { email, password });
    return {
      id: created.json().id,
      email,
      cookie: String(login.headers['set-cookie']).split(';')[0],
    };
  };
  try {
    const owner = await account('owner'),
      student = await account('student');
    const org = (await post('/organizations', { name: 'GeoGebra' }, owner.cookie)).json();
    assert.equal(
      (
        await post(
          '/organizations/' + org.id + '/members',
          { email: student.email, role: 'student' },
          owner.cookie,
        )
      ).statusCode,
      201,
    );
    const room = (
      await post(
        '/organizations/' + org.id + '/classrooms',
        { name: 'Math', enrollmentMode: 'organization' },
        owner.cookie,
      )
    ).json();
    const other = (
      await post('/organizations/' + org.id + '/classrooms', { name: 'Other' }, owner.cookie)
    ).json();
    const base = '/classrooms/' + room.id + '/geogebra';
    assert.deepEqual((await get(base, student.cookie)).json(), []);
    assert.equal((await post(base, { name: 'Forbidden' }, student.cookie)).statusCode, 403);
    const created = await post(base, { name: 'Lesson' }, owner.cookie);
    assert.equal(created.statusCode, 201);
    const id = created.json().id;
    assert.equal((await get(base + '/' + id, student.cookie)).json().canEdit, false);
    assert.equal(
      (await get('/classrooms/' + other.id + '/geogebra/' + id, owner.cookie)).statusCode,
      404,
    );
    const first = await construction('<geogebra format="5.0"><construction/></geogebra>');
    const second = await construction(
      '<geogebra format="5.0"><construction><element type="point" label="A"/></construction></geogebra>',
    );
    await validateGeoGebra(first);
    for (const data of [
      'AA==',
      'abc',
      'not base64',
      Buffer.from('broken archive').toString('base64'),
      await construction('<!DOCTYPE x [<!ENTITY e "bad">]><geogebra/>'),
    ])
      await assert.rejects(validateGeoGebra(data));
    assert.equal(
      (await post(base + '/' + id, { revision: 0, state: first }, student.cookie)).statusCode,
      403,
    );
    assert.equal(
      (await post(base + '/' + id, { revision: 0, state: 'AA==' }, owner.cookie)).statusCode,
      400,
    );
    assert.equal(
      (await post(base + '/' + id, { revision: 0, state: first }, owner.cookie)).json().revision,
      1,
    );
    assert.equal(
      (await post(base + '/' + id, { revision: 0, state: first }, owner.cookie)).json().revision,
      1,
    );
    assert.equal(
      (await post(base + '/' + id, { revision: 0, state: second }, owner.cookie)).statusCode,
      409,
    );
    assert.equal(
      (
        await post(
          '/classrooms/' + room.id + '/user-permissions/' + student.id,
          { canWhiteboard: true },
          owner.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal((await get(base + '/' + id, student.cookie)).json().canEdit, true);
    assert.equal(
      (await post(base + '/' + id, { revision: 1, state: second }, student.cookie)).json().revision,
      2,
    );
    assert.equal(
      (
        await post(
          '/classrooms/' + room.id + '/user-permissions/' + student.id,
          { canWhiteboard: false },
          owner.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await post(base + '/' + id, { revision: 2, state: first }, student.cookie)).statusCode,
      403,
    );
    const persisted = (await get(base + '/' + id, owner.cookie)).json();
    assert.equal(persisted.state_base64, second);
    assert.equal(persisted.revision, 2);
    assert.equal(
      (
        await post(
          '/classrooms/' + other.id + '/geogebra/' + id,
          { revision: 2, state: first },
          owner.cookie,
        )
      ).statusCode,
      404,
    );
  } finally {
    await app.close();
    await cleanup();
  }
});
