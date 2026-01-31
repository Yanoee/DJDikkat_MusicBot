/************************************************************
 * DJ DIKKAT - Music Bot
 * Memory store
 * JSON-backed guild cache (history/settings)
 * Build 2.0.7
 * Author: Yanoee
 ************************************************************/

const fs = require('fs');
const path = require('path');
const fsp = fs.promises;

const DATA_DIR = path.join(__dirname, 'data/');
const MEMORY_PATH = path.join(DATA_DIR, 'memory.json');
const MESSAGES_PATH = path.join(DATA_DIR, 'messages.json');
const HISTORY_MAX = 200;
const RECENT_MAX = 10;
const WRITE_DEBOUNCE_MS = 250;

let memoryCache = null;
let messagesCache = null;
let memoryWriteTimer = null;
let messagesWriteTimer = null;
let memoryWriteInFlight = Promise.resolve();
let messagesWriteInFlight = Promise.resolve();

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
  if (memoryCache) return memoryCache;
  try {
    if (!fs.existsSync(MEMORY_PATH)) {
      memoryCache = emptyMemory();
      return memoryCache;
    }
    const raw = fs.readFileSync(MEMORY_PATH, 'utf8');
    const data = JSON.parse(raw);
    memoryCache = data && data.guilds ? data : emptyMemory();
    return memoryCache;
  } catch {
    memoryCache = emptyMemory();
    return memoryCache;
  }
}

function loadMessages() {
  if (messagesCache) return messagesCache;
  try {
    if (!fs.existsSync(MESSAGES_PATH)) {
      messagesCache = emptyMessages();
      return messagesCache;
    }
    const raw = fs.readFileSync(MESSAGES_PATH, 'utf8');
    const data = JSON.parse(raw);
    messagesCache = data && data.guilds ? data : emptyMessages();
    return messagesCache;
  } catch {
    messagesCache = emptyMessages();
    return messagesCache;
  }
}

function scheduleMemoryWrite() {
  if (memoryWriteTimer) return;
  memoryWriteTimer = setTimeout(() => {
    memoryWriteTimer = null;
    const snapshot = memoryCache || emptyMemory();
    memoryWriteInFlight = memoryWriteInFlight.then(async () => {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      await fsp.writeFile(MEMORY_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
    }).catch(() => {});
  }, WRITE_DEBOUNCE_MS);
}

function scheduleMessagesWrite() {
  if (messagesWriteTimer) return;
  messagesWriteTimer = setTimeout(() => {
    messagesWriteTimer = null;
    const snapshot = messagesCache || emptyMessages();
    messagesWriteInFlight = messagesWriteInFlight.then(async () => {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      await fsp.writeFile(MESSAGES_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
    }).catch(() => {});
  }, WRITE_DEBOUNCE_MS);
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

async function recordHistory(guildId, { title, url, userId, userTag }) {
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

  scheduleMemoryWrite();
}

async function setGuildSettings(guildId, patch) {
  if (!guildId) return;
  const mem = loadMemory();
  const guild = ensureGuild(mem, guildId);
  guild.settings = { ...guild.settings, ...patch };
  scheduleMemoryWrite();
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

async function resetGuildMemory(guildId) {
  if (!guildId) return;
  const mem = loadMemory();
  mem.guilds[guildId] = undefined;
  delete mem.guilds[guildId];
  scheduleMemoryWrite();
}

async function resetGuildHistory(guildId) {
  if (!guildId) return;
  const mem = loadMemory();
  const guild = ensureGuild(mem, guildId);
  guild.history = [];
  scheduleMemoryWrite();
}

async function setUiMessage(guildId, channelId, messageId) {
  if (!guildId) return;
  const mem = loadMessages();
  const guild = ensureGuildMessages(mem, guildId);
  guild.messages = { ...guild.messages, uiMessageId: messageId || null, uiChannelId: channelId || null };
  scheduleMessagesWrite();
}

async function clearUiMessage(guildId) {
  await setUiMessage(guildId, null, null);
}

async function setStatsMessage(guildId, channelId, messageId) {
  if (!guildId) return;
  const mem = loadMessages();
  const guild = ensureGuildMessages(mem, guildId);
  guild.messages = { ...guild.messages, statsMessageId: messageId || null, statsChannelId: channelId || null };
  scheduleMessagesWrite();
}

function getStatsMessage(guildId) {
  const mem = loadMessages();
  const guild = ensureGuildMessages(mem, guildId);
  return {
    messageId: guild.messages.statsMessageId || null,
    channelId: guild.messages.statsChannelId || null
  };
}

async function clearStatsMessage(guildId) {
  await setStatsMessage(guildId, null, null);
}

async function resetGuildMessages(guildId) {
  if (!guildId) return;
  const mem = loadMessages();
  mem.guilds[guildId] = undefined;
  delete mem.guilds[guildId];
  scheduleMessagesWrite();
}

module.exports = {
  recordHistory,
  setGuildSettings,
  getGuildMemory,
  getHistoryPage,
  resetGuildMemory,
  resetGuildHistory,
  resetGuildMessages,
  setStatsMessage,
  getStatsMessage,
  clearStatsMessage,
  setUiMessage,
  clearUiMessage
};
