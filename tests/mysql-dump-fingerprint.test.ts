import { test } from 'node:test';
import assert from 'node:assert/strict';

test('recovery fingerprint accepts redundant8.4 charset spelling but preserves schema/data changes', async () => {
  const { mysqlDumpFingerprint } = await import(
    new URL('../scripts/mysql-dump-fingerprint.mjs', import.meta.url).href
  );
  const source =
    "CREATE TABLE `users` (\n  `name` varchar(120) COLLATE utf8mb4_0900_as_cs NOT NULL,\n  `note` varchar(200) DEFAULT ' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs',\n  UNIQUE KEY `email` (`name`)\n) ENGINE=InnoDB;\nINSERT INTO `users` VALUES ('فارسی 😀',' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs');\n";
  const restored = source.replace(
    'varchar(120) COLLATE',
    'varchar(120) CHARACTER SET utf8mb4 COLLATE',
  );
  const fingerprint = async (value: string) => {
    const bytes = Buffer.from(value);
    return mysqlDumpFingerprint(
      (async function* () {
        for (let i = 0; i < bytes.length; i++) yield bytes.subarray(i, i + 1);
      })(),
    );
  };
  const expected = await fingerprint(source);
  assert.equal(await fingerprint(restored), expected);
  for (const changed of [
    restored.replace('as_cs NOT NULL', 'ai_ci NOT NULL'),
    restored.replace('UNIQUE KEY', 'KEY'),
    restored.replace('varchar(120)', 'varchar(121)'),
    restored.replace('فارسی', 'تغییر'),
    restored.replace("DEFAULT ' CHARACTER", "DEFAULT 'CHANGED CHARACTER"),
    restored.replace("VALUES ('فارسی 😀',' CHARACTER", "VALUES ('فارسی 😀','CHANGED CHARACTER"),
  ])
    assert.notEqual(await fingerprint(changed), expected);
});
