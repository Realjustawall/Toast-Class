import { command } from './installation-maintenance.mjs';

export async function verifyUniqueKeys(container, credentials) {
  const query = (sql) =>
    command([
      'exec',
      container,
      'mysql',
      '--defaults-extra-file=' + credentials,
      '--batch',
      '--raw',
      '--skip-column-names',
      '--execute',
      sql,
    ]);
  const raw = await query(
    "SELECT JSON_ARRAY(TABLE_NAME,INDEX_NAME,COLUMN_NAME,SUB_PART) FROM information_schema.statistics WHERE table_schema='toaster' AND NON_UNIQUE=0 ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX",
  );
  const groups = new Map();
  for (const line of raw.trim().split('\n').filter(Boolean)) {
    const [table, index, column, prefix] = JSON.parse(line);
    if (
      [table, index, column].some((name) => typeof name !== 'string' || !/^\w+$/.test(name)) ||
      (prefix !== null && (!Number.isSafeInteger(prefix) || prefix < 1))
    )
      throw new Error('Unsupported unique-key metadata');
    const key = table + '.' + index;
    if (!groups.has(key)) groups.set(key, { table, columns: [] });
    groups.get(key).columns.push({ column, prefix });
  }
  if (!groups.size) throw new Error('Expected application unique keys are missing');
  for (const [name, group] of groups) {
    const expressions = group.columns.map(({ column, prefix }) =>
      prefix === null ? '`' + column + '`' : 'LEFT(`' + column + '`,' + prefix + ')',
    );
    const nonNull = group.columns.map(({ column }) => '`' + column + '` IS NOT NULL').join(' AND ');
    if (
      (
        await query(
          'SELECT 1 FROM toaster.`' +
            group.table +
            '` WHERE ' +
            nonNull +
            ' GROUP BY ' +
            expressions.join(',') +
            ' HAVING COUNT(*)>1 LIMIT 1',
        )
      ).trim()
    )
      throw new Error('Unique-key integrity failed: ' + name);
  }
  return groups.size;
}

export async function verifyForeignKeys(container, credentials) {
  const query = (sql) =>
    command([
      'exec',
      container,
      'mysql',
      '--defaults-extra-file=' + credentials,
      '--batch',
      '--raw',
      '--skip-column-names',
      '--execute',
      sql,
    ]);
  const raw = await query(
    "SELECT JSON_ARRAY(CONSTRAINT_NAME,TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME,ORDINAL_POSITION) FROM information_schema.key_column_usage WHERE table_schema='toaster' AND referenced_table_name IS NOT NULL ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION",
  );
  const groups = new Map();
  for (const line of raw.trim().split('\n').filter(Boolean)) {
    const [constraint, table, column, schema, parent, reference, ordinal] = JSON.parse(line);
    if (
      schema !== 'toaster' ||
      [constraint, table, column, parent, reference].some(
        (name) => typeof name !== 'string' || !/^\w+$/.test(name),
      ) ||
      !Number.isInteger(ordinal) ||
      ordinal < 1
    )
      throw new Error('Unsupported foreign-key metadata');
    const key = table + '.' + constraint;
    if (!groups.has(key)) groups.set(key, { table, parent, columns: [] });
    const group = groups.get(key);
    if (group.parent !== parent) throw new Error('Inconsistent foreign-key metadata');
    group.columns.push({ column, reference });
  }
  if (!groups.size) throw new Error('Expected application foreign keys are missing');
  for (const [name, group] of groups) {
    const nonNull = group.columns
      .map((pair) => 'c.`' + pair.column + '` IS NOT NULL')
      .join(' AND ');
    const joined = group.columns
      .map((pair) => 'p.`' + pair.reference + '`=c.`' + pair.column + '`')
      .join(' AND ');
    const orphan = await query(
      'SELECT 1 FROM toaster.`' +
        group.table +
        '` c WHERE ' +
        nonNull +
        ' AND NOT EXISTS(SELECT 1 FROM toaster.`' +
        group.parent +
        '` p WHERE ' +
        joined +
        ') LIMIT 1',
    );
    if (orphan.trim()) throw new Error('Foreign-key integrity failed: ' + name);
  }
  return groups.size;
}
