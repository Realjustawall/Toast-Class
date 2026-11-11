import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { loadInstallation } from './installation-maintenance.mjs';
const { values } = parseArgs({ options: { directory: { type: 'string' } } });
const c = await loadInstallation(values.directory),
  base = 'http://127.0.0.1:' + c.env.API_PORT + '/api/v1';
const password = (await readFile(join(c.root, 'installation/admin-password'), 'utf8')).replace(
  /\r?\n$/,
  '',
);
const login = await fetch(base + '/auth/login', {
  method: 'POST',
  headers: { origin: c.metadata.origin, 'content-type': 'application/json' },
  body: JSON.stringify({ email: c.env.ADMIN_EMAIL, password }),
});
assert.equal(login.status, 200);
assert.equal((await login.json()).isPlatformAdmin, true);
const cookies = login.headers.getSetCookie();
assert.ok(cookies.some((value) => value.includes('HttpOnly') && value.includes('Secure')));
const registration = await fetch(base + '/auth/register', {
  method: 'POST',
  headers: { origin: c.metadata.origin, 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'blocked@example.test',
    password: '123456',
    name: 'Registration is closed',
  }),
});
assert.equal(registration.status, 403);
console.log(
  'Installed API: initial administrator authenticates; secure cookies and closed registration verified.',
);
