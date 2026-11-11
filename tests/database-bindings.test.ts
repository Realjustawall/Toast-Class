import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mysqlBindings } from '../apps/api/src/database';

test('MySQL binding compilation preserves SQL literals and sends reordered values separately', () => {
  const attack = "x'); DROP TABLE users;--";
  const compiled = mysqlBindings("SELECT '$1' AS literal, $2, $1, $2 /* $99 */ -- $88\n", [
    attack,
    6,
  ]);
  assert.equal(compiled.sql, "SELECT '$1' AS literal, ?, ?, ? /* $99 */ -- $88\n");
  assert.deepEqual(compiled.parameters, [6, attack, 6]);
  assert.ok(!compiled.sql.includes(attack));
  assert.throws(() => mysqlBindings('SELECT $2', [1]), /Missing SQL binding/);
  assert.throws(() => mysqlBindings('SELECT 1', [1]), /Unused SQL binding/);
  assert.throws(() => mysqlBindings("SELECT '$1", []), /Unterminated/);
  assert.throws(() => mysqlBindings('SELECT 1 /*', []), /Unterminated/);
});
