import {
  createPool,
  type Pool,
  type PoolConnection,
  type RowDataPacket,
  type ResultSetHeader,
} from 'mysql2/promise';
import type { PoolConnection as CorePoolConnection } from 'mysql2';

export function createMySqlPool(connectionString: string, ca?: string): Pool {
  const url = new URL(connectionString),
    database = decodeURIComponent(url.pathname.slice(1));
  if (
    url.protocol !== 'mysql:' ||
    !url.hostname ||
    !database ||
    !/^\w{1,64}$/.test(database) ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid MySQL database URL');
  const port = Number(url.port || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MySQL port');
  const pool = createPool({
    host: url.hostname,
    port,
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    charset: 'utf8mb4',
    timezone: 'Z',
    connectionLimit: 10,
    waitForConnections: true,
    // Keep the server connection count small while accepting an 800-user
    // classroom's simultaneous authorization/read burst. The queue is bounded.
    queueLimit: 1000,
    multipleStatements: false,
    namedPlaceholders: false,
    enableKeepAlive: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    typeCast(field, next) {
      if (field.type === 'TINY' && field.length === 1) {
        const value = field.string();
        return value === null ? null : value === '1';
      }
      return next();
    },
    ...(ca ? { ssl: { ca, rejectUnauthorized: true, verifyIdentity: true } } : {}),
  });
  pool.pool.on('connection', (connection: CorePoolConnection) => {
    // Driver date encoding and server NOW()/DATETIME must use the same timezone.
    connection.query("SET SESSION time_zone = '+00:00'", (error) => {
      if (error) connection.destroy();
    });
  });
  return pool;
}
/** Native prepared execution; no SQL interpolation or PostgreSQL rewriting. */
export async function mysqlRows<T extends RowDataPacket[]>(
  connection: Pool | PoolConnection,
  sql: string,
  values: readonly (string | number | bigint | boolean | Date | Buffer | Uint8Array | null)[] = [],
): Promise<T> {
  const [rows] = await connection.execute<T>(sql, [...values]);
  return rows;
}
export async function mysqlMutation(
  connection: Pool | PoolConnection,
  sql: string,
  values: readonly (string | number | bigint | boolean | Date | Buffer | Uint8Array | null)[] = [],
): Promise<ResultSetHeader> {
  const [result] = await connection.execute<ResultSetHeader>(sql, [...values]);
  return result;
}
export async function mysqlTransaction<T>(
  pool: Pool,
  fn: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await connection.beginTransaction();
    const value = await fn(connection);
    await connection.commit();
    return value;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
