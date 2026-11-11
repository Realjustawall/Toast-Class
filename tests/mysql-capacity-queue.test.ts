import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './database';

test(
  'native MySQL admits an 800-user burst with ten busy connections and drains every read',
  {
    skip: process.env.TEST_DATABASE_ENGINE !== 'mysql',
    timeout: 30000,
  },
  async () => {
    const { pool, cleanup } = await testDatabase();
    const held = await Promise.all(Array.from({ length: 10 }, () => pool.connect()));
    try {
      // Reproduce authorization bursts while all ten connections are occupied.
      // Attach rejection handling immediately so the former 100-item queue fails
      // as an assertion, without an unhandled rejection or a leaked connection.
      const pending = Promise.allSettled(
        Array.from({ length: 800 }, (_, n) => pool.query('SELECT $1 AS participant', [n])),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (const connection of held.splice(0)) connection.release();
      const results = await pending;
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 800);
      for (const [n, result] of results.entries()) {
        assert.equal(result.status, 'fulfilled');
        if (result.status === 'fulfilled')
          assert.equal(Number(result.value.rows[0].participant), n);
      }
    } finally {
      for (const connection of held) connection.release();
      await cleanup();
    }
  },
);
