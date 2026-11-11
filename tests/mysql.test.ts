import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RowDataPacket } from 'mysql2/promise';
import { createMySqlPool, mysqlRows, mysqlMutation, mysqlTransaction } from '../apps/api/src/mysql';
import { migrateMySql } from '../scripts/migrate-mysql';

test(
  'native MySQL 8.4 migration, prepared injection boundary, Unicode and rollback',
  { skip: !process.env.TEST_MYSQL_ADMIN_URL },
  async () => {
    const url = new URL(process.env.TEST_MYSQL_ADMIN_URL!);
    if (url.protocol !== 'mysql:' || !url.pathname.endsWith('_test'))
      throw new Error('Use a dedicated MySQL test administration database ending in _test');
    const admin = createMySqlPool(url.href),
      name = 'toaster_' + randomUUID().replaceAll('-', '') + '_test';
    if (!/^toaster_[a-f0-9]{32}_test$/.test(name))
      throw new Error('Invalid isolated test database');
    await admin.query(
      'CREATE DATABASE `' + name + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs',
    );
    url.pathname = '/' + name;
    const pool = createMySqlPool(url.href);
    const directory = await mkdtemp(join(tmpdir(), 'toaster-mysql-migrations-'));
    try {
      const version = (
        await mysqlRows<(RowDataPacket & { version: string })[]>(
          pool,
          'SELECT VERSION() AS version',
        )
      )[0].version;
      assert.match(version, /^8\.4\./);
      // Independent connections must serialize DDL against the same database.
      await Promise.all([migrateMySql(pool), migrateMySql(pool)]);
      const versions = await mysqlRows<(RowDataPacket & { status: string })[]>(
        pool,
        'SELECT status FROM schema_migrations',
      );
      assert.equal(versions.length, 23);
      assert.ok(versions.every((v) => v.status === 'complete'));
      const id = randomUUID(),
        attack = "x'); DROP TABLE users;-- فارسی 😀";
      await mysqlMutation(pool, 'INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)', [
        id,
        'mysql@example.org',
        attack,
        'test-only-non-login-hash',
      ]);
      const rows = await mysqlRows<(RowDataPacket & { name: string })[]>(
        pool,
        'SELECT name FROM users WHERE id=?',
        [id],
      );
      assert.equal(rows[0].name, attack);
      assert.equal(
        (
          await mysqlRows(pool, 'SELECT id FROM users WHERE email=?', [
            "mysql@example.org' OR '1'='1",
          ])
        ).length,
        0,
      );
      await assert.rejects(
        mysqlRows(pool, 'SELECT id FROM users; DROP TABLE users'),
        /syntax|prepare|parse/i,
      );
      await assert.rejects(
        mysqlTransaction(pool, async (c) => {
          await mysqlMutation(c, 'INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)', [
            randomUUID(),
            'rollback@example.org',
            'Rollback',
            'test-only',
          ]);
          throw new Error('rollback sentinel');
        }),
        /rollback sentinel/,
      );
      assert.equal(
        (await mysqlRows(pool, 'SELECT id FROM users WHERE email=?', ['rollback@example.org']))
          .length,
        0,
      );
      await assert.rejects(
        mysqlMutation(
          pool,
          'INSERT INTO auth_sessions(id,token_hash,user_id,expires_at) VALUES(?,?,?,?)',
          [randomUUID(), 'a'.repeat(64), randomUUID(), new Date(Date.now() + 60000)],
        ),
        /foreign key/i,
      );
      const original = await readFile(
        new URL('../packages/database/mysql/001_identity.sql', import.meta.url),
        'utf8',
      );
      await writeFile(join(directory, '001_identity.sql'), original + '\n-- unexpected change\n');
      await assert.rejects(migrateMySql(pool, pathToFileURL(directory + '/')), /checksum changed/);
      await rm(join(directory, '001_identity.sql'));
      await writeFile(
        join(directory, '007_interrupted_test.sql'),
        'CREATE TABLE migration_probe(id INT PRIMARY KEY) ENGINE=InnoDB;\n-- statement\nCREATE TABLE deliberately_invalid (',
      );
      await assert.rejects(migrateMySql(pool, pathToFileURL(directory + '/')), /syntax/i);
      const interrupted = await mysqlRows<(RowDataPacket & { status: string })[]>(
        pool,
        'SELECT status FROM schema_migrations WHERE version=?',
        ['007_interrupted_test'],
      );
      assert.equal(interrupted[0].status, 'failed');
      // The first DDL committed: never pretend the migration rolled back.
      await mysqlRows(pool, 'SELECT id FROM migration_probe');
      await assert.rejects(
        migrateMySql(pool, pathToFileURL(directory + '/')),
        /requires operator repair/,
      );
    } finally {
      await pool.end();
      // This identifier was generated above, validated, and names only this suite's database.
      await admin.query('DROP DATABASE `' + name + '`');
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
