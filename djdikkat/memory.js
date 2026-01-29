/************************************************************
 * DJ DIKKAT - Music Bot
 * Memory store
 * JSON-backed guild cache (history/settings)
 * Build 2.0.5
 * Author: Yanoee
 ************************************************************/

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data/');
const MEMORY_PATH = path.join(DATA_DIR, 'memory.json');
const MESSAGES_PATH = path.join(DATA_DIR, 'messages.json');
const HISTORY_MAX = 200;
const RECENT_MAX = 10;

function emptyMemory() {
  return {
    version: 1,
    guilds: {}
  };
}

function emptyMessages() {
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

function loadMessages() {
  try {
    if (!fs.existsSync(MESSAGES_PATH)) return emptyMessages();
    const raw = fs.readFileSync(MESSAGES_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data && data.guilds ? data : emptyMessages();
  } catch {
    return emptyMessages();
  }
}

function saveMemory(mem) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(mem, null, 2), 'utf8');
  } catch {}
}

function saveMessages(mem) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MESSAGES_PATH, JSON.stringify(mem, null, 2), 'utf8');
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

function ensureGuildMessages(mem, guildId) {
  if (!mem.guilds[guildId]) {
    mem.guilds[guildId] = {
      messages: {
        uiMessageId: null,
        uiChannelId: null,
        statsMessageId: null,
        statsChannelId: null
      }
    };
  } else if (!mem.guilds[guildId].messages) {
    mem.guilds[guildId].messages = {
      uiMessageId: null,
      uiChannelId: null,
      statsMessageId: null,
      statsChannelId: null
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

function getAllGuildSettings() {
  const mem = loadMemory();
  return Object.entries(mem.guilds || {}).map(([guildId, data]) => ({
    guildId,
    settings: data?.settings || {}
  }));
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

function setUiMessage(guildId, channelId, messageId) {
  if (!guildId) return;
  const mem = loadMessages();
  const guild = ensureGuildMessages(mem, guildId);
  guild.messages = { ...guild.messages, uiMessageId: messageId || null, uiChannelId: channelId || null };
  saveMessages(mem);
}

function getUiMessage(guildId) {
  const mem = loadMessages();
  const guild = ensureGuildMessages(mem, guildId);
  return {
    messageId: guild.messages.uiMessageId || null,
    channelId: guild.messages.uiChannelId || null
  };
}

function clearUiMessage(guildId) {
  setUiMessage(guildId, null, null);
}

function setStatsMessage(guildId, channelId, messageId) {
  if (!guildId) return;
  const mem = loadMessages();
  const guild = ensureGuildMessages(mem, guildId);
  guild.messages = { ...guild.messages, statsMessageId: messageId || null, statsChannelId: channelId || null };
  saveMessages(mem);
}

function getStatsMessage(guildId) {
  const mem = loadMessages();
  const guild = ensureGuildMessages(mem, guildId);
  return {
    messageId: guild.messages.statsMessageId || null,
    channelId: guild.messages.statsChannelId || null
  };
}

function clearStatsMessage(guildId) {
  setStatsMessage(guildId, null, null);
}

function resetGuildMessages(guildId) {
  if (!guildId) return;
  const mem = loadMessages();
  mem.guilds[guildId] = undefined;
  delete mem.guilds[guildId];
  saveMessages(mem);
}

module.exports = {
  recordHistory,
  setGuildSettings,
  getGuildMemory,
  getAllGuildSettings,
  getHistoryPage,
  resetGuildMemory,
  resetGuildHistory,
  resetGuildMessages,
  setStatsMessage,
  getStatsMessage,
  clearStatsMessage,
  setUiMessage,
  getUiMessage,
  clearUiMessage
};
