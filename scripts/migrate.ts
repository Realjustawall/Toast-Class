import 'dotenv/config';
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMySqlPool } from '../apps/api/src/mysql.js';
import { migrateMySql } from './migrate-mysql.js';
export async function migrate(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(731091)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const file of (await readdir(new URL('../packages/database/migrations/', import.meta.url)))
      .filter((v) => /^\d+_[a-z_]+\.sql$/.test(v))
      .sort()) {
      const version = file.replace('.sql', '');
      if (
        !(await client.query('SELECT version FROM schema_migrations WHERE version=$1', [version]))
          .rowCount
      ) {
        await client.query(
          await readFile(
            new URL('../packages/database/migrations/' + file, import.meta.url),
            'utf8',
          ),
        );
        await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [version]);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const url = process.env.DATABASE_URL;
  if (new URL(url).protocol === 'mysql:') {
    const ca = process.env.DATABASE_CA_FILE
      ? await readFile(process.env.DATABASE_CA_FILE, 'utf8')
      : undefined;
    const pool = createMySqlPool(url, ca);
    try {
      await migrateMySql(pool);
    } finally {
      await pool.end();
    }
  } else {
    const pool = new pg.Pool({ connectionString: url });
    try {
      await migrate(pool);
    } finally {
      await pool.end();
    }
  }
}
