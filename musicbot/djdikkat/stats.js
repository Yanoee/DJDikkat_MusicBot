/************************************************************
 * DJ DIKKAT - Music Bot
 * Stats engine
 * JSON-backed play counters and rollups
 * Build 2.0.4.21
 * Author: Yanoee
 ************************************************************/

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STATS_PATH = path.join(DATA_DIR, 'stats.json');
const MAX_DAYS = 30;
let tracksSinceBoot = 0;
let lastWriteTime = null;

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysAgoKey(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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

function loadStats() {
  try {
    if (!fs.existsSync(STATS_PATH)) return emptyStats();
    const raw = fs.readFileSync(STATS_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data && data.totals && data.daily ? data : emptyStats();
  } catch {
    return emptyStats();
  }
}

function saveStats(stats) {
  try {
    fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2), 'utf8');
    lastWriteTime = new Date();
  } catch {}
}

function increment(map, key, by = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + by;
}

function recordPlay({ title, uri, userId, userTag }) {
  tracksSinceBoot += 1;
  const stats = loadStats();
  const day = todayKey();

  if (!stats.daily[day]) {
    stats.daily[day] = {
      songsByTitle: {},
      songsByUrl: {},
      users: {},
      plays: 0
    };
  }

  const daily = stats.daily[day];

  // totals
  if (title) increment(stats.totals.songsByTitle, title, 1);
  if (uri) {
    if (!stats.totals.songsByUrl[uri]) {
      stats.totals.songsByUrl[uri] = { count: 0, title: title || uri };
    }
    stats.totals.songsByUrl[uri].count += 1;
  }
  if (userId) {
    if (!stats.totals.users[userId]) {
      stats.totals.users[userId] = { count: 0, tag: userTag || userId };
    }
    stats.totals.users[userId].count += 1;
  }

  // daily
  daily.plays += 1;
  if (title) increment(daily.songsByTitle, title, 1);
  if (uri) {
    if (!daily.songsByUrl[uri]) {
      daily.songsByUrl[uri] = { count: 0, title: title || uri };
    }
    daily.songsByUrl[uri].count += 1;
  }
  if (userId) {
    if (!daily.users[userId]) {
      daily.users[userId] = { count: 0, tag: userTag || userId };
    }
    daily.users[userId].count += 1;
  }

  // prune old days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_DAYS);
  Object.keys(stats.daily).forEach((k) => {
    const [y, m, d] = k.split('-').map(Number);
    const kd = new Date(y, (m - 1), d);
    if (kd < cutoff) delete stats.daily[k];
  });

  saveStats(stats);
}

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

function buildWeeklyRollup(stats) {
  const songsByTitle = {};
  const songsByUrl = {};
  const users = {};
  let plays = 0;

  for (let i = 0; i < 7; i++) {
    const key = daysAgoKey(i);
    const day = stats.daily[key];
    if (!day) continue;
    plays += day.plays || 0;
    Object.entries(day.songsByTitle || {}).forEach(([t, c]) => increment(songsByTitle, t, c));
    Object.entries(day.songsByUrl || {}).forEach(([u, v]) => {
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

function getStatsSnapshot() {
  const stats = loadStats();
  const today = stats.daily[todayKey()] || { songsByTitle: {}, songsByUrl: {}, users: {}, plays: 0 };
  const weekly = buildWeeklyRollup(stats);
  return {
    totals: stats.totals,
    today,
    weekly
  };
}

function getStatsMeta() {
  return {
    tracksSinceBoot,
    lastWriteTime
  };
}

module.exports = {
  recordPlay,
  getStatsSnapshot,
  topFromMap,
  topFromUrlMap,
  topUsers,
  getStatsMeta
};
