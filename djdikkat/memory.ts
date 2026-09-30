/************************************************************
 * DJ DIKKAT - Music Bot
 * Memory store
 * Per-guild storage (history / settings / messages) in MariaDB
 * Build 5.1.0
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
import type { Client, Guild } from 'discord.js';
import * as db from './db.ts';

export interface GuildSettings {
  defaultTextChannelId: string | null; // last channel a command was used in
  announceChannelId: string | null;    // admin-pinned announcement channel
  lastCommandTime: string | null;
  lastAnnouncementAt: string | null;
}

export interface HistoryEntry {
  title: string;
  url: string | null;
  userId: string | null;
  userTag: string | null;
  ts: string;
}

export interface GuildMemory {
  settings: GuildSettings;
  history: HistoryEntry[];
}

export interface GuildMessages {
  uiMessageId: string | null;
  uiChannelId: string | null;
  statsMessageId: string | null;
  statsChannelId: string | null;
  statsPostedAt: string | null;
}

interface GuildRow {
  guild_id: string;
  default_text_channel_id: string | null;
  announce_channel_id: string | null;
  last_command_at: Date | null;
  last_announcement_at: Date | null;
  ui_message_id: string | null;
  ui_channel_id: string | null;
  stats_message_id: string | null;
  stats_channel_id: string | null;
  stats_posted_at: Date | null;
}

const HISTORY_MAX    = 200;
const WRITE_DEBOUNCE = 250; // ms

const memCache = new Map<string, GuildMemory>();
const msgCache = new Map<string, GuildMessages>();

// Per-guild debounced row writes
const rowTimers   = new Map<string, NodeJS.Timeout>();
const rowInFlight = new Map<string, Promise<unknown>>();

const emptyMemory = (): GuildMemory => ({
  settings: { defaultTextChannelId: null, announceChannelId: null, lastCommandTime: null, lastAnnouncementAt: null },
  history: []
});

const emptyMessages = (): GuildMessages => ({
  uiMessageId: null, uiChannelId: null, statsMessageId: null, statsChannelId: null, statsPostedAt: null
});

function loadMemory(guildId: string): GuildMemory {
  let mem = memCache.get(guildId);
  if (!mem) memCache.set(guildId, mem = emptyMemory());
  return mem;
}

function loadMessages(guildId: string): GuildMessages {
  let msg = msgCache.get(guildId);
  if (!msg) msgCache.set(guildId, msg = emptyMessages());
  return msg;
}

export async function loadAll(): Promise<{ guilds: number; plays: number }> {
  memCache.clear();
  msgCache.clear();

  for (const r of await db.query<GuildRow[]>('SELECT * FROM guilds')) {
    memCache.set(r.guild_id, {
      settings: {
        defaultTextChannelId: r.default_text_channel_id,
        announceChannelId:    r.announce_channel_id,
        lastCommandTime:      db.toIso(r.last_command_at),
        lastAnnouncementAt:   db.toIso(r.last_announcement_at)
      },
      history: []
    });
    msgCache.set(r.guild_id, {
      uiMessageId:    r.ui_message_id,
      uiChannelId:    r.ui_channel_id,
      statsMessageId: r.stats_message_id,
      statsChannelId: r.stats_channel_id,
      statsPostedAt:  db.toIso(r.stats_posted_at)
    });
  }

  const rows = await db.query<{ guild_id: string; title: string; url: string | null; user_id: string | null; user_tag: string | null; played_at: Date }[]>(
    `SELECT guild_id, title, url, user_id, user_tag, played_at FROM (
       SELECT p.*, ROW_NUMBER() OVER (PARTITION BY guild_id ORDER BY played_at DESC, id DESC) AS rn
       FROM plays p
     ) t WHERE rn <= ? ORDER BY guild_id, played_at DESC, id DESC`,
    [HISTORY_MAX]
  );
  for (const r of rows) {
    loadMemory(r.guild_id).history.push({
      title: r.title, url: r.url, userId: r.user_id, userTag: r.user_tag, ts: r.played_at.toISOString()
    });
  }

  return { guilds: memCache.size, plays: rows.length };
}

// ── Debounced guild row writer ────────────────────────────

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

function writeGuildRow(guildId: string): Promise<unknown> {
  // snapshot now, not when the chain gets to it
  const s = loadMemory(guildId).settings;
  const m = loadMessages(guildId);
  const params = [
    guildId, s.defaultTextChannelId, s.announceChannelId,
    db.toDate(s.lastCommandTime), db.toDate(s.lastAnnouncementAt),
    m.uiMessageId, m.uiChannelId, m.statsMessageId, m.statsChannelId, db.toDate(m.statsPostedAt)
  ];
  const next = (rowInFlight.get(guildId) ?? Promise.resolve())
    .then(() => db.query(UPSERT_GUILD_ROW, params))
    .catch((err: Error) => console.error(`[DB] Failed to write guild row ${guildId}: ${err.message}`));
  rowInFlight.set(guildId, next);
  return next;
}

function scheduleGuildWrite(guildId: string): void {
  if (rowTimers.has(guildId)) return;
  rowTimers.set(guildId, setTimeout(() => {
    rowTimers.delete(guildId);
    writeGuildRow(guildId);
  }, WRITE_DEBOUNCE));
}

/** Writes pending debounced rows now. Called on shutdown. */
export async function flush(): Promise<void> {
  for (const [guildId, timer] of rowTimers) {
    clearTimeout(timer);
    rowTimers.delete(guildId);
    writeGuildRow(guildId);
  }
  await Promise.all(rowInFlight.values());
}

// ── Guild directory ───────────────────────────────────────

/**
 * Keeps name/icon/membership current so the admin panel can show every
 * guild the bot has data for, including ones it has since left.
 */
export async function syncGuildInfo(guild: Guild, present = true): Promise<void> {
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
      guild.name ? guild.name.slice(0, 100) : null,
      present ? guild.iconURL({ size: 64 }) : null,
      Number.isFinite(guild.memberCount) ? guild.memberCount : null,
      present ? 1 : 0,
      db.toDate(guild.joinedAt),
      present ? null : new Date()
    ]
  );
}

export async function syncAllGuildInfo(client: Client): Promise<void> {
  const ids = [...client.guilds.cache.keys()];
  for (const guild of client.guilds.cache.values()) await syncGuildInfo(guild, true);
  // Anything not in the cache any more was left while the bot was offline.
  if (ids.length) {
    await db.query('UPDATE guilds SET in_guild = 0, left_at = COALESCE(left_at, ?) WHERE in_guild = 1 AND guild_id NOT IN (?)',
      [new Date(), ids]);
  }
}

// ── History ───────────────────────────────────────────────

export function recordHistory(guildId: string, p: { title?: string; url?: string | null; userId?: string | null; userTag?: string | null }): void {
  const entry: HistoryEntry = {
    title:   p.title   || 'Unknown',
    url:     p.url     || null,
    userId:  p.userId  || null,
    userTag: p.userTag || null,
    ts: new Date().toISOString()
  };
  const mem = loadMemory(guildId);
  mem.history.unshift(entry);
  if (mem.history.length > HISTORY_MAX) mem.history.length = HISTORY_MAX;

  db.background(db.query('INSERT INTO plays (guild_id, title, url, user_id, user_tag, played_at) VALUES (?, ?, ?, ?, ?, ?)',
    [guildId, entry.title.slice(0, 512), entry.url?.slice(0, 1024) ?? null, entry.userId,
     entry.userTag?.slice(0, 100) ?? null, new Date(entry.ts)]), `record play for guild ${guildId}`);
}

export function getHistoryPage(guildId: string, page: number, pageSize: number) {
  const { history } = loadMemory(guildId);
  const totalPages = Math.max(1, Math.ceil(history.length / pageSize));
  const safePage   = Math.min(Math.max(1, page), totalPages);
  const start      = (safePage - 1) * pageSize;
  return { entries: history.slice(start, start + pageSize), page: safePage, totalPages, total: history.length };
}

// ── Settings ──────────────────────────────────────────────

export function setGuildSettings(guildId: string, patch: Partial<GuildSettings>): void {
  const mem = loadMemory(guildId);
  mem.settings = { ...mem.settings, ...patch };
  scheduleGuildWrite(guildId);
}

export const getGuildMemory = loadMemory;
export const getGuildMessagesRaw = loadMessages;

// ── Reset (guild-scoped, never cross-guild) ───────────────

/** Settings back to defaults + history wiped. */
export async function resetGuildMemory(guildId: string): Promise<void> {
  memCache.set(guildId, emptyMemory());
  await db.query('DELETE FROM plays WHERE guild_id = ?', [guildId]);
  await writeGuildRow(guildId);
}

export async function resetGuildHistory(guildId: string): Promise<void> {
  loadMemory(guildId).history = [];
  await db.query('DELETE FROM plays WHERE guild_id = ?', [guildId]);
}

export async function resetGuildMessages(guildId: string): Promise<void> {
  msgCache.set(guildId, emptyMessages());
  await writeGuildRow(guildId);
}

// ── Player card (UI) message tracking ─────────────────────

export function setUiMessage(guildId: string, channelId: string | null, messageId: string | null): void {
  const msg = loadMessages(guildId);
  msg.uiMessageId = messageId;
  msg.uiChannelId = channelId;
  scheduleGuildWrite(guildId);
}

export function clearUiMessage(guildId: string): void {
  setUiMessage(guildId, null, null);
}

export function getUiMessage(guildId: string) {
  const msg = loadMessages(guildId);
  return { messageId: msg.uiMessageId, channelId: msg.uiChannelId };
}

export function getAllSavedUiMessages() {
  const out: { guildId: string; messageId: string; channelId: string }[] = [];
  for (const [guildId, m] of msgCache) {
    if (m.uiMessageId && m.uiChannelId) out.push({ guildId, messageId: m.uiMessageId, channelId: m.uiChannelId });
  }
  return out;
}

// ── Stats card message tracking ───────────────────────────

export function setStatsMessage(guildId: string, channelId: string | null, messageId: string | null): void {
  const msg = loadMessages(guildId);
  msg.statsMessageId = messageId;
  msg.statsChannelId = channelId;
  msg.statsPostedAt  = messageId ? new Date().toISOString() : null;
  scheduleGuildWrite(guildId);
}

export function clearStatsMessage(guildId: string): void {
  setStatsMessage(guildId, null, null);
}

export function getStatsMessage(guildId: string) {
  const msg = loadMessages(guildId);
  return { messageId: msg.statsMessageId, channelId: msg.statsChannelId, postedAt: msg.statsPostedAt };
}

export function getAllSavedStatsMessages() {
  const out: { guildId: string; messageId: string; channelId: string; postedAt: string | null }[] = [];
  for (const [guildId, m] of msgCache) {
    if (m.statsMessageId && m.statsChannelId) {
      out.push({ guildId, messageId: m.statsMessageId, channelId: m.statsChannelId, postedAt: m.statsPostedAt });
    }
  }
  return out;
}
