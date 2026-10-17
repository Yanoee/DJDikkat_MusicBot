/************************************************************
 * DJ DIKKAT - Music Bot
 * MariaDB connection pool
 * Author: Yanoee
 *
 * The schema in database/schema/bot.sql is applied by ensureSchema().
 ************************************************************/
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
import { config } from '../config.ts';

// Anything mysql2 accepts as a placeholder value (arrays expand to lists / VALUES ?)
export type SqlParam = string | number | boolean | Date | Buffer | null | SqlParam[];

let pool: Pool | null = null;

function getPool(): Pool {
  pool ??= mysql.createPool({
    host:     config.db.host,
    port:     config.db.port,
    database: config.db.name,
    user:     config.db.user,
    password: config.db.password,
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

/**
 * Fire-and-forget write: the in-memory cache is already updated, so callers
 * never wait on the DB. Failures are logged, not thrown.
 */
export function background(promise: Promise<unknown>, what: string): void {
  promise.catch((err: Error) => console.error(`[DB] ${what} failed: ${err.message}`));
}

export async function ensureSchema(): Promise<void> {
  const sql = readFileSync(config.paths.schema, 'utf8')
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
