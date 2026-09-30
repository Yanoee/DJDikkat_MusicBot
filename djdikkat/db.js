/************************************************************
 * DJ DIKKAT - Music Bot
 * MariaDB connection pool
 * Build 5.0.0
 * Author: Yanoee
 *
 * Reads DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD
 * from .env. The schema in schema.sql is applied by ensureSchema().
 ************************************************************/

const fs    = require('fs');
const path  = require('path');
const mysql = require('mysql2/promise');

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host:     process.env.DB_HOST || '127.0.0.1',
      port:     parseInt(process.env.DB_PORT || '3306', 10),
      database: process.env.DB_NAME || 'djdikkat',
      user:     process.env.DB_USER || 'djdikkat',
      password: process.env.DB_PASSWORD,
      connectionLimit: 5,
      charset:  'utf8mb4',
      timezone: 'Z' // DATETIME columns hold UTC
    });
  }
  return pool;
}

async function query(sql, params) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

// Runs fn(conn) inside a transaction; conn.query has the same signature as query().
async function transaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn({ query: async (sql, params) => (await conn.query(sql, params))[0] });
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// Fire-and-forget write: the in-memory cache is already updated, so callers
// never wait on the DB. Failures are logged, not thrown.
function background(promise, what) {
  promise.catch(err => console.error(`[DB] ${what} failed: ${err.message}`));
}

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    .split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    await query(statement);
  }
}

async function close() {
  if (pool) await pool.end().catch(() => {});
  pool = null;
}

// JS Date/ISO string → Date or null, for DATETIME params.
function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

// DATETIME result → ISO string or null.
function toIso(value) {
  return value instanceof Date ? value.toISOString() : null;
}

module.exports = { query, transaction, background, ensureSchema, close, toDate, toIso };
