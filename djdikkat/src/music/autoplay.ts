/************************************************************
 * DJ DIKKAT - Music Bot
 * Autoplay
 * When the queue runs out, a few songs like the ones people
 * asked for lately. Seeds are only songs a person queued
 * (pickSeeds), never autoplay's own picks, so a session can't
 * drift one hop further with every batch.
 * For each seed we ask several recommendation lists at once,
 * the seed's "home" service first: YouTube Music's radio and
 * YouTube's own Mix for YouTube songs, Spotify's mix for
 * Spotify songs. A song is only looked up on the other service
 * when the search hit really is that song (matchScore), since
 * a wrong first hit (an OST track → "Soviet March") is what
 * used to send autoplay off into the weeds.
 * Every candidate is then scored against the seeds (same
 * artist, shared title words, how many lists agree, length)
 * and penalised for what the server skipped lately or for
 * versions nobody asked for (nightcore, 1 hour loops, ...).
 * Author: Yanoee
 ************************************************************/
import type { Track } from 'shoukaku';
import { fold, matchScore, tracksOf } from './search.ts';
import type { Resolver } from './search.ts';
import type { QueueTrack } from '../lib/types.ts';

export const AUTOPLAY_BATCH = 3;

// ── Text helpers (pure, exported for tests) ──────────────────

// Same word split as search.ts: apostrophes join ("Yuri's" → "yuris").
const tokens = (text: string): string[] =>
  fold(text).replace(/['’‘`´]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// Words that say nothing about which song it is: upload decoration and glue.
const STOPWORDS = new Set([
  'official', 'video', 'audio', 'lyrics', 'lyric', 'hd', 'hq', '4k', '1080p', '720p', 'remastered', 'remaster', 'master',
  'feat', 'ft', 'featuring', 'prod', 'music', 'musica', 'musik', 'muzik', 'mv', 'version', 'edit', 'original', 'full',
  'extended', 'visualizer', 'visualiser', 'topic', 'vevo', 'explicit', 'clean', 'remix', 'mix', 'live', 'new', 'from',
  'with', 'subs', 'sub', 'track', 'song', 'single', 'album', 'sozleri', 'klip', 'akustik', 'cover', 'records',
  'the', 'and', 'for', 'you', 'your', 'are', 'was', 'not', 'but', 'all', 'this', 'that', 'its', 'our', 'out',
  'bir', 'ile', 'ben', 'sen', 'gibi', 'icin', 'der', 'die', 'das', 'und', 'les', 'del', 'los', 'las', 'una', 'que'
]);
// Genre markers. "OST" in two titles only says "both are game/film music", not
// "same game", so these are a small separate bonus, never distinctive words
// (and never put in the avoid set: skipping one OST mustn't ban every OST).
const GENRE_WORDS = new Set(['ost', 'soundtrack', 'soundtracks', 'theme', 'score', 'bgm', 'opening', 'ending', 'anime', 'instrumental', 'orchestral', 'game']);

// Versions people rarely want unless the seed already is one.
const VARIANTS: [kind: string, re: RegExp][] = [
  ['cover', /\bcover\b/], ['karaoke', /\bkaraoke\b/], ['8d', /\b8d\b/], ['slowed', /\bslowed\b/],
  ['nightcore', /\bnightcore\b/], ['sped', /\bsped\s*up\b/], ['reverb', /\breverb\b/],
  ['hours', /\b(\d+|one|two|ten)\s*(hours?|hrs?|saat)\b/], ['loop', /\bloop(ed)?\b/]
];

/** Which unwanted versions (cover, nightcore, 1 hour, ...) a title says it is. */
export function variantsOf(title: string): Set<string> {
  const text = fold(title);
  return new Set(VARIANTS.filter(([, re]) => re.test(text)).map(([kind]) => kind));
}

const squash = (text: string) => tokens(text).join('');

/**
 * Artist keys of a track, folded and space-free so "DuaLipaVEVO", "Dua Lipa -
 * Topic" and "Dua Lipa" agree; "Calvin Harris, Dua Lipa" gives both.
 */
export function artistKeys(author: string): string[] {
  const parts = author
    .replace(/\s*-\s*topic\s*$/i, '').replace(/vevo\s*$/i, '').replace(/\s*official\s*$/i, '')
    .split(/\s*(?:,|&|\+|\/|;|\s+x\s+|\bfeat\b\.?|\bft\b\.?|\bwith\b|\band\b)\s*/i);
  return [...new Set(parts.map(squash).filter(k => k.length >= 2))];
}

const NOISE_BRACKET = /\b(official|video|audio|lyrics?|hd|hq|4k|remaster(ed)?|visuali[sz]er|mv|explicit|clean|feat|ft|featuring|with|from|prod|sozleri|klip|subs?|1080p|720p)\b/i;

/**
 * The song name a title is about: noise brackets ("(Official Video)",
 * "[HD]", "(feat. X)"), a trailing "ft. X", Spotify's " - Remastered 2011" and
 * an "Artist - " prefix (when it is the author) removed. Not folded.
 */
export function cleanTitle(title: string, author = ''): string {
  let text = title.replace(/[([{【]([^)\]}】]*)[)\]}】]/g, (whole, inner: string) => (NOISE_BRACKET.test(inner) ? ' ' : whole));
  text = text.replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, '');
  const parts = text.split(/\s+[-–—|]\s+/);
  if (parts.length > 1 && author) {
    const artists = artistKeys(author);
    const head = squash(parts[0]!);
    if (head && artists.some(a => head === a || (Math.min(a.length, head.length) >= 4 && (head.includes(a) || a.includes(head))))) parts.shift();
  }
  // Spotify style suffix: "Song - Remastered 2011", "Song - From Barbie The Album", "Song - Live".
  while (parts.length > 1 && /\b(remaster(ed)?|version|edit|from|live|mono|stereo|mix)\b/i.test(parts.at(-1)!)) parts.pop();
  const out = parts.join(' - ').replace(/\s+/g, ' ').trim();
  return out || title.trim();
}

/**
 * Distinctive title words: folded, without stopwords, genre words, numbers,
 * words shorter than 3 letters and the artist's own name. "Red Alert 2 -
 * Yuri's Revenge Music - Drok" → red, alert, yuris, revenge, drok.
 */
export function titleWords(title: string, author = ''): Set<string> {
  const own = new Set(tokens(author));
  return new Set(tokens(cleanTitle(title, author))
    .filter(w => w.length >= 3 && !/^\d+$/.test(w) && !STOPWORDS.has(w) && !GENRE_WORDS.has(w) && !own.has(w)));
}

const hasGenre = (title: string) => tokens(title).some(w => GENRE_WORDS.has(w));

/**
 * Title + artist, folded, decoration removed, so the same song from another
 * source still counts as played ("Sezen Aksu - Gülümse (Official Video)" by
 * Sezen Aksu and Spotify's "Gülümse" give the same key).
 */
export const songKey = (title: string, author = '') =>
  `${tokens(cleanTitle(title, author)).join(' ')}|${artistKeys(author)[0] ?? ''}`;

/**
 * Every key a track can be "played" under, for building and checking the
 * played set. History keeps titles only, so the title alone (and, for YouTube
 * uploads, "Artist - Title") count too.
 */
export function playedKeys(title: string, author = '', uri?: string | null): string[] {
  const keys = [songKey(title, author), songKey(title), songKey(cleanTitle(title, author)), ...coreKeys(title, author)];
  if (author) keys.push(songKey(`${author} - ${cleanTitle(title, author)}`));
  if (uri) keys.push(uri);
  return [...new Set(keys)];
}

/**
 * "Song core" keys: the title's last " - " / ": " part (track number like
 * "07." and "Re-Master" removed) paired with each distinctive word of the rest.
 * Fan uploads of soundtracks put the uploader in `author`, so songKey can't
 * see that "Command & Conquer Red Alert 2 - Yuri's Revenge Expansion Music -
 * Trance L. Vania" (medalex195) and "Command & Conquer: Red Alert 2 Yuri's
 * Revenge - 07. Trance L. Vania (Re-Master, HD/HQ)" (Repulsive Music) are one
 * song; they share core "trance l vania" + "red". A title with no context part
 * gives none, so two unrelated songs both called "Tension" never collide.
 */
export function coreKeys(title: string, author = ''): string[] {
  const parts = cleanTitle(title, author).split(/\s+[-–—|]\s+|:\s+/);
  if (parts.length < 2) return [];
  const last = parts.pop()!
    .replace(/^\s*(?:track\s*)?\d{1,3}\s*(?:[.):-]\s*|\s+)/i, '')
    .replace(/\bre-?master(ed)?\b/gi, ' ');
  const core = tokens(last);
  if (core.join('').length < 3 || core.every(w => /^\d+$/.test(w))) return [];
  const context = [...titleWords(parts.join(' '))].filter(w => !core.includes(w));
  return context.map(w => `core:${core.join(' ')}~${w}`);
}

// ── Seeds ────────────────────────────────────────────────────

export interface SeedEntry { track: QueueTrack; at: number }
export interface Seed { track: Track; weight: number }

const SESSION_MS = 30 * 60_000;
const SEED_WEIGHTS = [1, 0.6, 0.35];

/**
 * Pure. Newest people-requested songs of this listening session: max 3 from
 * the last 30 min, newest first (weights 1, 0.6, 0.35); none in 30 min → just
 * the newest one; none → []. The same song requested twice counts once.
 */
export function pickSeeds(requested: SeedEntry[], now: number): Seed[] {
  const newest = [...requested].sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  const distinct = newest.filter(e => {
    const key = songKey(e.track.info.title, e.track.info.author);
    return !seen.has(key) && !!seen.add(key);
  });
  const recent = distinct.filter(e => now - e.at <= SESSION_MS).slice(0, SEED_WEIGHTS.length);
  const chosen = recent.length ? recent : distinct.slice(0, 1);
  return chosen.map((e, i) => ({ track: e.track, weight: SEED_WEIGHTS[i]! }));
}

// ── Avoid set (songs skipped / removed lately) ───────────────

export interface Avoid { artists: Set<string>; words: Set<string> }

const AVOID_MS = 60 * 60_000;
const AVOID_CAP = 30;
const rejected = new Map<string, { artists: string[]; words: string[]; at: number }[]>();

/** An autoplay pick was skipped right away or removed: steer away from its artist and title for an hour. */
export function noteRejected(guildId: string, track: Track, now = Date.now()): void {
  const list = (rejected.get(guildId) ?? []).filter(e => now - e.at < AVOID_MS);
  list.unshift({ artists: artistKeys(track.info.author), words: [...titleWords(track.info.title, track.info.author)], at: now });
  rejected.set(guildId, list.slice(0, AVOID_CAP));
}

/** What this server rejected in the last hour. */
export function avoidFor(guildId: string, now = Date.now()): Avoid {
  const list = (rejected.get(guildId) ?? []).filter(e => now - e.at < AVOID_MS);
  if (list.length) rejected.set(guildId, list); else rejected.delete(guildId);
  return { artists: new Set(list.flatMap(e => e.artists)), words: new Set(list.flatMap(e => e.words)) };
}

// ── Scoring (pure, exported for tests) ───────────────────────

/** One place a candidate showed up: which seed's list, at which rank. */
export interface Hit { seed: number; list: string; rank: number; primary: boolean }
export interface Scored { score: number; seed: number; related: boolean }

// Weights inside a seed's relevance (0..1).
const BASE = 0.25;        // being recommended for the seed at all
const W_ARTIST = 0.3;     // same artist/channel (half for the artist named in the title)
const W_WORDS = 0.3;      // shared distinctive title words, by word length
const W_GENRE = 0.05;     // both are OST/theme/... music
const W_RANK = 0.2;       // near the top of the list (secondary lists count 0.75)
// Outside the seed weight.
const W_DURATION = 0.1;   // as long as the seeds typically are
const W_LISTS = 0.12;     // per extra list it appears in, max 2 extra
/** Picks need at least this; below it only "related" songs are used as a fallback. */
export const PASS_SCORE = 0.45;
/** Last resort when nothing related came back: one song, if it reaches this. */
export const LOW_SCORE = 0.2;

const wordWeight = (words: Iterable<string>) => [...words].reduce((sum, w) => sum + Math.min(w.length, 6), 0);
const shared = (a: Set<string>, b: Set<string>) => [...a].filter(w => b.has(w));

function artistMatch(track: Track, seed: Track): number {
  const mine = artistKeys(track.info.author);
  const theirs = artistKeys(seed.info.author);
  if (mine.some(a => theirs.includes(a))) return 1;
  // "Frank Klepacki - Hell March" uploaded by a fan channel, or "X ft. Seed Artist".
  const myTitle = squash(track.info.title);
  const seedTitle = squash(seed.info.title);
  if (theirs.some(a => a.length >= 4 && myTitle.includes(a)) || mine.some(a => a.length >= 4 && seedTitle.includes(a))) return 0.5;
  return 0;
}

const median = (values: number[]) => {
  const sorted = values.filter(v => v > 0).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
};

/**
 * Pure. How good `track` is as a follow-up to `seeds`, given where it was
 * found (`hits`). For each hit: seed weight × (BASE + artist + words + genre +
 * rank); the best hit counts, then + duration closeness (× that seed's
 * weight) + agreement between lists, minus penalties: avoid-set artist (0.4)
 * and words (0.15 each, max 0.3), over 15 min unless a seed is over 10 min
 * (0.5), under 40 s (0.3), an unwanted version (0.5). Live streams score -1.
 * `related`: shares an artist or a distinctive word with some seed.
 */
export function scoreCandidate(track: Track, hits: Hit[], seeds: Seed[], avoid?: Avoid): Scored {
  const { title, author, length, isStream } = track.info;
  if (isStream || !hits.length) return { score: -1, seed: hits[0]?.seed ?? 0, related: false };
  const words = titleWords(title, author);
  const genre = hasGenre(title);

  let best = -Infinity;
  let bestSeed = hits[0]!.seed;
  let related = false;
  for (const hit of hits) {
    const seed = seeds[hit.seed];
    if (!seed) continue;
    const artist = artistMatch(track, seed.track);
    const common = shared(words, titleWords(seed.track.info.title, seed.track.info.author));
    if (artist > 0 || common.length) related = true;
    const rel = BASE + W_ARTIST * artist + W_WORDS * Math.min(1, wordWeight(common) / 10)
      + (genre && hasGenre(seed.track.info.title) ? W_GENRE : 0)
      + W_RANK * (hit.primary ? 1 : 0.75) / (1 + hit.rank / 8);
    if (seed.weight * rel > best) { best = seed.weight * rel; bestSeed = hit.seed; }
  }
  if (best === -Infinity) return { score: -1, seed: bestSeed, related: false };

  let score = best;
  const typical = median(seeds.map(s => s.track.info.length));
  if (typical && length) {
    const ratio = length / typical;
    const near = ratio >= 0.6 && ratio <= 1.6 ? 1 : ratio >= 0.4 && ratio <= 2.5 ? 0.3 : 0;
    score += W_DURATION * near * (seeds[bestSeed]?.weight ?? 1);
  }
  const lists = new Set(hits.map(h => `${h.seed}:${h.list}`)).size;
  score += W_LISTS * Math.min(2, lists - 1);

  if (avoid) {
    if (artistKeys(author).some(a => avoid.artists.has(a))) score -= 0.4;
    score -= Math.min(0.3, 0.15 * [...words].filter(w => avoid.words.has(w)).length);
  }
  const seedLong = seeds.some(s => s.track.info.length > 10 * 60_000);
  if (length > 15 * 60_000 && !seedLong) score -= 0.5;
  if (length > 0 && length < 40_000 && !seeds.some(s => s.track.info.length && s.track.info.length < 60_000)) score -= 0.3;
  const seedVariants = new Set(seeds.flatMap(s => [...variantsOf(s.track.info.title)]));
  if ([...variantsOf(title)].some(v => !seedVariants.has(v))) score -= 0.5;
  return { score, seed: bestSeed, related };
}

/**
 * Pure. The first `count` items (already best-first), at most one per artist
 * when there are enough different artists, never more than two. Every credited
 * artist counts, so "Cold Heart" (Elton John, Dua Lipa) after a Dua Lipa song
 * is a second Dua Lipa song.
 */
export function diversify<T extends { track: Track }>(items: T[], count: number): T[] {
  const out: T[] = [];
  const perArtist = new Map<string, number>();
  const artistsOf = (item: T) => {
    const keys = artistKeys(item.track.info.author);
    return keys.length ? keys : [squash(item.track.info.author)];
  };
  for (const cap of [1, 2]) {
    for (const item of items) {
      if (out.length >= count) return out;
      if (out.includes(item)) continue;
      const artists = artistsOf(item);
      if (artists.some(a => (perArtist.get(a) ?? 0) >= cap)) continue;
      out.push(item);
      for (const a of artists) perArtist.set(a, (perArtist.get(a) ?? 0) + 1);
    }
  }
  return out;
}

// ── Sources ──────────────────────────────────────────────────

const CALL_MS = 3000;      // one NodeLink call
const TOTAL_MS = 5500;     // the whole look-up, incl. a search + recs chain
const MATCH_MIN = 0.6;     // a search hit must really be the seed song to borrow its recs
const MAP_CANDIDATES = 5;

interface SourceResult { name: string; seed: number; primary: boolean; tracks: Track[]; note: string }

const isYouTube = (track: Track) => /^(youtube|ytmusic)$/.test(track.info.sourceName);
const videoId = (track: Track) => (isYouTube(track) && /^[\w-]{11}$/.test(track.info.identifier) ? track.info.identifier : null);

/**
 * Pure (exported for tests). The recommendation lists to ask for a seed, home
 * service first. Only the newest seed asks the secondary ones (load + time).
 */
export function sourcePlan(seed: Track, first: boolean): { name: string; primary: boolean }[] {
  const yt = [{ name: 'ytrec', primary: true }, { name: 'ytmix', primary: true }];
  if (isYouTube(seed)) return first ? [...yt, { name: 'sprec', primary: false }] : yt;
  if (seed.info.sourceName === 'spotify') return first ? [{ name: 'sprec', primary: true }, { name: 'ytrec', primary: false }] : [{ name: 'sprec', primary: true }];
  return first ? [...yt, { name: 'sprec', primary: true }] : [{ name: 'ytrec', primary: true }, { name: 'sprec', primary: true }];
}

export interface PickOptions { count?: number; avoid?: Avoid; guildId?: string }
export interface AutoplayPick { track: Track; seed: Track; score: number }

/**
 * Up to `count` songs like `seeds` (from pickSeeds) that aren't in `played`
 * (playedKeys / songKey keys and links of what this server played lately).
 * Never throws; [] when nothing at all came back.
 */
export async function pickSimilar(resolve: Resolver, seeds: Seed[], played: Set<string>, opts: PickOptions = {}): Promise<AutoplayPick[]> {
  const count = opts.count ?? AUTOPLAY_BATCH;
  const avoid = opts.avoid ?? (opts.guildId ? avoidFor(opts.guildId) : undefined);
  if (!seeds.length) return [];
  const deadline = Date.now() + TOTAL_MS;

  const load = async (identifier: string): Promise<Track[] | null> => {
    const ms = Math.min(CALL_MS, deadline - Date.now());
    if (ms <= 0) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>(done => { timer = setTimeout(() => done(null), ms); });
    try {
      return await Promise.race([resolve(identifier).then(tracksOf, () => []), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  // The seed's song on another service, only when the hit really is that song.
  // ytrec and ytmix of a non-YouTube seed need the same ytmsearch: ask NodeLink once.
  const mapped = new Map<string, Promise<{ id: string | null; note: string }>>();
  const mapTo = (prefix: 'spsearch' | 'ytmsearch', seed: Track) => {
    const key = `${prefix}:${seed.encoded}`;
    if (!mapped.has(key)) mapped.set(key, mapSearch(prefix, seed));
    return mapped.get(key)!;
  };
  const mapSearch = async (prefix: 'spsearch' | 'ytmsearch', seed: Track): Promise<{ id: string | null; note: string }> => {
    const title = cleanTitle(seed.info.title, seed.info.author);
    const hits = await load(`${prefix}:${seed.info.author} ${title}`);
    if (!hits) return { id: null, note: 'timeout' };
    const spec = { title, artist: seed.info.author, durationMs: seed.info.length || undefined };
    let best: { track: Track; score: number } | null = null;
    for (const track of hits.slice(0, MAP_CANDIDATES)) {
      const score = matchScore(spec, track);
      if (!best || score > best.score) best = { track, score };
    }
    return best && best.score >= MATCH_MIN ? { id: best.track.info.identifier, note: '' } : { id: null, note: `nomatch ${best ? best.score.toFixed(2) : '-'}` };
  };

  const ask = async (seed: Track, seedIndex: number, name: string, primary: boolean): Promise<SourceResult> => {
    const result = (tracks: Track[] | null, note = '') => ({ name, seed: seedIndex, primary, tracks: tracks ?? [], note: tracks ? note : note || 'timeout' });
    if (name === 'sprec') {
      // NodeLink's sprec uses only the first id, so one call per seed.
      const mapped = seed.info.sourceName === 'spotify' ? { id: seed.info.identifier, note: '' } : await mapTo('spsearch', seed);
      return mapped.id ? result(await load(`sprec:seed_tracks=${mapped.id}`)) : result([], mapped.note);
    }
    let id = videoId(seed);
    if (!id) {
      const mapped = await mapTo('ytmsearch', seed);
      if (!mapped.id) return result([], mapped.note);
      id = mapped.id;
    }
    // ytrec = YouTube Music radio; ytmix = youtube.com's Mix, which stays closer to game/film music.
    return result(await load(name === 'ytrec' ? `ytrec:${id}` : `https://www.youtube.com/watch?v=${id}&list=RD${id}`));
  };

  const results = await Promise.all(seeds.flatMap((s, i) =>
    sourcePlan(s.track, i === 0).map(p => ask(s.track, i, p.name, p.primary).catch(() => ({ name: p.name, seed: i, primary: p.primary, tracks: [], note: 'error' })))));

  // Pool: one entry per song (same video, or same title + artist from another service).
  const seedKeys = new Set(seeds.flatMap(s => playedKeys(s.track.info.title, s.track.info.author, s.track.info.uri)));
  const pool = new Map<string, { track: Track; hits: Hit[] }>();
  const byId = new Map<string, string>();
  const byCore = new Map<string, string>();
  const SOURCE_RANK: Record<string, number> = { ytmusic: 0, youtube: 1, spotify: 2 };
  for (const r of results) {
    r.tracks.forEach((track, rank) => {
      const { title, author, uri, identifier } = track.info;
      if (!uri || track.info.isStream) return;
      const keys = playedKeys(title, author, uri);
      if (keys.some(k => played.has(k) || seedKeys.has(k))) return;
      // Same song from another uploader ("... - 08. Deceiver (Re-Master)") joins the first one's entry.
      const cores = keys.filter(k => k.startsWith('core:'));
      const key = byId.get(identifier) ?? cores.map(k => byCore.get(k)).find(Boolean) ?? songKey(title, author);
      byId.set(identifier, key);
      for (const k of cores) if (!byCore.has(k)) byCore.set(k, key);
      const entry = pool.get(key);
      const hit = { seed: r.seed, list: r.name, rank, primary: r.primary };
      if (!entry) { pool.set(key, { track, hits: [hit] }); return; }
      entry.hits.push(hit);
      // Prefer a version that plays directly (YouTube Music, YouTube) over a mirrored one.
      if ((SOURCE_RANK[track.info.sourceName] ?? 9) < (SOURCE_RANK[entry.track.info.sourceName] ?? 9)) entry.track = track;
    });
  }

  const scored = [...pool.values()]
    .map(c => ({ track: c.track, ...scoreCandidate(c.track, c.hits, seeds, avoid) }))
    .filter(c => c.score > -1)
    .sort((a, b) => b.score - a.score);
  let chosen = diversify(scored.filter(c => c.score >= PASS_SCORE), count);
  let mode = 'ok';
  if (!chosen.length) {
    // Nothing convincing: songs at least related to a seed, else the single best
    // one with a low bar. Autoplay's job is to keep the music going.
    chosen = diversify(scored.filter(c => c.related && c.score >= LOW_SCORE), count);
    mode = 'related';
    if (!chosen.length) { chosen = scored.filter(c => c.score >= LOW_SCORE).slice(0, 1); mode = 'lowbar'; }
  }
  const picks = chosen.map(c => ({ track: c.track, seed: seeds[c.seed]!.track, score: Number(c.score.toFixed(3)) }));

  const short = (text: string) => (text.length > 40 ? `${text.slice(0, 39)}…` : text);
  console.debug(`[AUTOPLAY] seeds: ${seeds.map(s => `"${short(s.track.info.title)}"×${s.weight}`).join(' ')}`
    + ` | sources: ${results.map(r => `${r.seed}:${r.name}=${r.tracks.length}${r.note ? `(${r.note})` : ''}`).join(' ')}`
    + ` | pool ${scored.length} | ${mode} | picks: ${picks.map(p => `"${short(p.track.info.title)}" by ${short(p.track.info.author)} ${p.score.toFixed(2)}`).join(', ') || 'none'}`);
  return picks;
}
