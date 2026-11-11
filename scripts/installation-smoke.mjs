import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    origin: { type: 'string' },
    report: { type: 'string' },
    'allow-test-data': { type: 'boolean' },
    'check-board-history': { type: 'boolean' },
  },
});
if (!values['allow-test-data'])
  throw new Error(
    'This verification creates real test accounts/classroom/files. Use only a dedicated installation with --allow-test-data.',
  );
const origin = new URL(values.origin).origin;
assert.equal(
  new URL(origin).protocol,
  'https:',
  'Installation verification requires trusted HTTPS',
);
const accounts = [],
  suffix = randomUUID();
async function request(path, payload, cookie = '', status = 200, extraHeaders = {}) {
  const response = await fetch(origin + '/api/v1' + path, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(payload && !(payload instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body:
      payload === undefined
        ? undefined
        : payload instanceof FormData
          ? payload
          : JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(
    response.status,
    status,
    path + ': ' + (response.status === status ? '' : await response.text()),
  );
  return response;
}
for (const name of ['Teacher', 'Learner']) {
  const credentials = {
    email: name.toLowerCase() + '-' + suffix + '@installation.test',
    password: randomBytes(24).toString('hex'),
  };
  await request('/auth/register', { ...credentials, name: 'Installation ' + name }, '', 201);
  const login = await request('/auth/login', credentials);
  const header = login.headers.get('set-cookie');
  assert.match(header, /HttpOnly/i);
  assert.match(header, /Secure/i);
  assert.match(header, /SameSite=Strict/i);
  accounts.push({ email: credentials.email, cookie: header.split(';')[0] });
}
const [teacher, learner] = accounts;
const post = async (path, data, status = 200) =>
  (await request(path, data, teacher.cookie, status)).json();
const org = await post('/organizations', { name: 'Installation verification' }, 201);
const room = await post(
  '/organizations/' + org.id + '/classrooms',
  { name: 'Verified local services' },
  201,
);
const base = '/classrooms/' + room.id;
await request(base + '/teaching', undefined, learner.cookie, 403);
await post('/organizations/' + org.id + '/members', { email: learner.email, role: 'student' }, 201);
const upload = async (name, text) => {
  const bytes = Buffer.from(text),
    form = new FormData();
  form.append('file', new Blob([bytes]), name);
  return (
    await request(base + '/files', form, teacher.cookie, 201, {
      'x-toaster-file-size': String(bytes.length),
    })
  ).json();
};
const clean = await upload(
  'Lesson.txt',
  'TOASTER offline installation\nA real scanned and converted lesson.\n',
);
assert.equal(clean.status, 'ready', 'Clean file must pass the deployed scanner');
const infected = await upload(
  'Scanner-test.txt',
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
);
assert.equal(infected.scanStatus, 'infected', 'Official antivirus test content must be detected');
assert.ok(
  ['deleting', 'rejected'].includes(infected.status),
  'Infected bytes must enter protected cleanup',
);
const denied = await fetch(origin + '/api/v1' + base + '/files/' + infected.id + '/content', {
  headers: { cookie: teacher.cookie },
});
assert.ok(
  [404, 409, 410, 423].includes(denied.status),
  'Quarantined bytes must not be downloadable',
);
const queued = await post(base + '/presentations', { fileId: clean.id }, 202);
let job;
for (let attempt = 0; attempt < 90; attempt++) {
  job = await (
    await request(base + '/presentations/' + queued.id, undefined, teacher.cookie)
  ).json();
  if (job.status === 'ready' || job.status === 'failed') break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
assert.equal(
  job.status,
  'ready',
  'Separate worker/converter/scanner pipeline: ' + (job.failureCode ?? job.status),
);
assert.ok(job.assets.length > 0);
const page = job.assets.find((asset) => asset.page > 0);
assert.ok(page, 'At least one raster page must be published');
const asset = base + '/files/' + page.fileId + '/content';
const download = Buffer.from(await (await request(asset, undefined, learner.cookie)).arrayBuffer());
assert.equal(download.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
assert.ok(download.length > 1000);
await request(asset, undefined, '', 401);
if (values['check-board-history']) {
  const board = await post(
    base + '/documents',
    { kind: 'board', boardFormat: 'excalidraw', name: 'تاریخچهٔ آزمون آفلاین' },
    201,
  );
  const boardBase = base + '/documents/' + board.id + '/board';
  const initial = await (await request(boardBase, undefined, teacher.cookie)).json();
  const versionBody = {
    id: randomUUID(),
    label: 'نسخهٔ اولیه',
    expectedGeneration: initial.generation,
    expectedRevision: initial.revision,
  };
  await post(boardBase + '/versions', versionBody);
  await request(boardBase + '/versions', undefined, learner.cookie, 403);
  await request(boardBase + '/versions/' + versionBody.id, undefined, learner.cookie, 403);
  const restoreBody = {
    id: randomUUID(),
    expectedGeneration: initial.generation,
    expectedRevision: initial.revision,
  };
  const restored = await post(boardBase + '/versions/' + versionBody.id + '/restore', restoreBody);
  assert.notEqual(restored.generation, initial.generation);
  assert.equal(restored.revision, initial.revision + 1);
  assert.deepEqual(
    await post(boardBase + '/versions/' + versionBody.id + '/restore', restoreBody),
    restored,
  );
  const list = await (await request(boardBase + '/versions', undefined, teacher.cookie)).json();
  assert.equal(list.length, 2);
  assert.ok(list.some((version) => version.kind === 'before_restore'));
}
const report = {
  testedAt: new Date().toISOString(),
  origin,
  organizationId: org.id,
  classroomId: room.id,
  trustedHttps: true,
  secureSession: true,
  tenantDenial: true,
  cleanScan: true,
  eicarBlocked: true,
  isolatedConversion: true,
  privatePngBytes: download.length,
  anonymousDenied: true,
  boardHistory: values['check-board-history'] ? 'PASSED' : 'NOT_RUN',
  certification: 'TARGETED_INSTALLATION_SMOKE_ONLY',
};
if (values.report)
  await writeFile(values.report, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
console.log(
  'Installation checks passed: trusted HTTPS, secure sessions, permissions, real ClamAV, isolated conversion and private assets. Test accounts/data remain in the dedicated installation.',
);
