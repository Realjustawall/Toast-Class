import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { testDatabase } from './database';
import { createMySqlPool } from '../apps/api/src/mysql';
import { MySqlDatabase } from '../apps/api/src/database';
import { buildApp } from '../apps/api/src/app';

test(
  'native application works with data-only grants and cannot administer MySQL',
  {
    skip: process.env.TEST_DATABASE_ENGINE !== 'mysql',
  },
  async () => {
    const { pool, cleanup, workerDatabaseUrl } = await testDatabase();
    const url = new URL(workerDatabaseUrl!);
    const database = url.pathname.slice(1),
      username = 'toaster_' + randomBytes(8).toString('hex');
    assert.match(database, /^toaster_[a-f0-9]{32}_test$/);
    assert.match(username, /^toaster_[a-f0-9]{16}$/);
    const otherDatabase = database.replaceAll('_', 'x');
    assert.match(otherDatabase, /^toasterx[a-f0-9]{32}xtest$/);
    const admin = createMySqlPool(process.env.TEST_MYSQL_ADMIN_URL!);
    const password = randomBytes(32).toString('hex');
    url.username = username;
    url.password = password;
    const application = new MySqlDatabase(url.href);
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await admin.query('CREATE DATABASE `' + otherDatabase + '`');
      await admin.query('CREATE TABLE `' + otherDatabase + '`.private_probe(id INT)');
      await admin.query("CREATE USER '" + username + "'@'%' IDENTIFIED BY ?", [password]);
      await admin.query(
        'GRANT SELECT,INSERT,UPDATE,DELETE ON `' +
          database.replaceAll('_', '\\_') +
          "`.* TO '" +
          username +
          "'@'%'",
      );
      assert.equal(
        (await application.query('SELECT CURRENT_USER() AS name')).rows[0].name,
        username + '@%',
      );
      app = await buildApp(application, {
        origin: 'http://localhost:5173',
        production: false,
        mediaUrl: '',
        mediaKey: '',
        mediaSecret: '',
      });
      const post = (path: string, payload: unknown, cookie = '') =>
        app!.inject({
          method: 'POST',
          url: '/api/v1' + path,
          headers: { origin: 'http://localhost:5173', cookie, 'content-type': 'application/json' },
          payload: JSON.stringify(payload),
        });
      assert.equal(
        (
          await post('/auth/register', {
            name: 'Restricted runtime',
            email: 'least-privilege@example.org',
            password: 'abc123',
          })
        ).statusCode,
        201,
      );
      const login = await post('/auth/login', {
        email: 'least-privilege@example.org',
        password: 'abc123',
      });
      assert.equal(login.statusCode, 200);
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const organization = await post(
        '/organizations',
        { name: 'Restricted organization' },
        cookie,
      );
      assert.equal(organization.statusCode, 201);
      const room = await post(
        '/organizations/' + organization.json().id + '/classrooms',
        { enrollmentMode: 'organization', name: 'Restricted classroom' },
        cookie,
      );
      assert.equal(room.statusCode, 201);
      for (const sql of [
        'CREATE TABLE privilege_escape(id INT)',
        'DROP TABLE users',
        'SELECT user,authentication_string FROM mysql.user',
        'SELECT * FROM `' + otherDatabase + '`.private_probe',
      ]) {
        await assert.rejects(application.query(sql), (error: unknown) =>
          [
            'ER_TABLEACCESS_DENIED_ERROR',
            'ER_DBACCESS_DENIED_ERROR',
            'ER_SPECIFIC_ACCESS_DENIED_ERROR',
          ].includes((error as { code: string }).code),
        );
      }
      assert.equal(
        Number((await pool.query('SELECT COUNT(*) AS count FROM users')).rows[0].count),
        1,
      );
      assert.equal(
        Number((await pool.query('SELECT COUNT(*) AS count FROM classrooms')).rows[0].count),
        1,
      );
    } finally {
      await app?.close();
      await application.end();
      await admin.query("DROP USER IF EXISTS '" + username + "'@'%'");
      await admin.query('DROP DATABASE IF EXISTS `' + otherDatabase + '`');
      await admin.end();
      await cleanup();
    }
  },
);
