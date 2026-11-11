import { randomBytes, randomUUID, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { databaseFromEnvironment, type DatabasePool } from '../apps/api/src/database.js';
import { securityEvent } from '../apps/api/src/db.js';
import { readPlatformOptions } from '../apps/api/src/platform-options.js';
const scrypt = promisify(scryptCallback);

export async function bootstrapAdministrator(
  pool: DatabasePool,
  emailInput: string,
  password: string,
) {
  const email = z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase())
    .parse(emailInput);
  z.string()
    .min(6)
    .max(128)
    .regex(/^[^\r\n\0]+$/)
    .parse(password);
  if (pool.dialect !== 'mysql') throw new Error('Initial production setup requires MySQL');
  const c = await pool.connect();
  let locked = false;
  try {
    locked =
      Number(
        (await c.query("SELECT GET_LOCK('toaster_initial_admin',30) AS acquired")).rows[0]
          ?.acquired,
      ) === 1;
    if (!locked) throw new Error('Another initial setup is running');
    await c.query('BEGIN');
    if ((await c.query('SELECT user_id FROM platform_admins LIMIT 1')).rowCount) {
      await c.query('COMMIT');
      return { created: false };
    }
    if ((await c.query('SELECT id FROM users WHERE email=$1', [email])).rowCount)
      throw new Error(
        'Initial administrator email already belongs to an account; use the audited admin:grant command',
      );
    const salt = randomBytes(16).toString('hex'),
      hash = salt + ':' + ((await scrypt(password, salt, 64)) as Buffer).toString('hex'),
      id = randomUUID();
    await c.query(
      'INSERT INTO users(id,email,name,password_hash,locale,timezone) VALUES($1,$2,$3,$4,$5,$6)',
      [id, email, 'Administrator', hash, 'en', 'UTC'],
    );
    await c.query('INSERT INTO platform_admins(user_id) VALUES($1)', [id]);
    const options = await readPlatformOptions(c);
    await c.query(
      'UPDATE platform_settings SET options_json=$1,registration_open=false,revision=revision+1 WHERE id=1',
      [JSON.stringify({ ...options, defaultLanguage: 'en' })],
    );
    await securityEvent(c, id, 'platform_admin.bootstrapped');
    await c.query('COMMIT');
    return { created: true };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (locked) await c.query("SELECT RELEASE_LOCK('toaster_initial_admin')").catch(() => {});
    c.release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const passwordFile = process.env.ADMIN_PASSWORD_FILE;
  if (!passwordFile || !process.env.ADMIN_EMAIL)
    throw new Error('Administrator email and mounted password file are required');
  const password = (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, ''),
    pool = await databaseFromEnvironment();
  try {
    const result = await bootstrapAdministrator(pool, process.env.ADMIN_EMAIL, password);
    console.log(
      result.created
        ? 'Initial administrator created; public registration is closed.'
        : 'Administrator already configured; credentials were not changed.',
    );
  } finally {
    await pool.end();
  }
}
