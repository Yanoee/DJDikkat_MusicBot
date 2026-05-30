/************************************************************
 * DJ DIKKAT - Music Bot
 * Stats engine
 * Per-guild JSON-backed play counters and rollups
 * Build 2.1.0
 * Author: Yanoee
 *
 * File layout:
 *   data/guilds/<guildId>/stats.json — play counts for this guild only
 *
 * Each guild's stats are fully isolated.
 ************************************************************/

const fs   = require('fs');
const path = require('path');
const fsp  = fs.promises;

const DATA_DIR       = path.join(__dirname, 'data');
const MAX_DAYS       = 30;
const WRITE_DEBOUNCE = 250; // ms

// Global boot counter (all guilds combined, resets on restart)
let tracksSinceBoot = 0;
let lastWriteTime   = null;

// ── Per-guild caches and timers ───────────────────────────
const statsCache    = new Map(); // guildId -> statsData
const statsTimers   = new Map(); // guildId -> timer handle
const statsInFlight = new Map(); // guildId -> Promise

// ── Path helpers ──────────────────────────────────────────

function guildDir(guildId) {
  return path.join(DATA_DIR, 'guilds', guildId);
}

function statsFile(guildId) {
  return path.join(guildDir(guildId), 'stats.json');
}

// ── Date key helpers ──────────────────────────────────────

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgoKey(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Empty template ────────────────────────────────────────

function emptyStats() {
  return {
    version: 1,
    totals: {
      songsByTitle: {},
      songsByUrl: {},
      users: {}
    },
    daily: {}
  };
}

// ── Loader (sync on first call, then cached) ──────────────

function loadStats(guildId) {
  if (statsCache.has(guildId)) return statsCache.get(guildId);
  let data = emptyStats();
  try {
    const file = statsFile(guildId);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.totals && parsed.daily) data = parsed;
    }
  } catch {}
  statsCache.set(guildId, data);
  return data;
}

// ── Debounced writer ──────────────────────────────────────

function scheduleStatsWrite(guildId) {
  if (statsTimers.has(guildId)) return;
  statsTimers.set(guildId, setTimeout(() => {
    statsTimers.delete(guildId);
    const snapshot = statsCache.get(guildId) || emptyStats();
    const prev = statsInFlight.get(guildId) ?? Promise.resolve();
    const next = prev.then(async () => {
      await fsp.mkdir(guildDir(guildId), { recursive: true });
      await fsp.writeFile(statsFile(guildId), JSON.stringify(snapshot, null, 2), 'utf8');
      lastWriteTime = new Date();
    }).catch((err) => {
      console.error(`Failed to write stats file for guild ${guildId}:`, err);
    });
    statsInFlight.set(guildId, next);
  }, WRITE_DEBOUNCE));
}

// ── Internal helpers ──────────────────────────────────────

function increment(map, key, by = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + by;
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

  if (!stats.daily[day]) {
    stats.daily[day] = { songsByTitle: {}, songsByUrl: {}, users: {}, plays: 0 };
  }

  const daily = stats.daily[day];

  // totals
  if (title) increment(stats.totals.songsByTitle, title, 1);
  if (uri) {
    if (!stats.totals.songsByUrl[uri]) stats.totals.songsByUrl[uri] = { count: 0, title: title || uri };
    stats.totals.songsByUrl[uri].count += 1;
  }
  if (userId) {
    if (!stats.totals.users[userId]) stats.totals.users[userId] = { count: 0, tag: userTag || userId };
    stats.totals.users[userId].count += 1;
  }

  // daily
  daily.plays += 1;
  if (title) increment(daily.songsByTitle, title, 1);
  if (uri) {
    if (!daily.songsByUrl[uri]) daily.songsByUrl[uri] = { count: 0, title: title || uri };
    daily.songsByUrl[uri].count += 1;
  }
  if (userId) {
    if (!daily.users[userId]) daily.users[userId] = { count: 0, tag: userTag || userId };
    daily.users[userId].count += 1;
  }

  // prune days older than MAX_DAYS
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_DAYS);
  for (const k of Object.keys(stats.daily)) {
    const [y, m, d] = k.split('-').map(Number);
    if (new Date(y, m - 1, d) < cutoff) delete stats.daily[k];
  }

  scheduleStatsWrite(guildId);
}

function getStatsSnapshot(guildId) {
  const stats  = loadStats(guildId);
  const today  = stats.daily[todayKey()] || { songsByTitle: {}, songsByUrl: {}, users: {}, plays: 0 };
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
  recordPlay,
  getStatsSnapshot,
  getStatsMeta,
  topFromMap,
  topFromUrlMap,
  topUsers
};
