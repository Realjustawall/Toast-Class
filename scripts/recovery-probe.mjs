import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    action: { type: 'string' },
    origin: { type: 'string' },
    fixture: { type: 'string' },
    'allow-test-data': { type: 'boolean' },
  },
});
const origin = new URL(values.origin).origin;
assert.equal(new URL(origin).protocol, 'https:');
async function request(path, data, cookie, status = 200, extra = {}) {
  const response = await fetch(origin + '/api/v1' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(data && !(data instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...extra,
    },
    body: data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, status, path + ' status');
  return response;
}
if (values.action === 'create') {
  if (!values['allow-test-data'])
    throw new Error('Dedicated restore-drill installation only; --allow-test-data required');
  const identity = {
    email: 'recovery-' + randomUUID() + '@installation.test',
    password: randomBytes(24).toString('hex'),
  };
  await request('/auth/register', { ...identity, name: 'Recovery verification فارسی' }, '', 201);
  const login = await request('/auth/login', identity);
  const user = await login.json(),
    cookie = login.headers.get('set-cookie').split(';')[0];
  const post = async (path, data, status = 201) =>
    (await request(path, data, cookie, status)).json();
  const org = await post('/organizations', { name: 'Recovery drill' });
  const room = await post('/organizations/' + org.id + '/classrooms', {
    name: 'Persisted recovery classroom',
  });
  const base = '/classrooms/' + room.id;
  const body = 'A persisted recovery message — یادگیری و بازیابی';
  const message = await post(base + '/messages', { body });
  const bytes = Buffer.from('Original private classroom bytes — آموزش\n' + randomUUID());
  const form = new FormData();
  form.append('file', new Blob([bytes]), 'Recovery.txt');
  const file = await (
    await request(base + '/files', form, cookie, 201, {
      'x-toaster-file-size': String(bytes.length),
    })
  ).json();
  assert.equal(file.status, 'ready');
  const fixture = {
    userId: user.id,
    cookie,
    base,
    file: base + '/files/' + file.id + '/content',
    hash: createHash('sha256').update(bytes).digest('hex'),
    messageId: message.id,
    message: body,
  };
  await writeFile(values.fixture, JSON.stringify(fixture) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(
    'Private recovery probe created using real registration/chat/scanned-file APIs. Fixture contains a test session cookie; protect it and exclude it from distribution.',
  );
} else if (values.action !== 'verify') throw new Error('Expected create or verify');
const fixture = JSON.parse(await readFile(values.fixture, 'utf8'));
assert.match(fixture.base, /^\/classrooms\/[a-f0-9-]{36}$/);
assert.match(fixture.file, /^\/classrooms\/[a-f0-9-]{36}\/files\/[a-f0-9-]{36}\/content$/);
const me = await (await request('/me', undefined, fixture.cookie)).json();
assert.equal(me.id, fixture.userId, 'Original authenticated session must survive recovery');
const messages = await (
  await request(fixture.base + '/messages', undefined, fixture.cookie)
).json();
assert.ok(
  messages.some((value) => value.id === fixture.messageId && value.body === fixture.message),
);
const file = Buffer.from(
  await (await request(fixture.file, undefined, fixture.cookie)).arrayBuffer(),
);
assert.equal(createHash('sha256').update(file).digest('hex'), fixture.hash);
await request(fixture.file, undefined, '', 401);
console.log(
  'Recovery probe passed: original authenticated session, Persian message, exact private file bytes and anonymous denial.',
);
