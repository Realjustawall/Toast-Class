import { securityEvent } from '../apps/api/src/db.js';
import 'dotenv/config';
import { databaseFromEnvironment } from '../apps/api/src/database.js';
import { z } from 'zod';
const email = z
  .email()
  .transform((v) => v.toLowerCase())
  .parse(process.argv[2]);
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = await databaseFromEnvironment();
try {
  const u = (await pool.query('SELECT id FROM users WHERE email=$1', [email])).rows[0];
  if (!u) throw new Error('Account not found; register the intended administrator first');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [u.id]);
    if (!(await c.query('SELECT user_id FROM platform_admins WHERE user_id=$1', [u.id])).rowCount) {
      await c.query('INSERT INTO platform_admins(user_id) VALUES($1)', [u.id]);
      await securityEvent(c, u.id, 'platform_admin.granted');
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  console.log('Platform administration granted to the selected account. Sign in again or refresh.');
} finally {
  await pool.end();
}
