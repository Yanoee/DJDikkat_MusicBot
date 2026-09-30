/************************************************************
 * DJ DIKKAT - Music Bot
 * Stats engine
 * Per-guild play counters and rollups, stored in MariaDB
 * Build 5.1.0
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
import { createHash } from 'node:crypto';
import * as db from './db.ts';
import type { SqlParam } from './db.ts';

interface Counted { count: number }
export interface Bucket {
  songsByTitle: Record<string, number>;
  songsByUrl: Record<string, Counted & { title: string }>;
  users: Record<string, Counted & { tag: string }>;
}
interface Day extends Bucket { plays: number }
export interface GuildStats {
  totals: Bucket;
  daily: Record<string, Day>; // 'YYYY-MM-DD' -> day
}

const MAX_DAYS = 30;
const TOTALS   = 'all';

// Global boot counter (all guilds combined, resets on restart)
let tracksSinceBoot = 0;
let lastWriteTime: Date | null = null;

const statsCache = new Map<string, GuildStats>();

// ── Date keys (server-local date) ─────────────────────────

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgoKey(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return dayKey(d);
}

const emptyBucket = (): Bucket => ({ songsByTitle: {}, songsByUrl: {}, users: {} });
const emptyDay = (): Day => ({ ...emptyBucket(), plays: 0 });

function loadStats(guildId: string): GuildStats {
  let stats = statsCache.get(guildId);
  if (!stats) statsCache.set(guildId, stats = { totals: emptyBucket(), daily: {} });
  return stats;
}

export async function loadAll(): Promise<{ guilds: number; counters: number }> {
  statsCache.clear();
  await pruneOldDays();

  const rows = await db.query<{ guild_id: string; period: string; kind: string; item_key: string; label: string | null; count: number }[]>(
    'SELECT guild_id, period, kind, item_key, label, count FROM stat_counters');
  for (const r of rows) {
    const stats = loadStats(r.guild_id);
    const day = r.period === TOTALS ? null : (stats.daily[r.period] ??= emptyDay());
    const bucket = day ?? stats.totals;
    if (r.kind === 'title')      bucket.songsByTitle[r.item_key] = r.count;
    else if (r.kind === 'url')   bucket.songsByUrl[r.item_key]   = { count: r.count, title: r.label || r.item_key };
    else if (r.kind === 'user')  bucket.users[r.item_key]        = { count: r.count, tag: r.label || r.item_key };
    else if (r.kind === 'plays' && day) day.plays = r.count;
  }
  return { guilds: statsCache.size, counters: rows.length };
}

async function pruneOldDays(): Promise<void> {
  await db.query('DELETE FROM stat_counters WHERE period <> ? AND period < ?', [TOTALS, daysAgoKey(MAX_DAYS)]);
}
setInterval(() => db.background(pruneOldDays(), 'prune old daily stats'), 6 * 60 * 60 * 1000).unref();

function counterRow(guildId: string, period: string, kind: string, key: string, label: string | null): SqlParam[] {
  const k = key.slice(0, 1024);
  return [guildId, period, kind, createHash('md5').update(k, 'utf8').digest(), k, label?.slice(0, 512) ?? null, 1];
}

/** Adds `src` counts into `dst` (for rollups). */
function addBucket(dst: Bucket, src: Bucket): void {
  for (const [t, c] of Object.entries(src.songsByTitle)) dst.songsByTitle[t] = (dst.songsByTitle[t] ?? 0) + c;
  for (const [u, v] of Object.entries(src.songsByUrl)) {
    (dst.songsByUrl[u] ??= { count: 0, title: v.title }).count += v.count;
  }
  for (const [id, v] of Object.entries(src.users)) {
    (dst.users[id] ??= { count: 0, tag: v.tag }).count += v.count;
  }
}

// ── Public API ────────────────────────────────────────────

export function recordPlay(guildId: string, p: { title?: string; uri?: string | null; userId?: string | null; userTag?: string | null }): void {
  tracksSinceBoot += 1;
  const { title, uri, userId, userTag } = p;

  const stats = loadStats(guildId);
  const today = dayKey(new Date());
  const daily = (stats.daily[today] ??= emptyDay());
  const rows: SqlParam[][] = [];

  for (const [bucket, period] of [[stats.totals, TOTALS], [daily, today]] as const) {
    if (title) {
      bucket.songsByTitle[title] = (bucket.songsByTitle[title] ?? 0) + 1;
      rows.push(counterRow(guildId, period, 'title', title, null));
    }
    if (uri) {
      (bucket.songsByUrl[uri] ??= { count: 0, title: title || uri }).count += 1;
      rows.push(counterRow(guildId, period, 'url', uri, title || uri));
    }
    if (userId) {
      (bucket.users[userId] ??= { count: 0, tag: userTag || userId }).count += 1;
      rows.push(counterRow(guildId, period, 'user', userId, userTag || userId));
    }
  }
  daily.plays += 1;
  rows.push(counterRow(guildId, today, 'plays', '', null));

  // drop days older than MAX_DAYS from the cache (the DB is pruned on a timer)
  const cutoff = daysAgoKey(MAX_DAYS);
  for (const k of Object.keys(stats.daily)) if (k < cutoff) delete stats.daily[k];

  db.background(
    db.query(`INSERT INTO stat_counters (guild_id, period, kind, key_hash, item_key, label, count) VALUES ?
              ON DUPLICATE KEY UPDATE count = count + VALUES(count), label = COALESCE(label, VALUES(label))`, [rows])
      .then(() => { lastWriteTime = new Date(); }),
    `record stats for guild ${guildId}`
  );
}

export function getGuildStatsRaw(guildId: string): GuildStats {
  return loadStats(guildId);
}

export function getStatsSnapshot(guildId: string): { totals: Bucket; today: Bucket; weekly: Bucket } {
  const stats  = loadStats(guildId);
  const weekly = emptyBucket();
  for (let i = 0; i < 7; i++) {
    const day = stats.daily[daysAgoKey(i)];
    if (day) addBucket(weekly, day);
  }
  return { totals: stats.totals, today: stats.daily[dayKey(new Date())] ?? emptyDay(), weekly };
}

export function getStatsMeta(): { tracksSinceBoot: number; lastWriteTime: Date | null } {
  return { tracksSinceBoot, lastWriteTime };
}

// ── Ranking helpers (used by stats_ui.ts) ─────────────────

export function topFromMap(map: Record<string, number>, limit = 3) {
  return Object.entries(map).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, limit);
}

export function topFromUrlMap(map: Bucket['songsByUrl'], limit = 3) {
  return Object.entries(map).map(([key, v]) => ({ key, count: v.count, title: v.title })).sort((a, b) => b.count - a.count).slice(0, limit);
}

export function topUsers(map: Bucket['users'], limit = 3) {
  return Object.entries(map).map(([id, v]) => ({ id, count: v.count, tag: v.tag })).sort((a, b) => b.count - a.count).slice(0, limit);
}
