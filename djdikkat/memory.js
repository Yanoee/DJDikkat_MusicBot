/************************************************************
 * DJ DIKKAT - Music Bot
 * Memory store
 * Per-guild storage (history / settings / messages) in MariaDB
 * Build 5.0.0
 * Author: Yanoee
 *
 * Tables:
 *   guilds — settings + UI / stats message IDs (one row per guild)
 *   plays  — every track played (history = newest HISTORY_MAX per guild)
 *
 * Everything is preloaded into memory by loadAll() at startup, so
 * all getters stay synchronous. Writes update the cache first and
 * then go to the DB in the background.
 *
 * Each guild is fully isolated. Resetting one guild never
 * touches another guild's rows.
 ************************************************************/

const db = require('./db');

const HISTORY_MAX    = 200;
const WRITE_DEBOUNCE = 250; // ms

// ── Per-guild in-memory caches ────────────────────────────
const memCache = new Map(); // guildId -> memory data
const msgCache = new Map(); // guildId -> messages data

// ── Per-guild debounced row writes ────────────────────────
const rowTimers   = new Map(); // guildId -> timer handle
const rowInFlight = new Map(); // guildId -> Promise

// ── Empty templates ───────────────────────────────────────

function emptyMemory() {
  return {
    settings: {
      defaultTextChannelId: null,
      announceChannelId: null,
      lastCommandTime: null,
      lastAnnouncementAt: null
    },
    history: []
  };
}

function emptyMessages() {
  return {
    uiMessageId: null,
    uiChannelId: null,
    statsMessageId: null,
    statsChannelId: null,
    statsPostedAt: null
  };
}

// ── Loaders ───────────────────────────────────────────────

function loadMemory(guildId) {
  if (!memCache.has(guildId)) memCache.set(guildId, emptyMemory());
  return memCache.get(guildId);
}

function loadMessages(guildId) {
  if (!msgCache.has(guildId)) msgCache.set(guildId, emptyMessages());
  return msgCache.get(guildId);
}

async function loadAll() {
  memCache.clear();
  msgCache.clear();

  for (const r of await db.query('SELECT * FROM guilds')) {
    const mem = emptyMemory();
    mem.settings = {
      defaultTextChannelId: r.default_text_channel_id,
      announceChannelId:    r.announce_channel_id,
      lastCommandTime:      db.toIso(r.last_command_at),
      lastAnnouncementAt:   db.toIso(r.last_announcement_at)
    };
    memCache.set(r.guild_id, mem);
    msgCache.set(r.guild_id, {
      uiMessageId:    r.ui_message_id,
      uiChannelId:    r.ui_channel_id,
      statsMessageId: r.stats_message_id,
      statsChannelId: r.stats_channel_id,
      statsPostedAt:  db.toIso(r.stats_posted_at)
    });
  }

  const rows = await db.query(
    `SELECT guild_id, title, url, user_id, user_tag, played_at FROM (
       SELECT p.*, ROW_NUMBER() OVER (PARTITION BY guild_id ORDER BY played_at DESC, id DESC) AS rn
       FROM plays p
     ) t WHERE rn <= ? ORDER BY guild_id, played_at DESC, id DESC`,
    [HISTORY_MAX]
  );
  for (const r of rows) {
    loadMemory(r.guild_id).history.push({
      title: r.title, url: r.url, userId: r.user_id, userTag: r.user_tag, ts: db.toIso(r.played_at)
    });
  }

  return { guilds: memCache.size, plays: rows.length };
}

// ── Debounced guild row writer ────────────────────────────

function guildRowParams(guildId) {
  const s = loadMemory(guildId).settings;
  const m = loadMessages(guildId);
  return [
    guildId,
    s.defaultTextChannelId || null,
    s.announceChannelId || null,
    db.toDate(s.lastCommandTime),
    db.toDate(s.lastAnnouncementAt),
    m.uiMessageId || null,
    m.uiChannelId || null,
    m.statsMessageId || null,
    m.statsChannelId || null,
    db.toDate(m.statsPostedAt)
  ];
}

const UPSERT_GUILD_ROW = `
  INSERT INTO guilds (guild_id, default_text_channel_id, announce_channel_id,
                      last_command_at, last_announcement_at,
                      ui_message_id, ui_channel_id, stats_message_id, stats_channel_id, stats_posted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    default_text_channel_id = VALUES(default_text_channel_id),
    announce_channel_id = VALUES(announce_channel_id),
    last_command_at = VALUES(last_command_at), last_announcement_at = VALUES(last_announcement_at),
    ui_message_id = VALUES(ui_message_id), ui_channel_id = VALUES(ui_channel_id),
    stats_message_id = VALUES(stats_message_id), stats_channel_id = VALUES(stats_channel_id),
    stats_posted_at = VALUES(stats_posted_at)`;

function writeGuildRow(guildId) {
  const params = guildRowParams(guildId); // snapshot now, not when the chain gets to it
  const prev = rowInFlight.get(guildId) ?? Promise.resolve();
  const next = prev
    .then(() => db.query(UPSERT_GUILD_ROW, params))
    .catch(err => console.error(`[DB] Failed to write guild row ${guildId}: ${err.message}`));
  rowInFlight.set(guildId, next);
  return next;
}

function scheduleGuildWrite(guildId) {
  if (rowTimers.has(guildId)) return;
  rowTimers.set(guildId, setTimeout(() => {
    rowTimers.delete(guildId);
    writeGuildRow(guildId);
  }, WRITE_DEBOUNCE));
}

// Writes any pending debounced rows now. Called on shutdown.
async function flush() {
  for (const [guildId, timer] of rowTimers) {
    clearTimeout(timer);
    rowTimers.delete(guildId);
    writeGuildRow(guildId);
  }
  await Promise.all(rowInFlight.values());
}

// ── Public API — guild directory ──────────────────────────

// Keeps name/icon/membership current so the admin panel can show every
// guild the bot has data for, including ones it has since left.
async function syncGuildInfo(guild, present = true) {
  if (!guild?.id) return;
  await db.query(
    `INSERT INTO guilds (guild_id, name, icon_url, member_count, in_guild, joined_at, left_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = COALESCE(VALUES(name), name), icon_url = VALUES(icon_url),
       member_count = COALESCE(VALUES(member_count), member_count),
       in_guild = VALUES(in_guild), joined_at = COALESCE(VALUES(joined_at), joined_at),
       left_at = VALUES(left_at)`,
    [
      guild.id,
      guild.name ? String(guild.name).slice(0, 100) : null,
      present && guild.iconURL ? guild.iconURL({ size: 64 }) : null,
      Number.isFinite(guild.memberCount) ? guild.memberCount : null,
      present ? 1 : 0,
      db.toDate(guild.joinedAt),
      present ? null : new Date()
    ]
  );
}

async function syncAllGuildInfo(client) {
  const ids = [...client.guilds.cache.keys()];
  for (const guild of client.guilds.cache.values()) await syncGuildInfo(guild, true);
  // Anything not in the cache any more was left while the bot was offline.
  if (ids.length) {
    await db.query(
      'UPDATE guilds SET in_guild = 0, left_at = COALESCE(left_at, ?) WHERE in_guild = 1 AND guild_id NOT IN (?)',
      [new Date(), ids]
    );
  }
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

  db.background(db.query(
    'INSERT INTO plays (guild_id, title, url, user_id, user_tag, played_at) VALUES (?, ?, ?, ?, ?, ?)',
    [guildId, entry.title.slice(0, 512), entry.url ? entry.url.slice(0, 1024) : null,
     entry.userId, entry.userTag ? entry.userTag.slice(0, 100) : null, new Date(entry.ts)]
  ), `record play for guild ${guildId}`);
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
  scheduleGuildWrite(guildId);
}

function getGuildMemory(guildId) {
  return loadMemory(guildId);
}

function getGuildMessagesRaw(guildId) {
  return loadMessages(guildId);
}

// ── Public API — reset (guild-scoped, never cross-guild) ──

// Settings back to defaults + history wiped.
async function resetGuildMemory(guildId) {
  if (!guildId) return;
  memCache.set(guildId, emptyMemory());
  await db.query('DELETE FROM plays WHERE guild_id = ?', [guildId]);
  await writeGuildRow(guildId);
}

async function resetGuildHistory(guildId) {
  if (!guildId) return;
  const mem = loadMemory(guildId);
  mem.history = [];
  await db.query('DELETE FROM plays WHERE guild_id = ?', [guildId]);
}

async function resetGuildMessages(guildId) {
  if (!guildId) return;
  msgCache.set(guildId, emptyMessages());
  await writeGuildRow(guildId);
}

// ── Public API — UI message tracking ─────────────────────

async function setUiMessage(guildId, channelId, messageId) {
  if (!guildId) return;
  const msg = loadMessages(guildId);
  msg.uiMessageId = messageId || null;
  msg.uiChannelId = channelId || null;
  scheduleGuildWrite(guildId);
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
  for (const guildId of msgCache.keys()) {
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
  scheduleGuildWrite(guildId);
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
  for (const guildId of msgCache.keys()) {
    const { messageId, channelId, postedAt } = getStatsMessage(guildId);
    if (messageId && channelId) results.push({ guildId, messageId, channelId, postedAt });
  }
  return results;
}

// ── Exports ───────────────────────────────────────────────

module.exports = {
  loadAll,
  flush,
  syncGuildInfo,
  syncAllGuildInfo,
  recordHistory,
  setGuildSettings,
  getGuildMemory,
  getHistoryPage,
  getGuildMessagesRaw,
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
