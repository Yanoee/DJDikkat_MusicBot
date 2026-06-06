/************************************************************
 * DJ DIKKAT - Music Bot
 * Memory store
 * Per-guild JSON storage (history / settings / messages)
 * Build 2.1.0
 * Author: Yanoee
 *
 * File layout:
 *   data/guilds/<guildId>/memory.json   — history, settings
 *   data/guilds/<guildId>/messages.json — UI / stats message IDs
 *
 * Each guild is fully isolated. Resetting one guild never
 * touches another guild's files.
 ************************************************************/

const fs   = require('fs');
const path = require('path');
const fsp  = fs.promises;

const DATA_DIR       = path.join(__dirname, 'data');
const HISTORY_MAX    = 200;
const RECENT_MAX     = 10;
const WRITE_DEBOUNCE = 250; // ms

// ── Per-guild in-memory caches ────────────────────────────
const memCache    = new Map(); // guildId -> memory data
const msgCache    = new Map(); // guildId -> messages data

// ── Per-guild debounce timers ─────────────────────────────
const memTimers   = new Map(); // guildId -> timer handle
const msgTimers   = new Map(); // guildId -> timer handle

// ── Per-guild write-in-flight promises ────────────────────
const memInFlight = new Map(); // guildId -> Promise
const msgInFlight = new Map(); // guildId -> Promise

// ── Path helpers ──────────────────────────────────────────

function guildDir(guildId) {
  return path.join(DATA_DIR, 'guilds', guildId);
}

function memFile(guildId) {
  return path.join(guildDir(guildId), 'memory.json');
}

function msgFile(guildId) {
  return path.join(guildDir(guildId), 'messages.json');
}

// ── Empty templates ───────────────────────────────────────

function emptyMemory() {
  return {
    version: 1,
    settings: {
      volume: 100,
      defaultTextChannelId: null,
      djRoleId: null,
      debug: false,
      lastCommandTime: null,
      lastAnnouncementAt: null
    },
    recentSongs: [],
    recentUsers: [],
    history: []
  };
}

function emptyMessages() {
  return {
    version: 1,
    uiMessageId: null,
    uiChannelId: null,
    statsMessageId: null,
    statsChannelId: null,
    statsPostedAt: null
  };
}

// ── Loaders (sync on first call, then cached) ─────────────

function loadMemory(guildId) {
  if (memCache.has(guildId)) return memCache.get(guildId);
  let data = emptyMemory();
  try {
    const file = memFile(guildId);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && Array.isArray(parsed.history)) data = parsed;
    }
  } catch {}
  memCache.set(guildId, data);
  return data;
}

function loadMessages(guildId) {
  if (msgCache.has(guildId)) return msgCache.get(guildId);
  let data = emptyMessages();
  try {
    const file = msgFile(guildId);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.version) data = { ...emptyMessages(), ...parsed };
    }
  } catch {}
  msgCache.set(guildId, data);
  return data;
}

// ── Debounced writers ─────────────────────────────────────

function scheduleMemWrite(guildId) {
  if (memTimers.has(guildId)) return;
  memTimers.set(guildId, setTimeout(() => {
    memTimers.delete(guildId);
    const snapshot = memCache.get(guildId) || emptyMemory();
    const prev = memInFlight.get(guildId) ?? Promise.resolve();
    const next = prev.then(async () => {
      await fsp.mkdir(guildDir(guildId), { recursive: true });
      await fsp.writeFile(memFile(guildId), JSON.stringify(snapshot, null, 2), 'utf8');
    }).catch((err) => {
      console.error(`Failed to write memory file for guild ${guildId}:`, err);
    });
    memInFlight.set(guildId, next);
  }, WRITE_DEBOUNCE));
}

function scheduleMsgWrite(guildId) {
  if (msgTimers.has(guildId)) return;
  msgTimers.set(guildId, setTimeout(() => {
    msgTimers.delete(guildId);
    const snapshot = msgCache.get(guildId) || emptyMessages();
    const prev = msgInFlight.get(guildId) ?? Promise.resolve();
    const next = prev.then(async () => {
      await fsp.mkdir(guildDir(guildId), { recursive: true });
      await fsp.writeFile(msgFile(guildId), JSON.stringify(snapshot, null, 2), 'utf8');
    }).catch((err) => {
      console.error(`Failed to write message file for guild ${guildId}:`, err);
    });
    msgInFlight.set(guildId, next);
  }, WRITE_DEBOUNCE));
}

// ── Internal helper ───────────────────────────────────────

function updateRecent(list, item, keyFn) {
  const key = keyFn(item);
  return [item, ...list.filter(x => keyFn(x) !== key)].slice(0, RECENT_MAX);
}

// ── Public API — history ──────────────────────────────────

async function recordHistory(guildId, { title, url, userId, userTag }) {
  if (!guildId) return;
  const mem = loadMemory(guildId);

  const entry = {
    title:   title   || 'Unknown',
    url:     url     || null,
    userId:  userId  || null,
    userTag: userTag || null,
    ts: new Date().toISOString()
  };

  mem.history.unshift(entry);
  if (mem.history.length > HISTORY_MAX) mem.history.length = HISTORY_MAX;

  mem.recentSongs = updateRecent(
    mem.recentSongs,
    { title: entry.title, url: entry.url },
    x => `${x.title}|${x.url || ''}`
  );

  if (userId) {
    mem.recentUsers = updateRecent(
      mem.recentUsers,
      { userId, userTag: userTag || userId },
      x => x.userId
    );
  }

  scheduleMemWrite(guildId);
}

function getHistoryPage(guildId, page, pageSize) {
  const mem        = loadMemory(guildId);
  const total      = mem.history.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage   = Math.min(Math.max(1, page), totalPages);
  const start      = (safePage - 1) * pageSize;
  return {
    entries: mem.history.slice(start, start + pageSize),
    page: safePage,
    totalPages,
    total
  };
}

// ── Public API — settings ─────────────────────────────────

async function setGuildSettings(guildId, patch) {
  if (!guildId) return;
  const mem = loadMemory(guildId);
  mem.settings = { ...mem.settings, ...patch };
  scheduleMemWrite(guildId);
}

function getGuildMemory(guildId) {
  return loadMemory(guildId);
}

// ── Public API — reset (guild-scoped, never cross-guild) ──

async function resetGuildMemory(guildId) {
  if (!guildId) return;
  memCache.delete(guildId);
  await fsp.unlink(memFile(guildId)).catch(() => {});
}

async function resetGuildHistory(guildId) {
  if (!guildId) return;
  const mem = loadMemory(guildId);
  mem.history     = [];
  mem.recentSongs = [];
  mem.recentUsers = [];
  scheduleMemWrite(guildId);
}

async function resetGuildMessages(guildId) {
  if (!guildId) return;
  msgCache.delete(guildId);
  await fsp.unlink(msgFile(guildId)).catch(() => {});
}

// ── Public API — UI message tracking ─────────────────────

async function setUiMessage(guildId, channelId, messageId) {
  if (!guildId) return;
  const msg = loadMessages(guildId);
  msg.uiMessageId = messageId || null;
  msg.uiChannelId = channelId || null;
  scheduleMsgWrite(guildId);
}

async function clearUiMessage(guildId) {
  return setUiMessage(guildId, null, null);
}

function getUiMessage(guildId) {
  const msg = loadMessages(guildId);
  return {
    messageId: msg.uiMessageId || null,
    channelId: msg.uiChannelId || null
  };
}

function getAllSavedUiMessages() {
  const results = [];
  const guildsDir = path.join(DATA_DIR, 'guilds');
  if (!fs.existsSync(guildsDir)) return results;
  const entries = fs.readdirSync(guildsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const guildId = entry.name;
    const { messageId, channelId } = getUiMessage(guildId);
    if (messageId && channelId) results.push({ guildId, messageId, channelId });
  }
  return results;
}

// ── Public API — stats message tracking ──────────────────

async function setStatsMessage(guildId, channelId, messageId) {
  if (!guildId) return;
  const msg = loadMessages(guildId);
  msg.statsMessageId = messageId || null;
  msg.statsChannelId = channelId || null;
  msg.statsPostedAt  = messageId ? new Date().toISOString() : null;
  scheduleMsgWrite(guildId);
}

async function clearStatsMessage(guildId) {
  return setStatsMessage(guildId, null, null);
}

function getStatsMessage(guildId) {
  const msg = loadMessages(guildId);
  return {
    messageId: msg.statsMessageId || null,
    channelId: msg.statsChannelId || null,
    postedAt:  msg.statsPostedAt  || null
  };
}

function getAllSavedStatsMessages() {
  const results = [];
  const guildsDir = path.join(DATA_DIR, 'guilds');
  if (!fs.existsSync(guildsDir)) return results;
  const entries = fs.readdirSync(guildsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const guildId = entry.name;
    const { messageId, channelId, postedAt } = getStatsMessage(guildId);
    if (messageId && channelId) results.push({ guildId, messageId, channelId, postedAt });
  }
  return results;
}

// ── Exports ───────────────────────────────────────────────

module.exports = {
  recordHistory,
  setGuildSettings,
  getGuildMemory,
  getHistoryPage,
  resetGuildMemory,
  resetGuildHistory,
  resetGuildMessages,
  setUiMessage,
  clearUiMessage,
  getUiMessage,
  getAllSavedUiMessages,
  setStatsMessage,
  clearStatsMessage,
  getAllSavedStatsMessages,
  getStatsMessage
};
