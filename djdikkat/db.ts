/************************************************************
 * DJ DIKKAT - Music Bot
 * MariaDB connection pool
 * Build 5.1.0
 * Author: Yanoee
 *
 * Reads DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD
 * from .env. The schema in schema.sql is applied by ensureSchema().
 ************************************************************/
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';

// Anything mysql2 accepts as a placeholder value (arrays expand to lists / VALUES ?)
export type SqlParam = string | number | boolean | Date | Buffer | null | SqlParam[];

let pool: Pool | null = null;

function getPool(): Pool {
  pool ??= mysql.createPool({
    host:     process.env.DB_HOST || '127.0.0.1',
    port:     parseInt(process.env.DB_PORT || '3306', 10),
    database: process.env.DB_NAME || 'djdikkat',
    user:     process.env.DB_USER || 'djdikkat',
    password: process.env.DB_PASSWORD,
    connectionLimit: 5,
    charset:  'utf8mb4',
    timezone: 'Z' // DATETIME columns hold UTC
  });
  return pool;
}

/** Runs one statement; returns rows for SELECTs (typed by the caller). */
export async function query<T = unknown>(sql: string, params?: SqlParam[]): Promise<T> {
  const [rows] = await getPool().query(sql, params);
  return rows as T;
}

type QueryFn = <T = unknown>(sql: string, params?: SqlParam[]) => Promise<T>;

/** Runs fn inside a transaction; its `query` has the same signature as query(). */
export async function transaction<R>(fn: (tx: { query: QueryFn }) => Promise<R>): Promise<R> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn({ query: async <T,>(sql: string, params?: SqlParam[]) => (await conn.query(sql, params))[0] as T });
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Fire-and-forget write: the in-memory cache is already updated, so callers
 * never wait on the DB. Failures are logged, not thrown.
 */
export function background(promise: Promise<unknown>, what: string): void {
  promise.catch((err: Error) => console.error(`[DB] ${what} failed: ${err.message}`));
}

export async function ensureSchema(): Promise<void> {
  const sql = readFileSync(join(import.meta.dirname, 'schema.sql'), 'utf8')
    .split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    await query(statement);
  }
}

export async function close(): Promise<void> {
  await pool?.end().catch(() => {});
  pool = null;
}

/** Date / ISO string → Date or null, for DATETIME params. */
export function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** DATETIME result → ISO string or null. */
export function toIso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}
