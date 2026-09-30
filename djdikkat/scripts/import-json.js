/************************************************************
 * DJ DIKKAT - One-time JSON → MariaDB import (bot data)
 *
 * Usage (bot stopped):
 *   node scripts/import-json.js [--data-dir <dir>] [--update-history <file>] [--replace]
 *
 * Imports data/guilds/<id>/{memory,messages,stats}.json, data/dm-track.json
 * and the updater's update-history.json. Refuses to run into non-empty
 * tables unless --replace is given. Runs in one transaction and prints
 * source vs. database counts at the end. The JSON files are left untouched.
 ************************************************************/

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../db');

const args = process.argv.slice(2);
const arg  = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const DATA_DIR       = arg('--data-dir', path.join(__dirname, '..', 'data'));
const UPDATE_HISTORY = arg('--update-history', path.join(__dirname, '..', '..', 'admin-api', 'data', 'update-history.json'));
const REPLACE        = args.includes('--replace');
const TABLES         = ['guilds', 'plays', 'stat_counters', 'dm_messages', 'update_history'];

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const date = v => db.toDate(v);
const cut  = (v, n) => (v == null ? null : String(v).slice(0, n));
const hash = k => crypto.createHash('md5').update(k, 'utf8').digest();

async function insertChunked(q, sql, rows, size = 1000) {
  for (let i = 0; i < rows.length; i += size) await q(sql, [rows.slice(i, i + size)]);
}

async function main() {
  await db.ensureSchema();

  for (const t of TABLES) {
    const [{ n }] = await db.query(`SELECT COUNT(*) AS n FROM ${t}`);
    if (n > 0 && !REPLACE) {
      throw new Error(`Table ${t} already has ${n} rows — rerun with --replace to wipe and re-import`);
    }
  }

  const guildRows = [], playRows = [], counterRows = [];
  const guildsDir = path.join(DATA_DIR, 'guilds');
  const guildIds  = fs.existsSync(guildsDir)
    ? fs.readdirSync(guildsDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
    : [];

  let srcHistory = 0, srcCounters = 0;

  for (const guildId of guildIds) {
    const dir = path.join(guildsDir, guildId);
    const mem = readJson(path.join(dir, 'memory.json'), {});
    const msg = readJson(path.join(dir, 'messages.json'), {});
    const st  = readJson(path.join(dir, 'stats.json'), null);
    const s   = mem.settings || {};

    guildRows.push([
      guildId,
      s.defaultTextChannelId || null,
      date(s.lastCommandTime),
      date(s.lastAnnouncementAt),
      msg.uiMessageId || null,
      msg.uiChannelId || null,
      msg.statsMessageId || null,
      msg.statsChannelId || null,
      date(msg.statsPostedAt),
      0 // in_guild — the bot marks current guilds on its next start
    ]);

    // history is newest-first; insert oldest-first so ids follow time
    const history = Array.isArray(mem.history) ? [...mem.history].reverse() : [];
    srcHistory += history.length;
    for (const h of history) {
      playRows.push([guildId, cut(h.title || 'Unknown', 512), cut(h.url, 1024), h.userId || null, cut(h.userTag, 100), date(h.ts) || new Date(0)]);
    }

    if (st?.totals) {
      const add = (period, bucket) => {
        for (const [k, c] of Object.entries(bucket.songsByTitle || {})) {
          counterRows.push([guildId, period, 'title', hash(cut(k, 1024)), cut(k, 1024), null, c || 0]);
        }
        for (const [k, v] of Object.entries(bucket.songsByUrl || {})) {
          counterRows.push([guildId, period, 'url', hash(cut(k, 1024)), cut(k, 1024), cut(v.title, 512), v.count || 0]);
        }
        for (const [k, v] of Object.entries(bucket.users || {})) {
          counterRows.push([guildId, period, 'user', hash(cut(k, 1024)), cut(k, 1024), cut(v.tag, 512), v.count || 0]);
        }
        if (period !== 'all' && bucket.plays) {
          counterRows.push([guildId, period, 'plays', hash(''), '', null, bucket.plays]);
        }
      };
      add('all', st.totals);
      for (const [day, bucket] of Object.entries(st.daily || {})) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day)) add(day, bucket);
      }
    }
  }
  srcCounters = counterRows.length;

  const dms = readJson(path.join(DATA_DIR, 'dm-track.json'), []);
  const dmRows = (Array.isArray(dms) ? [...dms].reverse() : [])
    .filter(d => d.channelId && d.messageId)
    .map(d => [d.channelId, d.messageId, cut(d.type || 'dm', 32), date(d.ts) || new Date()]);

  let updates = readJson(UPDATE_HISTORY, []);
  if (!Array.isArray(updates)) updates = [];
  const last = readJson(path.join(DATA_DIR, 'last-update.json'), null);
  if (last?.timestamp && !updates.some(u => u.ts === last.timestamp)) {
    updates.unshift({ ...last, ts: last.timestamp });
  }
  const updateRows = [...updates].reverse().filter(u => u.ts).map(u => [
    date(u.ts), cut(u.trigger || 'auto-cron', 32), cut(u.status || 'unknown', 32), cut(u.failedAt, 128),
    u.nodelink?.updated ? 1 : 0, cut(u.nodelink?.commitBefore, 40), cut(u.nodelink?.commitAfter, 40)
  ]);

  await db.transaction(async ({ query: q }) => {
    if (REPLACE) for (const t of TABLES) await q(`DELETE FROM ${t}`);
    await insertChunked(q,
      `INSERT INTO guilds (guild_id, default_text_channel_id, last_command_at,
         last_announcement_at, ui_message_id, ui_channel_id, stats_message_id, stats_channel_id, stats_posted_at, in_guild)
       VALUES ?`, guildRows);
    await insertChunked(q, 'INSERT INTO plays (guild_id, title, url, user_id, user_tag, played_at) VALUES ?', playRows);
    await insertChunked(q,
      `INSERT INTO stat_counters (guild_id, period, kind, key_hash, item_key, label, count) VALUES ?
       ON DUPLICATE KEY UPDATE count = count + VALUES(count)`, counterRows);
    await insertChunked(q, 'INSERT INTO dm_messages (channel_id, message_id, type, created_at) VALUES ?', dmRows);
    await insertChunked(q,
      `INSERT INTO update_history (ts, trigger_src, status, failed_at, nodelink_updated, commit_before, commit_after)
       VALUES ?`, updateRows);
  });

  const count = async t => (await db.query(`SELECT COUNT(*) AS n FROM ${t}`))[0].n;
  const report = [
    ['guilds',         guildRows.length,  await count('guilds')],
    ['plays',          srcHistory,        await count('plays')],
    ['stat_counters',  srcCounters,       await count('stat_counters')],
    ['dm_messages',    dmRows.length,     await count('dm_messages')],
    ['update_history', updateRows.length, await count('update_history')]
  ];
  console.table(report.map(([table, json, database]) => ({ table, json, database, ok: json === database })));

  // Spot-check: all-time play totals per guild must match the JSON exactly.
  let mismatches = 0;
  for (const guildId of guildIds) {
    const st = readJson(path.join(guildsDir, guildId, 'stats.json'), null);
    if (!st?.totals) continue;
    const jsonTotal = Object.values(st.totals.users || {}).reduce((a, v) => a + (v.count || 0), 0);
    const [{ n }] = await db.query(
      "SELECT COALESCE(SUM(count),0) AS n FROM stat_counters WHERE guild_id = ? AND period = 'all' AND kind = 'user'", [guildId]);
    if (Number(n) !== jsonTotal) { mismatches++; console.warn(`  mismatch guild ${guildId}: json=${jsonTotal} db=${n}`); }
  }
  console.log(mismatches ? `❌ ${mismatches} guild total mismatch(es)` : '✅ Per-guild play totals match');
  if (report.some(([, a, b]) => a !== b) || mismatches) process.exitCode = 1;
}

main()
  .catch(err => { console.error('❌ Import failed:', err.message); process.exitCode = 1; })
  .finally(() => db.close());
