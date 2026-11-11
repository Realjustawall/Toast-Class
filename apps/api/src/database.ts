import type { QueryResult } from 'pg';
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { createMySqlPool } from './mysql.js';
import { readFile } from 'node:fs/promises';

/** Small application boundary, preserving the existing row/result contract during cutover. */
export interface SqlExecutor {
  readonly dialect?: 'mysql' | 'postgres';
  query(sql: string, values?: unknown[]): Promise<Pick<QueryResult, 'rows' | 'rowCount'>>;
}
export interface DatabaseConnection extends SqlExecutor {
  release(): void;
}
export interface DatabasePool extends SqlExecutor {
  connect(): Promise<DatabaseConnection>;
  end(): Promise<void>;
}
export const sqlDialect = (db: SqlExecutor, postgres: string, mysql: string) =>
  db.dialect === 'mysql' ? mysql : postgres;

/** Compile numbered *bindings* only. SQL dialect differences are explicit at call sites. */
export function mysqlBindings(source: string, values: readonly unknown[] = []) {
  let sql = '',
    quote = '',
    lineComment = false,
    blockComment = false;
  const parameters: unknown[] = [];
  const used = new Set<number>();
  for (let i = 0; i < source.length; i++) {
    const ch = source[i],
      next = source[i + 1];
    if (lineComment) {
      sql += ch;
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      sql += ch;
      if (ch === '*' && next === '/') {
        sql += next;
        i++;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      sql += ch;
      if (ch === quote) {
        if (next === quote) {
          sql += next;
          i++;
        } else quote = '';
      } else if (ch === '\\' && next) {
        sql += next;
        i++;
      }
      continue;
    }
    if (ch === '-' && next === '-') {
      lineComment = true;
      sql += ch + next;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      sql += ch + next;
      i++;
      continue;
    }
    if ('\'"`'.includes(ch)) {
      quote = ch;
      sql += ch;
      continue;
    }
    if (ch === '$' && /\d/.test(next ?? '')) {
      const match = /^\$(\d+)/.exec(source.slice(i))!,
        index = Number(match[1]) - 1;
      if (index < 0 || index >= values.length) throw new Error('Missing SQL binding');
      used.add(index);
      const value = values[index];
      parameters.push(
        value === undefined
          ? null
          : typeof value === 'object' &&
              value !== null &&
              !(value instanceof Date) &&
              !Buffer.isBuffer(value) &&
              !(value instanceof Uint8Array)
            ? JSON.stringify(value)
            : value,
      );
      sql += '?';
      i += match[0].length - 1;
      continue;
    }
    sql += ch;
  }
  if (quote || blockComment) throw new Error('Unterminated SQL literal or comment');
  if (used.size !== values.length) throw new Error('Unused SQL binding');
  return { sql, parameters };
}

async function execute(
  connection: Pool | PoolConnection,
  text: string,
  values: unknown[] = [],
): Promise<Pick<QueryResult, 'rows' | 'rowCount'>> {
  if (text === 'BEGIN') {
    await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await (connection as PoolConnection).beginTransaction();
    return { rows: [], rowCount: 0 };
  }
  if (text === 'COMMIT' || text === 'ROLLBACK') {
    if (text === 'COMMIT') await (connection as PoolConnection).commit();
    else await (connection as PoolConnection).rollback();
    return { rows: [], rowCount: 0 };
  }
  const bound = mysqlBindings(text, values);
  const [result] = await connection.execute(
    bound.sql,
    bound.parameters as Parameters<Pool['execute']>[1],
  );
  if (Array.isArray(result)) return { rows: result as RowDataPacket[], rowCount: result.length };
  return { rows: [], rowCount: (result as ResultSetHeader).affectedRows };
}

export class MySqlDatabase implements DatabasePool {
  readonly dialect = 'mysql' as const;
  readonly native: Pool;
  constructor(url: string, ca?: string) {
    this.native = createMySqlPool(url, ca);
  }
  query(sql: string, values?: unknown[]) {
    return execute(this.native, sql, values);
  }
  async connect(): Promise<DatabaseConnection> {
    const c = await this.native.getConnection();
    return {
      dialect: 'mysql',
      query: (sql, values) => execute(c, sql, values),
      release: () => c.release(),
    };
  }
  end() {
    return this.native.end();
  }
}
export async function openDatabase(url: string, ca?: string): Promise<DatabasePool> {
  const protocol = new URL(url).protocol;
  if (protocol === 'mysql:') return new MySqlDatabase(url, ca);
  if (protocol !== 'postgres:' && protocol !== 'postgresql:')
    throw new Error('Unsupported database protocol');
  // Transitional source backend remains available until data cutover is verified.
  const { default: pg } = await import('pg');
  return new pg.Pool({
    connectionString: url,
    max: 10,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
  });
}
export async function databaseFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required; configure and migrate first');
  const ca = env.DATABASE_CA_FILE ? await readFile(env.DATABASE_CA_FILE, 'utf8') : undefined;
  return openDatabase(env.DATABASE_URL, ca);
}
