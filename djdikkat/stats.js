/************************************************************
 * DJ DIKKAT - Music Bot
 * Stats engine
 * Per-guild play counters and rollups, stored in MariaDB
 * Build 5.0.0
 * Author: Yanoee
 *
 * Table:
 *   stat_counters — one row per (guild, period, kind, key);
 *                   period 'all' = totals, 'YYYY-MM-DD' = one day
 *
 * Counters are preloaded into memory by loadAll() at startup and
 * each play is written as atomic "count = count + 1" upserts.
 * Each guild's stats are fully isolated.
 ************************************************************/

const crypto = require('crypto');
const db     = require('./db');

const MAX_DAYS = 30;
const TOTALS   = 'all';

// Global boot counter (all guilds combined, resets on restart)
let tracksSinceBoot = 0;
let lastWriteTime   = null;

// ── Per-guild cache ───────────────────────────────────────
const statsCache = new Map(); // guildId -> statsData

// ── Date key helpers ──────────────────────────────────────

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayKey() {
  return dayKey(new Date());
}

function daysAgoKey(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return dayKey(d);
}

// ── Empty templates ───────────────────────────────────────

function emptyStats() {
  return {
    totals: {
      songsByTitle: {},
      songsByUrl: {},
      users: {}
    },
    daily: {}
  };
}

function emptyDay() {
  return { songsByTitle: {}, songsByUrl: {}, users: {}, plays: 0 };
}

// ── Loader ────────────────────────────────────────────────

function loadStats(guildId) {
  if (!statsCache.has(guildId)) statsCache.set(guildId, emptyStats());
  return statsCache.get(guildId);
}

async function loadAll() {
  statsCache.clear();
  await pruneOldDays();

  const rows = await db.query('SELECT guild_id, period, kind, item_key, label, count FROM stat_counters');
  for (const r of rows) {
    const stats  = loadStats(r.guild_id);
    const bucket = r.period === TOTALS
      ? stats.totals
      : (stats.daily[r.period] ||= emptyDay());

    if (r.kind === 'title')      bucket.songsByTitle[r.item_key] = r.count;
    else if (r.kind === 'url')   bucket.songsByUrl[r.item_key]   = { count: r.count, title: r.label || r.item_key };
    else if (r.kind === 'user')  bucket.users[r.item_key]        = { count: r.count, tag: r.label || r.item_key };
    else if (r.kind === 'plays' && r.period !== TOTALS) bucket.plays = r.count;
  }
  return { guilds: statsCache.size, counters: rows.length };
}

async function pruneOldDays() {
  await db.query('DELETE FROM stat_counters WHERE period <> ? AND period < ?', [TOTALS, daysAgoKey(MAX_DAYS)]);
}
setInterval(() => db.background(pruneOldDays(), 'prune old daily stats'), 6 * 60 * 60 * 1000).unref();

// ── Internal helpers ──────────────────────────────────────

function increment(map, key, by = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + by;
}

function keyHash(key) {
  return crypto.createHash('md5').update(key, 'utf8').digest();
}

function counterRow(guildId, period, kind, key, label) {
  const k = String(key).slice(0, 1024);
  return [guildId, period, kind, keyHash(k), k, label ? String(label).slice(0, 512) : null, 1];
}

function buildWeeklyRollup(stats) {
  const songsByTitle = {};
  const songsByUrl   = {};
  const users        = {};
  let plays          = 0;

  for (let i = 0; i < 7; i++) {
    const day = stats.daily[daysAgoKey(i)];
    if (!day) continue;
    plays += day.plays || 0;
    Object.entries(day.songsByTitle || {}).forEach(([t, c]) => increment(songsByTitle, t, c));
    Object.entries(day.songsByUrl   || {}).forEach(([u, v]) => {
      if (!songsByUrl[u]) songsByUrl[u] = { count: 0, title: v.title || u };
      songsByUrl[u].count += v.count || 0;
    });
    Object.entries(day.users || {}).forEach(([id, v]) => {
      if (!users[id]) users[id] = { count: 0, tag: v.tag || id };
      users[id].count += v.count || 0;
    });
  }

  return { songsByTitle, songsByUrl, users, plays };
}

// ── Public API ────────────────────────────────────────────

async function recordPlay(guildId, { title, uri, userId, userTag }) {
  if (!guildId) return;
  tracksSinceBoot += 1;

  const stats = loadStats(guildId);
  const day   = todayKey();
  const daily = (stats.daily[day] ||= emptyDay());
  const rows  = [];

  for (const [bucket, period] of [[stats.totals, TOTALS], [daily, day]]) {
    if (title) {
      increment(bucket.songsByTitle, title, 1);
      rows.push(counterRow(guildId, period, 'title', title, null));
    }
    if (uri) {
      if (!bucket.songsByUrl[uri]) bucket.songsByUrl[uri] = { count: 0, title: title || uri };
      bucket.songsByUrl[uri].count += 1;
      rows.push(counterRow(guildId, period, 'url', uri, title || uri));
    }
    if (userId) {
      if (!bucket.users[userId]) bucket.users[userId] = { count: 0, tag: userTag || userId };
      bucket.users[userId].count += 1;
      rows.push(counterRow(guildId, period, 'user', userId, userTag || userId));
    }
  }
  daily.plays += 1;
  rows.push(counterRow(guildId, day, 'plays', '', null));

  // prune days older than MAX_DAYS from the cache (the DB is pruned on a timer)
  const cutoff = daysAgoKey(MAX_DAYS);
  for (const k of Object.keys(stats.daily)) {
    if (k < cutoff) delete stats.daily[k];
  }

  db.background(
    db.query(
      `INSERT INTO stat_counters (guild_id, period, kind, key_hash, item_key, label, count) VALUES ?
       ON DUPLICATE KEY UPDATE count = count + VALUES(count), label = COALESCE(label, VALUES(label))`,
      [rows]
    ).then(() => { lastWriteTime = new Date(); }),
    `record stats for guild ${guildId}`
  );
}

function getGuildStatsRaw(guildId) {
  return loadStats(guildId);
}

function getStatsSnapshot(guildId) {
  const stats  = loadStats(guildId);
  const today  = stats.daily[todayKey()] || emptyDay();
  const weekly = buildWeeklyRollup(stats);
  return { totals: stats.totals, today, weekly };
}

function getStatsMeta() {
  return { tracksSinceBoot, lastWriteTime };
}

// ── Ranking helpers (used by stats_ui.js) ─────────────────

function topFromMap(map, limit = 3) {
  return Object.entries(map)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function topFromUrlMap(map, limit = 3) {
  return Object.entries(map)
    .map(([key, value]) => ({ key, count: value.count || 0, title: value.title || key }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function topUsers(map, limit = 3) {
  return Object.entries(map)
    .map(([id, value]) => ({ id, count: value.count || 0, tag: value.tag || id }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// ── Exports ───────────────────────────────────────────────

module.exports = {
  loadAll,
  recordPlay,
  getGuildStatsRaw,
  getStatsSnapshot,
  getStatsMeta,
  topFromMap,
  topFromUrlMap,
  topUsers
};
