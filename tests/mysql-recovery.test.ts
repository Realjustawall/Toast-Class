import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { testDatabase } from './database';
import { MySqlDatabase } from '../apps/api/src/database';
import { createMySqlPool } from '../apps/api/src/mysql';
import * as Y from 'yjs';

test(
  'MySQL dump restores schema, Unicode, binary CRDT data, constraints and every table',
  {
    skip:
      process.env.TEST_DATABASE_ENGINE !== 'mysql' ||
      process.env.TEST_MYSQL_RECOVERY_DOCKER !== 'true',
    timeout: 120_000,
  },
  async () => {
    const { pool, cleanup, workerDatabaseUrl } = await testDatabase();
    const source = new URL(workerDatabaseUrl!);
    const restoredName = 'toaster_' + randomUUID().replaceAll('-', '') + '_test';
    assert.match(restoredName, /^toaster_[a-f0-9]{32}_test$/);
    const admin = createMySqlPool(process.env.TEST_MYSQL_ADMIN_URL!);
    const targetUrl = new URL(source);
    targetUrl.pathname = '/' + restoredName;
    const target = new MySqlDatabase(targetUrl.href);
    const directory = await mkdtemp(join(tmpdir(), 'toaster-recovery-'));
    const configuration = join(directory, 'client.cnf');
    const quoted = (value: string) =>
      '"' +
      value
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
        .replaceAll('\n', '\\n')
        .replaceAll('\r', '\\r') +
      '"';
    const image =
      process.env.TEST_MYSQL_CLIENT_IMAGE ??
      'mysql:8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902';
    const client = (command: string, args: string[], input?: Buffer) => {
      const result = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--pull=never',
          '--network=host',
          '--read-only',
          '-i',
          '--mount',
          `type=bind,source=${configuration},target=/run/client.cnf,readonly`,
          image,
          command,
          '--defaults-extra-file=/run/client.cnf',
          ...args,
        ],
        { input, maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr.toString());
      return result.stdout;
    };
    try {
      await writeFile(
        configuration,
        `[client]\nprotocol=TCP\nhost=${quoted(source.hostname)}\nport=${source.port || 3306}\nuser=${quoted(decodeURIComponent(source.username))}\npassword=${quoted(decodeURIComponent(source.password))}\ndefault-character-set=utf8mb4\n`,
        { mode: 0o600 },
      );
      const user = randomUUID(),
        organization = randomUUID(),
        room = randomUUID();
      const text = "Recovery '); DROP TABLE users;-- فارسی 😀";
      await pool.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [
        user,
        'recovery@example.org',
        text,
        'test-only-not-login',
      ]);
      await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [organization, text]);
      await pool.query('INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3)', [
        organization,
        user,
        'owner',
      ]);
      await pool.query(
        'INSERT INTO classrooms(id,organization_id,name,created_by) VALUES($1,$2,$3,$4)',
        [room, organization, text, user],
      );
      await pool.query('INSERT INTO messages(id,classroom_id,user_id,body) VALUES($1,$2,$3,$4)', [
        randomUUID(),
        room,
        user,
        text,
      ]);
      const document = randomUUID(),
        ydoc = new Y.Doc();
      ydoc.getText('content').insert(0, text);
      await pool.query(
        'INSERT INTO collaborative_documents(id,classroom_id,kind,name,created_by) VALUES($1,$2,$3,$4,$5)',
        [document, room, 'notes', 'Recovery notes', user],
      );
      await pool.query(
        'INSERT INTO document_updates(id,document_id,author_id,update_base64) VALUES($1,$2,$3,$4)',
        [randomUUID(), document, user, Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64')],
      );
      ydoc.destroy();
      const boardId = randomUUID(),
        generation = randomUUID(),
        versionId = randomUUID();
      const boardState = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString('base64');
      const digest = createHash('sha256').update(Buffer.from(boardState, 'base64')).digest('hex');
      await pool.query(
        'INSERT INTO collaborative_documents(id,classroom_id,kind,name,created_by,board_format) VALUES($1,$2,$3,$4,$5,$6)',
        [boardId, room, 'board', text, user, 'excalidraw'],
      );
      await pool.query(
        'INSERT INTO board_states(document_id,generation,revision,state_base64) VALUES($1,$2,$3,$4)',
        [boardId, generation, 1, boardState],
      );
      await pool.query(
        'INSERT INTO board_versions(id,document_id,generation,revision,label,kind,state_base64,digest,author_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [versionId, boardId, generation, 0, text, 'manual', boardState, digest, user],
      );
      await pool.query(
        'INSERT INTO board_restore_operations(document_id,operation_id,digest,generation,revision,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
        [boardId, randomUUID(), digest, generation, 1, user],
      );
      await pool.query(
        'INSERT INTO board_presenter_views(document_id,generation,revision,active,center_x,center_y,zoom,actor_id,operation_id,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [boardId, generation, 1, true, -123.5, 456.75, 1.5, user, randomUUID(), digest],
      );
      await pool.query(
        'INSERT INTO audit_logs(id,actor_id,organization_id,action,resource_id,details) VALUES($1,$2,$3,$4,$5,$6)',
        [
          randomUUID(),
          user,
          organization,
          'recovery.fixture',
          room,
          { nested: { text, count: 17 }, items: [true, null, text] },
        ],
      );
      await pool.query(
        'UPDATE platform_settings SET registration_open=false,revision=7 WHERE id=1',
      );
      const tables = (
        await pool.query(
          "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' ORDER BY table_name",
        )
      ).rows.map((v) => String(v.name));
      const snapshot = async (db: typeof pool) => {
        const result: Record<string, string> = {};
        for (const table of tables) {
          assert.match(table, /^\w+$/);
          const rows = (await db.query('SELECT * FROM `' + table + '`')).rows;
          const normalize = (value: unknown): unknown => {
            if (value instanceof Date) return value.toISOString();
            if (Buffer.isBuffer(value)) return value.toString('base64');
            if (Array.isArray(value)) return value.map(normalize);
            if (value !== null && typeof value === 'object')
              return Object.fromEntries(
                Object.entries(value)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([key, entry]) => [key, normalize(entry)]),
              );
            return value;
          };
          const canonical = rows.map((v) => JSON.stringify(normalize(v))).sort();
          result[table] = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
        }
        return result;
      };
      const before = await snapshot(pool);
      const dump = client('mysqldump', [
        '--single-transaction',
        '--no-tablespaces',
        '--set-gtid-purged=OFF',
        '--hex-blob',
        '--column-statistics=0',
        '--routines',
        '--events',
        source.pathname.slice(1),
      ]);
      assert.ok(dump.length > 10_000);
      await admin.query(
        'CREATE DATABASE `' + restoredName + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs',
      );
      client('mysql', [restoredName], dump);
      assert.deepEqual(await snapshot(target), before);
      assert.equal(
        (await target.query('SELECT label FROM board_versions WHERE id=$1', [versionId])).rows[0]
          .label,
        text,
      );
      const restoredTables = (
        await target.query(
          "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' ORDER BY table_name",
        )
      ).rows.map((v) => String(v.name));
      assert.deepEqual(restoredTables, tables);
      await assert.rejects(
        target.query('INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3)', [
          organization,
          randomUUID(),
          'owner',
        ]),
        /foreign key/i,
      );
      assert.equal(
        (await target.query('SELECT id FROM users WHERE email=$1', ["' OR 1=1--"])).rows.length,
        0,
      );
    } finally {
      await target.end();
      await admin.query('DROP DATABASE IF EXISTS `' + restoredName + '`');
      await admin.end();
      await cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
