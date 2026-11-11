import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { createMySqlPool, mysqlRows, mysqlMutation } from '../apps/api/src/mysql.js';

export async function migrateMySql(
  pool: Pool,
  directory = new URL('../packages/database/mysql/', import.meta.url),
) {
  const c = await pool.getConnection();
  let lock: string | undefined;
  try {
    const database = (
      await mysqlRows<(RowDataPacket & { name: string })[]>(c, 'SELECT DATABASE() AS name')
    )[0].name;
    lock = 'toaster-migrate-' + createHash('sha256').update(database).digest('hex').slice(0, 40);
    const acquired = (
      await mysqlRows<(RowDataPacket & { acquired: number })[]>(
        c,
        'SELECT GET_LOCK(?,30) AS acquired',
        [lock],
      )
    )[0].acquired;
    if (Number(acquired) !== 1) throw new Error('MySQL migration lock unavailable');
    await c.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version VARCHAR(190) PRIMARY KEY,checksum CHAR(64) CHARACTER SET ascii NOT NULL,status ENUM('applying','complete','failed') NOT NULL,applied_at TIMESTAMP(3) NULL) ENGINE=InnoDB",
    );
    for (const name of (await readdir(directory))
      .filter((v) => /^\d+_[a-z_]+\.sql$/.test(v))
      .sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8'),
        checksum = createHash('sha256').update(sql).digest('hex'),
        version = name.slice(0, -4);
      const old = await mysqlRows<(RowDataPacket & { checksum: string; status: string })[]>(
        c,
        'SELECT checksum,status FROM schema_migrations WHERE version=?',
        [version],
      );
      if (old.length) {
        if (old[0].checksum !== checksum)
          throw new Error('MySQL migration checksum changed: ' + version);
        if (old[0].status !== 'complete')
          throw new Error('MySQL migration requires operator repair: ' + version);
        continue;
      }
      await mysqlMutation(
        c,
        "INSERT INTO schema_migrations(version,checksum,status) VALUES(?,?,'applying')",
        [version, checksum],
      );
      try {
        // DDL commits implicitly. Incomplete state must require operator repair.
        for (const statement of sql
          .split(/\r?\n-- statement\s*\r?\n/)
          .map((v) => v.trim())
          .filter(Boolean))
          await c.query(statement);
        await mysqlMutation(
          c,
          "UPDATE schema_migrations SET status='complete',applied_at=CURRENT_TIMESTAMP(3) WHERE version=?",
          [version],
        );
      } catch (error) {
        await mysqlMutation(c, "UPDATE schema_migrations SET status='failed' WHERE version=?", [
          version,
        ]);
        throw error;
      }
    }
  } finally {
    if (lock) await c.execute('SELECT RELEASE_LOCK(?)', [lock]).catch(() => {});
    c.release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.MYSQL_DATABASE_URL) throw new Error('MYSQL_DATABASE_URL is required');
  const pool = createMySqlPool(process.env.MYSQL_DATABASE_URL);
  try {
    await migrateMySql(pool);
  } finally {
    await pool.end();
  }
}
