import pg from 'pg';
import { newDb, DataType } from 'pg-mem';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { migrate } from '../scripts/migrate';
import { MySqlDatabase, type DatabasePool } from '../apps/api/src/database';
import { createMySqlPool } from '../apps/api/src/mysql';
import { migrateMySql } from '../scripts/migrate-mysql';
export const hasRealDatabase =
  Boolean(process.env.TEST_DATABASE_URL) || process.env.TEST_DATABASE_ENGINE === 'mysql';
export async function testDatabase(): Promise<{
  pool: DatabasePool;
  workerDatabaseUrl?: string;
  cleanup: () => Promise<void>;
}> {
  if (process.env.TEST_DATABASE_ENGINE === 'mysql') {
    if (!process.env.TEST_MYSQL_ADMIN_URL) throw new Error('TEST_MYSQL_ADMIN_URL is required');
    const url = new URL(process.env.TEST_MYSQL_ADMIN_URL);
    if (url.protocol !== 'mysql:' || !url.pathname.endsWith('_test'))
      throw new Error('Use a dedicated MySQL test admin database ending in _test');
    const admin = createMySqlPool(url.href),
      database = 'toaster_' + randomUUID().replaceAll('-', '') + '_test';
    if (!/^toaster_[a-f0-9]{32}_test$/.test(database))
      throw new Error('Invalid generated test database');
    await admin.query(
      'CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs',
    );
    url.pathname = '/' + database;
    const pool = new MySqlDatabase(url.href);
    try {
      await migrateMySql(pool.native);
    } catch (error) {
      await pool.end();
      await admin.query('DROP DATABASE `' + database + '`');
      await admin.end();
      throw error;
    }
    return {
      pool,
      workerDatabaseUrl: url.href,
      cleanup: async () => {
        await pool.end();
        await admin.query('DROP DATABASE `' + database + '`');
        await admin.end();
      },
    };
  }
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    if (!new URL(url).pathname.endsWith('_test'))
      throw new Error('TEST_DATABASE_URL must use a dedicated database ending in _test');
    const admin = new pg.Pool({ connectionString: url });
    const schema = 'test_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    try {
      await migrate(pool);
    } catch (e) {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      throw e;
    }
    const workerUrl = new URL(url);
    workerUrl.searchParams.set('options', '-c search_path=' + schema);
    return {
      pool,
      workerDatabaseUrl: workerUrl.href,
      cleanup: async () => {
        await pool.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      },
    };
  }
  const db = newDb();
  // pg-mem parses this precision form as a function; real PostgreSQL has it built in.
  db.public.registerFunction({
    name: 'current_timestamp',
    args: [DataType.integer],
    returns: DataType.timestamptz,
    implementation: () => new Date(),
    impure: true,
  });
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: randomUUID,
    impure: true,
  });
  db.public.registerFunction({
    name: 'length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (value: string) => [...value].length,
  });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool() as unknown as pg.Pool;
  for (const name of (await readdir(new URL('../packages/database/migrations/', import.meta.url)))
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    const sql = await readFile(
      new URL('../packages/database/migrations/' + name, import.meta.url),
      'utf8',
    );
    // pg-mem rejects NULL IN (...) in a CHECK, while PostgreSQL accepts UNKNOWN.
    // Spell out the equivalent nullable condition only for this test adapter.
    await pool.query(
      sql
        .replace(
          "DEFAULT 'resource' CHECK(purpose IN",
          "DEFAULT 'resource' CONSTRAINT files_purpose_check CHECK(purpose IN",
        )
        .replace(
          /CHECK\(delete_reason IN \(([^)]+)\)\)/g,
          'CHECK(delete_reason IS NULL OR delete_reason IN ($1))',
        ),
    );
  }
  return { pool, cleanup: () => pool.end() };
}
