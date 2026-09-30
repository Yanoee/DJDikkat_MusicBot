/************************************************************
 * DJ DIKKAT - Music Bot
 * Search engine
 * Link cleanup + "what did the user mean" ranking for /play
 * Build 5.2.0
 * Author: Yanoee
 ************************************************************/
import { LoadType } from 'shoukaku';
import type { LavalinkResponse, Track } from 'shoukaku';
import { isSpotifyUrl, resolveSpotifyTracks } from './spotify.ts';
import type { SpotifyTrackSpec } from './spotify.ts';
import { UserError, logError } from './errors.ts';

export type Resolver = (identifier: string) => Promise<LavalinkResponse | undefined>;

// ── Text ──────────────────────────────────────────────────────

/** Lowercase, accent-free, Turkish-aware: "Barış Manço" → "baris manco", "İZMİR" → "izmir". */
export function fold(text: string): string {
  return text.replace(/ı/g, 'i').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

// Apostrophes join rather than split: "İstanbul'da" → "istanbulda", "Don't" → "dont".
export const tokenize = (text: string): string[] =>
  fold(text).replace(/['’‘`´]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// Long words say more about a song than "in", "the", "be".
const weight = (word: string) => Math.min(word.length, 6);

// ── Links ─────────────────────────────────────────────────────

const TRACKING_PARAMS = ['si', 'feature', 'pp', 'ab_channel', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

/**
 * Returns a cleaned-up URL if the input is a link (with or without https://),
 * otherwise null. YouTube links to a video play that video only: the list /
 * mix it was opened from is dropped, so a Mix link doesn't queue 25 songs and
 * a playlist link with &index=3 doesn't start at track 1.
 */
export function normalizeLink(input: string): string | null {
  let text = input.trim();
  if (/\s/.test(text)) return null;
  if (!/^https?:\/\//i.test(text)) {
    if (!/^[\w-]+(\.[\w-]+)+\/\S*$/.test(text)) return null; // host.tld/path
    text = `https://${text}`;
  }
  let url: URL;
  try { url = new URL(text); } catch { return null; }

  for (const p of TRACKING_PARAMS) url.searchParams.delete(p);
  const host = url.hostname.toLowerCase();
  const youtube = host === 'youtu.be' || /(^|\.)youtube\.com$/.test(host);
  if (youtube) {
    if (host === 'm.youtube.com' || host === 'youtube.com') url.hostname = 'www.youtube.com';
    const singleVideo = url.searchParams.has('v') || host === 'youtu.be' || /^\/(shorts|live)\//.test(url.pathname);
    if (singleVideo) for (const p of ['list', 'index', 'start_radio', 'rv']) url.searchParams.delete(p);
  }
  return url.toString();
}

// ── Ranking ───────────────────────────────────────────────────

// Versions of a song: a version the query didn't ask for loses points.
const VARIANTS: [words: string[], penalty: number][] = [
  [['karaoke'], 8], [['nightcore'], 8], [['reaction'], 8], [['parody'], 8],
  [['remix', 'rmx'], 6], [['cover'], 6], [['slowed'], 6], [['sped'], 6], [['8d'], 6], [['instrumental'], 6],
  [['reverb'], 4], [['live', 'canli', 'concert', 'konser'], 4],
  [['acoustic', 'akustik', 'unplugged'], 3], [['lyrics', 'lyric', 'sozleri'], 1]
];
const WANTS_STREAM = ['radio', 'radyo', 'stream', '24'];
const WANTS_LONG = ['mix', 'album', 'full', 'hour', 'hours', 'saat', 'playlist', 'set', 'compilation'];

// Best match covers this much of the query (by word weight) → trust it.
const CONFIDENT = 0.7;
// Below this nothing is really a match; worth asking SoundCloud too.
const WEAK = 0.34;

type Source = 'ytm' | 'yt' | 'sc';
interface Candidate { track: Track; rank: number; source: Source }
export interface Scored { track: Track; score: number; coverage: number; source: Source }

/**
 * YouTube Music's own order is the strongest signal (its #1 is usually
 * right); coverage of the query's words, unwanted versions, odd lengths and —
 * for Spotify — the expected duration move a result up or down from there.
 */
export function rankCandidates(query: string, candidates: Candidate[], expectedMs?: number): Scored[] {
  const queryWords = new Set(tokenize(query));
  const total = [...queryWords].reduce((sum, w) => sum + weight(w), 0);
  const asked = (words: string[]) => words.some(w => queryWords.has(w));

  const scored = candidates.map(({ track, rank, source }): Scored => {
    const { title, author, length, isStream } = track.info;
    const titleWords = new Set(tokenize(title));
    const words = new Set([...titleWords, ...tokenize(author)]);
    const covered = [...queryWords].reduce((sum, w) => sum + (words.has(w) ? weight(w) : 0), 0);
    const coverage = total ? covered / total : 1;

    let score = coverage * 12 + 6 / (1 + rank * 0.5) + (source === 'ytm' ? 1 : 0);
    for (const [variant, penalty] of VARIANTS) {
      if (variant.some(w => titleWords.has(w)) && !asked(variant)) score -= penalty;
    }
    if (isStream || length === 0) {
      if (!asked(WANTS_STREAM) && !asked(['live', 'canli'])) score -= 8;
    } else if (length < 45_000) {
      score -= 4;
    } else if (length > 15 * 60_000 && !asked(WANTS_LONG)) {
      score -= 4;
    }
    if (expectedMs && length) {
      const diff = Math.abs(length - expectedMs);
      score += diff <= 3000 ? 5 : diff <= 10_000 ? 2 : diff > 30_000 ? -5 : 0;
    }
    return { track, score, coverage, source };
  });
  return scored.sort((a, b) => b.score - a.score);
}

export function tracksOf(res: LavalinkResponse | undefined): Track[] {
  if (!res) return [];
  switch (res.loadType) {
    case LoadType.TRACK:    return [res.data];
    case LoadType.SEARCH:   return res.data;
    // A playlist link that points at a track starts there, not at track 1.
    case LoadType.PLAYLIST: return res.data.tracks.slice(Math.max(0, res.data.info.selectedTrack));
    default:                return [];
  }
}

async function candidates(resolve: Resolver, prefix: string, query: string, source: Source): Promise<Candidate[]> {
  const res = await resolve(`${prefix}:${query}`).catch(() => undefined);
  return tracksOf(res).slice(0, 10).map((track, rank) => ({ track, rank, source }));
}

/** Pool without duplicate videos (YouTube Music and YouTube share IDs). */
function merge(...lists: Candidate[][]): Candidate[] {
  const seen = new Set<string>();
  return lists.flat().filter(c => !seen.has(c.track.info.identifier) && !!seen.add(c.track.info.identifier));
}

/** Best track for a text query: YouTube Music, then YouTube if unsure, then SoundCloud if still nothing fits. */
export async function searchText(resolve: Resolver, query: string, expectedMs?: number): Promise<Scored | null> {
  let pool = await candidates(resolve, 'ytmsearch', query, 'ytm');
  let best = rankCandidates(query, pool, expectedMs)[0];
  if (!best || best.coverage < CONFIDENT) {
    pool = merge(pool, await candidates(resolve, 'ytsearch', query, 'yt'));
    best = rankCandidates(query, pool, expectedMs)[0];
  }
  if (!best || best.coverage < WEAK) {
    pool = merge(pool, await candidates(resolve, 'scsearch', query, 'sc'));
    best = rankCandidates(query, pool, expectedMs)[0];
  }
  if (best) {
    const { title, author } = best.track.info;
    console.debug(`[SEARCH] "${query}" → "${title}" by ${author} (${best.source}, score=${best.score.toFixed(1)}, coverage=${best.coverage.toFixed(2)})`);
  }
  return best && best.coverage > 0 ? best : null;
}

/** Top YouTube Music matches, ranked — for /play suggestions. */
export async function suggest(resolve: Resolver, query: string, limit = 5): Promise<Track[]> {
  const pool = await candidates(resolve, 'ytmsearch', query, 'ytm');
  return rankCandidates(query, pool).slice(0, limit).map(s => s.track);
}

// ── /play entry point ─────────────────────────────────────────

export interface SearchResult { tracks: Track[]; liveWarning: boolean }

const SPOTIFY_CONCURRENCY = 5;

async function searchSpotify(resolve: Resolver, url: string, room: number, guildId: string): Promise<Track[]> {
  let specs: SpotifyTrackSpec[];
  try {
    specs = await resolveSpotifyTracks(url, room);
  } catch (err) {
    const appErr = logError(err, { guildId });
    throw new UserError(`❌ Spotify error (ref: ${appErr.ref}). Try again in a moment, or paste a direct YouTube link instead.`);
  }
  if (!specs.length) throw new UserError('❌ No Spotify tracks found');

  const tracks: Track[] = [];
  for (let i = 0; i < specs.length; i += SPOTIFY_CONCURRENCY) {
    const batch = await Promise.all(specs.slice(i, i + SPOTIFY_CONCURRENCY)
      .map(s => searchText(resolve, `${s.artist} ${s.title}`, s.durationMs)));
    for (const hit of batch) if (hit) tracks.push(hit.track);
  }
  return tracks;
}

async function loadLink(resolve: Resolver, url: string): Promise<Track[]> {
  const res = await resolve(url);
  // A bare identifier NodeLink doesn't recognise is searched as text — for a
  // link that would play something random, so treat it as unsupported.
  if (!res || res.loadType === LoadType.SEARCH) throw new UserError('❌ That link isn\'t supported. Paste a YouTube, Spotify, SoundCloud or Deezer link, or search by name.');
  if (res.loadType === LoadType.EMPTY) throw new UserError('❌ Nothing playable found at that link.');
  if (res.loadType === LoadType.ERROR) {
    if (/youtu/.test(new URL(url).hostname)) throw new UserError('❌ That video is unavailable (private, deleted, age- or region-restricted).');
    // NodeLink sends the reason as `exception`, Lavalink as `data`.
    const reason = (res.data ?? (res as { exception?: { message?: string } }).exception)?.message;
    throw new UserError(`❌ Couldn't load that link${reason ? ` (${reason})` : ''}. The site may not be supported.`);
  }
  return tracksOf(res);
}

/** Resolves a /play query to tracks. `room` = how many the queue can still take. */
export async function search(resolve: Resolver, query: string, room: number, guildId: string): Promise<SearchResult> {
  const link = normalizeLink(query);
  if (link && isSpotifyUrl(link)) return { tracks: await searchSpotify(resolve, link, room, guildId), liveWarning: false };
  if (link) return { tracks: await loadLink(resolve, link), liveWarning: false };

  const best = await searchText(resolve, query);
  if (!best) return { tracks: [], liveWarning: false };
  const { isStream, length } = best.track.info;
  const words = new Set(tokenize(query));
  const liveWarning = (isStream || length === 0) && !['live', 'stream', 'canli', 'radio', 'radyo'].some(w => words.has(w));
  return { tracks: [best.track], liveWarning };
}
