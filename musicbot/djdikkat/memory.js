/************************************************************
 * DJ DIKKAT - Music Bot
 * Memory store
 * JSON-backed guild cache (history/settings)
 * Build 2.0.4.24
 * Author: Yanoee
 ************************************************************/

const fs = require('fs');
const path = require('path');

const MEMORY_PATH = path.join(__dirname, 'data/memory.json');
const HISTORY_MAX = 200;
const RECENT_MAX = 10;

function emptyMemory() {
  return {
    version: 1,
    guilds: {}
  };
}

function loadMemory() {
  try {
    if (!fs.existsSync(MEMORY_PATH)) return emptyMemory();
    const raw = fs.readFileSync(MEMORY_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data && data.guilds ? data : emptyMemory();
  } catch {
    return emptyMemory();
  }
}

function saveMemory(mem) {
  try {
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(mem, null, 2), 'utf8');
  } catch {}
}

function ensureGuild(mem, guildId) {
  if (!mem.guilds[guildId]) {
    mem.guilds[guildId] = {
      settings: {
        volume: 100,
        defaultTextChannelId: null,
        djRoleId: null,
        debug: false,
        lastCommandTime: null
      },
      recentSongs: [],
      recentUsers: [],
      history: []
    };
  }
  return mem.guilds[guildId];
}

function updateRecent(list, item, keyFn) {
  const key = keyFn(item);
  const filtered = list.filter(x => keyFn(x) !== key);
  const next = [item, ...filtered];
  return next.slice(0, RECENT_MAX);
}

function recordHistory(guildId, { title, url, userId, userTag }) {
  if (!guildId) return;
  const mem = loadMemory();
  const guild = ensureGuild(mem, guildId);

  const entry = {
    title: title || 'Unknown',
    url: url || null,
    userId: userId || null,
    userTag: userTag || null,
    ts: new Date().toISOString()
  };

  guild.history.unshift(entry);
  if (guild.history.length > HISTORY_MAX) guild.history.length = HISTORY_MAX;

  guild.recentSongs = updateRecent(guild.recentSongs, {
    title: entry.title,
    url: entry.url
  }, (x) => `${x.title}|${x.url || ''}`);

  if (userId) {
    guild.recentUsers = updateRecent(guild.recentUsers, {
      userId,
      userTag: userTag || userId
    }, (x) => x.userId);
  }

  saveMemory(mem);
}

function setGuildSettings(guildId, patch) {
  if (!guildId) return;
  const mem = loadMemory();
  const guild = ensureGuild(mem, guildId);
  guild.settings = { ...guild.settings, ...patch };
  saveMemory(mem);
}

function getGuildMemory(guildId) {
  const mem = loadMemory();
  const guild = ensureGuild(mem, guildId);
  return guild;
}

function getHistoryPage(guildId, page, pageSize) {
  const guild = getGuildMemory(guildId);
  const total = guild.history.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const slice = guild.history.slice(start, start + pageSize);
  return { entries: slice, page: safePage, totalPages, total };
}

function resetGuildMemory(guildId) {
  if (!guildId) return;
  const mem = loadMemory();
  mem.guilds[guildId] = undefined;
  delete mem.guilds[guildId];
  saveMemory(mem);
}

function resetGuildHistory(guildId) {
  if (!guildId) return;
  const mem = loadMemory();
  const guild = ensureGuild(mem, guildId);
  guild.history = [];
  saveMemory(mem);
}

function setStatsMessage(guildId, channelId, messageId) {
  if (!guildId) return;
  const mem = loadMemory();
  const guild = ensureGuild(mem, guildId);
  guild.settings = { ...guild.settings, statsMessageId: messageId || null, statsChannelId: channelId || null };
  saveMemory(mem);
}

function getStatsMessage(guildId) {
  const guild = getGuildMemory(guildId);
  return {
    messageId: guild.settings.statsMessageId || null,
    channelId: guild.settings.statsChannelId || null
  };
}

function clearStatsMessage(guildId) {
  setStatsMessage(guildId, null, null);
}

module.exports = {
  recordHistory,
  setGuildSettings,
  getGuildMemory,
  getHistoryPage,
  resetGuildMemory,
  resetGuildHistory,
  setStatsMessage,
  getStatsMessage,
  clearStatsMessage
};
