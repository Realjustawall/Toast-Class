import type { DatabasePool, DatabaseConnection, SqlExecutor } from './database.js';
import { randomUUID } from 'node:crypto';
export async function securityEvent(c: SqlExecutor, userId: string, action: string) {
  await c.query('INSERT INTO account_security_events(id,user_id,action) VALUES($1,$2,$3)', [
    randomUUID(),
    userId,
    action,
  ]);
}
export async function transaction<T>(
  pool: DatabasePool,
  fn: (c: DatabaseConnection) => Promise<T>,
) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const value = await fn(c);
    await c.query('COMMIT');
    return value;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
export async function audit(
  c: DatabaseConnection,
  actorId: string | null,
  organizationId: string,
  action: string,
  resourceId: string,
  details: Record<string, unknown> = {},
) {
  await c.query(
    'INSERT INTO audit_logs(id,actor_id,organization_id,action,resource_id,actor_kind,details) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      randomUUID(),
      actorId,
      organizationId,
      action,
      resourceId,
      actorId ? 'user' : 'system',
      JSON.stringify(details),
    ],
  );
}
