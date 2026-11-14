/************************************************************
 * DJ DIKKAT - Music Bot
 * Search engine
 * Link cleanup + "what did the user mean" ranking for /play
 * Author: Yanoee
 ************************************************************/
import { LoadType } from 'shoukaku';
import type { LavalinkResponse, Track } from 'shoukaku';
import { followShortLink, isSpotifyUrl, resolveSpotifyTracks } from './spotify.ts';
import type { SpotifyTrackSpec } from './spotify.ts';
import { UserError, logError } from '../lib/errors.ts';

export type Resolver = (identifier: string) => Promise<LavalinkResponse | undefined>;

// ── Text ──────────────────────────────────────────────────────

/** Lowercase, accent-free, Turkish-aware: "Barış Manço" → "baris manco", "İZMİR" → "izmir". */
export function fold(text: string): string {
  return text.replace(/ı/g, 'i').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

// Apostrophes join rather than split: "İstanbul'da" → "istanbulda", "Don't" → "dont".
const tokenize = (text: string): string[] =>
  fold(text).replace(/['’‘`´]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// Long words say more about a song than "in", "the", "be".
const weight = (word: string) => Math.min(word.length, 6);

/** Typing slips between two words (insert, delete, change, swap neighbours), capped at 2. */
function slips(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j]!, before[j - 2]! + 1);
    }
    before = prev;
    prev = row;
  }
  return Math.min(prev[b.length]!, 2);
}

// A long word one slip away still counts ("bohemain rapsody" → Bohemian
// Rhapsody), but less than an exact match, so a title that copies the typo
// doesn't beat the real song.
const TYPO_CREDIT = 0.8;

function matchCredit(word: string, words: Set<string>): number {
  if (words.has(word)) return 1;
  if (word.length < 5) return 0;
  for (const w of words) if (w.length >= 5 && slips(word, w) <= 1) return TYPO_CREDIT;
  return 0;
}

// Longer than any real song query; keeps YouTube's search and the typo
// matcher (which compares every word with every result) cheap.
const MAX_QUERY = 200;
// NodeLink reads "name:rest" as "search `rest` with source `name`". Our own
// prefix always comes first, but a typed "ytsearch:" / "sprec:" / "local:"
// would be searched as literal words, so it's dropped. NodeLink's own source
// names only (3.10's searchTerms / recommendationTerm), so a title like
// "Research: …" or "Speak: …" keeps its first word.
const TYPED_PREFIX = new RegExp('^(?:(?:ytm?|sc|sp|am|az|au|bc|bili|bk|dz|gd|gn|gaana|ih|js|lf|lm|mc|nc|nt|qb|sh|sz|sl|td|vk|ym)search'
  + '|(?:yt|sp|dz|js|lm|qb|td|vk|ym)rec|(?:dz|qb)?isrc|spsuggest|spsimilar|f?tts|gtts|pipertts|lazy(?:py)?tts|local)\\s*:\\s*', 'i');
// Invisible and control characters (zero-width spaces, bidi marks, newlines).
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g;

/**
 * A text query as it's sent to the sources: one line, single spaces, no typed
 * source prefix or leading "/" (NodeLink rejects a query starting with "/"),
 * at most 200 characters, cut at a word.
 */
export function cleanQuery(input: string): string {
  // Joiners sit inside words (Persian, Indic scripts, emoji sequences): dropped, not turned into a word break.
  let text = input.replace(/[‌‍]/g, '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const next = text.replace(/^\/+(?:play\b)?\s*/i, '').replace(TYPED_PREFIX, '').trim();
    if (next === text) break;
    text = next;
  }
  const chars = [...text]; // by code point, so an emoji isn't cut in half
  if (chars.length > MAX_QUERY) {
    text = chars.slice(0, MAX_QUERY).join('');
    const space = text.lastIndexOf(' ');
    if (space > MAX_QUERY / 2) text = text.slice(0, space);
  }
  return text;
}

// ── Links ─────────────────────────────────────────────────────

const TRACKING_PARAMS = ['si', 'feature', 'pp', 'ab_channel', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

// Discord's "no preview" form of a link: <https://…>
const unwrap = (input: string) => input.trim().replace(/^<(\S+)>$/, '$1');

/**
 * Returns a cleaned-up URL if the input is a link (with or without https://),
 * otherwise null. YouTube links to a video play that video only: the list /
 * mix it was opened from is dropped, so a Mix link doesn't queue 25 songs and
 * a playlist link with &index=3 doesn't start at track 1. Only ever returns an
 * http(s) link, so a typed identifier can't reach another NodeLink source.
 */
export function normalizeLink(input: string): string | null {
  let text = unwrap(input);
  if (/\s/.test(text)) return null;
  // Spotify app's "Copy URI": spotify:track:ID → its open.spotify.com link
  const uri = text.match(/^spotify:(track|album|playlist|artist):(\w+)$/i);
  if (uri) return `https://open.spotify.com/${uri[1]!.toLowerCase()}/${uri[2]}`;
  if (!/^https?:\/\//i.test(text)) {
    if (!/^[\w-]+(\.[\w-]+)+\/\S*$/.test(text)) return null; // host.tld/path
    text = `https://${text}`;
  }
  let url: URL;
  try { url = new URL(text); } catch { return null; }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  for (const p of TRACKING_PARAMS) url.searchParams.delete(p);
  url.hash = '';
  // "soundcloud.com/artist/song/" doesn't match NodeLink's link patterns; without the slash it does.
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  const host = url.hostname.toLowerCase();
  const youtube = host === 'youtu.be' || /(^|\.)youtube(-nocookie)?\.com$/.test(host);
  if (youtube) {
    if (host !== 'youtu.be' && host !== 'music.youtube.com') url.hostname = 'www.youtube.com';
    // NodeLink only knows watch?v=ID as the *first* parameter (not watch?app=desktop&v=ID),
    // and no embed links: rebuild the plain form.
    // A video id is 11 characters; /embed/videoseries?list=… and /embed/live_stream?channel=… are not videos.
    const embed = url.pathname.match(/^\/(?:embed|v|e)\/([\w-]{11})$/);
    const embedId = embed && embed[1] !== 'videoseries' && embed[1] !== 'live_stream' ? embed[1] : null;
    const video = embedId ?? (url.pathname === '/watch' ? url.searchParams.get('v') : null);
    const list = url.searchParams.get('list');
    if (video) {
      url.pathname = '/watch';
      url.search = `?v=${encodeURIComponent(video)}`;
    } else if (host === 'youtu.be' || /^\/(shorts|live)\//.test(url.pathname)) {
      url.search = '';
    } else if (['/playlist', '/watch', '/embed/videoseries'].includes(url.pathname) && list) {
      url.pathname = '/playlist';
      url.search = `?list=${encodeURIComponent(list)}`;
    }
  }
  return url.toString();
}

/** What a playlist import reads, or why it can't. */
export type PlaylistLink = { url: string; mix: boolean } | { error: 'import_private' | 'import_failed' };

// Short links that only redirect to the real playlist page.
const SHORT_HOSTS = new Set(['spotify.link', 'spotify.app.link', 'on.soundcloud.com', 'soundcloud.app.goo.gl']);
// Where those may lead: the playlist pages themselves.
const SHORT_TARGETS = new Set(['open.spotify.com', 'play.spotify.com', 'soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com']);
// YouTube's own lists that only their owner can see: Liked videos, Watch later, Liked music.
const PRIVATE_LISTS = new Set(['LL', 'WL', 'LM']);

/**
 * A link for playlist import (unlike normalizeLink, a video link's `&list=` is the point):
 * YouTube / YouTube Music watch, youtu.be and playlist links become the plain playlist page,
 * spotify:playlist:/album: codes become links, and short links are followed to the real page.
 */
export async function playlistLink(input: string): Promise<PlaylistLink> {
  const text = unwrap(input);
  const code = text.match(/^spotify:(playlist|album|track|artist):(\w+)$/i);
  let link = code ? `https://open.spotify.com/${code[1]!.toLowerCase()}/${code[2]}` : normalizeLink(text);
  let url: URL;
  try { url = new URL(code ? link! : /^https?:\/\//i.test(text) ? text : `https://${text}`); } catch { return { error: 'import_failed' }; }

  if (SHORT_HOSTS.has(url.hostname.toLowerCase())) {
    // Hop by hop, never off these hosts: a redirect can't send the server to an internal or arbitrary address.
    const target = await followShortLink(url, SHORT_HOSTS, SHORT_TARGETS);
    if (!target) return { error: 'import_failed' };
    url = target;
    link = normalizeLink(target.href);
  }

  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be' || /(^|\.)youtube\.com$/.test(host)) {
    const list = url.searchParams.get('list');
    if (!list) return link ? { url: link, mix: false } : { error: 'import_failed' };
    if (PRIVATE_LISTS.has(list)) return { error: 'import_private' };
    const music = host === 'music.youtube.com';
    return { url: `https://${music ? 'music' : 'www'}.youtube.com/playlist?list=${encodeURIComponent(list)}`, mix: list.startsWith('RD') };
  }
  return link ? { url: link, mix: false } : { error: 'import_failed' };
}

// ── Ranking ───────────────────────────────────────────────────

// Versions of a song: a version the query didn't ask for loses points.
// Turkish uploads name them too: hızlandırılmış = sped up, yavaşlatılmış =
// slowed, altyapı = instrumental, tepki = reaction.
const VARIANTS: [words: string[], penalty: number][] = [
  [['karaoke'], 8], [['nightcore'], 8], [['reaction', 'reacts', 'reacting', 'tepki'], 8], [['parody'], 8],
  [['tutorial', 'lesson'], 8],
  [['remix', 'rmx'], 6], [['cover'], 6], [['slowed', 'yavaslatilmis'], 6], [['sped', 'spedup', 'hizlandirilmis'], 6],
  [['8d'], 6], [['instrumental', 'altyapi'], 6], [['boosted'], 6], [['mashup'], 6], [['hour', 'loop'], 6],
  [['reverb'], 4], [['live', 'canli', 'concert', 'konser'], 4], [['tiktok'], 4],
  [['acoustic', 'akustik', 'unplugged'], 3], [['lyrics', 'lyric', 'sozleri'], 1]
];
// "Speed" and "hour" are in real titles too ("Speed of Sound", "golden hour"): they only
// mark a version as "speed up" / "1 hour" / "10 hours", which variantWords turns into sped / hour.
const PHRASE_ONLY = new Set(['speed', 'hour', 'hours']);

/** A title's words for the VARIANTS check. */
function variantWords(text: string): Set<string> {
  const words = new Set(tokenize(text).filter(w => !PHRASE_ONLY.has(w)));
  const folded = fold(text);
  if (/\bspeed\s*(?:ed\s*)?up\b/.test(folded)) words.add('sped');
  if (/\d\s*(?:hours?|saat)\b/.test(folded)) words.add('hour');
  return words;
}

const WANTS_STREAM = ['radio', 'radyo', 'stream', '24'];
const WANTS_LONG = ['mix', 'album', 'full', 'hour', 'hours', 'saat', 'playlist', 'set', 'compilation'];

// Best match covers this much of the query (by word weight) → trust it.
const CONFIDENT = 0.7;
// Below this nothing is really a match; worth asking SoundCloud too.
const WEAK = 0.34;

type Source = 'ytm' | 'yt' | 'sc' | 'sp';
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
  const queryVariants = variantWords(query);

  const scored = candidates.map(({ track, rank, source }): Scored => {
    const { title, author, length, isStream } = track.info;
    const titleWords = new Set(tokenize(title));
    const titleVariants = variantWords(title);
    const authorWords = tokenize(author);
    const words = new Set([...titleWords, ...authorWords]);
    const covered = [...queryWords].reduce((sum, w) => sum + weight(w) * matchCredit(w, words), 0);
    const coverage = total ? covered / total : 1;

    let score = coverage * 12 + 6 / (1 + rank * 0.5) + (source === 'ytm' ? 1 : 0);
    // The query is exactly an artist's name ("duman") → that artist's songs,
    // not someone else's song titled after them.
    if (authorWords.length === queryWords.size && authorWords.every(w => queryWords.has(w))) score += 3;
    for (const [variant, penalty] of VARIANTS) {
      if (variant.some(w => titleVariants.has(w)) && !variant.some(w => queryVariants.has(w))) score -= penalty;
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

// ── Is this the same song? (autoplay's Spotify ↔ YouTube mapping) ──

// Words that describe the upload, not the song: "(Official Music Video) [HD]".
const NOISE = new Set([
  'official', 'officiel', 'resmi', 'video', 'videoclip', 'audio', 'lyric', 'lyrics', 'lyrical', 'sozleri', 'sozler',
  'hd', 'hq', '4k', '1080p', '720p', 'visualizer', 'visualiser', 'clip', 'klip', 'mv', 'music', 'remaster', 'remastered',
  'version', 'versiyon', 'explicit', 'clean', 'stereo', 'mono', 'edit', 'radio', 'single', 'original', 'orijinal', 'new', 'yeni'
]);
// A bracket that starts like this credits someone or something else: (feat. X), [prod. Y], (from "Movie").
const CREDIT = /^(?:feat|ft|featuring|prod|produced|from|with)\b/i;
// The same after a dash, where "From"/"With" may start the real title ("With or Without You").
const DASH_CREDIT = /^(?:feat|ft|featuring|prod|produced)\b|^from\s+["“'‘]/i;
const isNoise = (word: string) => NOISE.has(word) || /^\d{4}$/.test(word); // years: "Remastered 2011"

/** Channel name → artist: "TarkanVEVO" → "Tarkan", "Duman - Topic" → "Duman", "Sezen Aksu Official" → "Sezen Aksu". */
function cleanArtist(author: string): string {
  return author.replace(/\s*-\s*topic\s*$/i, '').replace(/vevo\s*$/i, '').replace(/\b(?:official|resmi)\b/gi, '').trim();
}

/**
 * The song's own words: bracketed and dash-separated parts that only describe
 * the upload, credit a guest or just name the artist (`artistWords`) are dropped.
 */
function songWords(title: string, artistWords: Set<string>, brackets = true): string[] {
  const kept = songParts(title, artistWords, brackets).flat();
  return kept.length ? kept : tokenize(title);
}

/** songWords, part by part: "Red Alert 2 Soundtrack - Brain Freeze" → [[red, alert, 2, soundtrack], [brain, freeze]]. */
function songParts(title: string, artistWords: Set<string>, brackets = true): string[][] {
  const inside: string[] = [];
  const main = title.replace(/[([{【「]([^)\]}】」]*)[)\]}】」]/g, (_, inner: string) => { inside.push(inner.trim()); return ' - '; });
  const kept: string[][] = [];
  const keep = (text: string, credit: RegExp) => {
    text = text.replace(/\s+(?:feat|ft|featuring)\b.*$/i, '').trim();
    if (!text || credit.test(text)) return;
    const words = tokenize(text);
    if (words.every(isNoise)) return;
    if (artistWords.size && words.every(w => artistWords.has(w))) return; // the "Tarkan" of "Tarkan - Kuzu Kuzu"
    const own = words.filter(w => !isNoise(w));
    if (own.length) kept.push(own);
  };
  for (const part of main.split(/\s+[-–—~•]\s+|\s*\|\s*|:\s+|^\s*-\s*|\s*-\s*$/)) keep(part, DASH_CREDIT);
  if (brackets) for (const inner of inside) keep(inner, CREDIT);
  return kept;
}

/** Share of `words` (by weight, typo-tolerant) found in `pool`; 1 for no words. */
function share(words: string[], pool: Set<string>): number {
  const total = words.reduce((sum, w) => sum + weight(w), 0);
  return total ? words.reduce((sum, w) => sum + weight(w) * matchCredit(w, pool), 0) / total : 1;
}

// Same idea as VARIANTS above, as a multiplier: a cover or nightcore edit is
// a different recording even when every word matches.
const MATCH_VARIANTS: [words: string[], factor: number][] = VARIANTS.map(([words, penalty]) =>
  [words, penalty >= 6 ? 0.5 : penalty >= 3 ? 0.75 : 1]);

/**
 * 0..1: how well `track` matches this song (title + artist, duration if
 * given). Folded and typo-tolerant like rankCandidates. The title carries the
 * score; the artist scales it (a same-titled song by someone else stays below
 * ~0.45), a version the song isn't (cover, live, nightcore, …) halves it, and a
 * known duration pulls far-off lengths down.
 */
export function matchScore(spec: { title: string; artist?: string; durationMs?: number }, track: Track): number {
  const { title, author, length, isStream } = track.info;
  const specArtist = cleanArtist(spec.artist ?? '');
  const specArtistWords = new Set(tokenize(specArtist));
  const specWords = songWords(spec.title, specArtistWords);
  const specAll = new Set([...specWords, ...specArtistWords]);

  const authorWords = new Set(tokenize(cleanArtist(author)));
  const titleWords = new Set(tokenize(title));
  const trackWords = songWords(title, new Set([...specArtistWords, ...authorWords]));
  const trackSet = new Set(trackWords);

  // Spec words in the track's song words; without an artist the spec may be "artist song", so the channel counts too.
  const forward = share(specWords, specArtistWords.size ? trackSet : new Set([...trackSet, ...authorWords]));
  // The track's own song words in the spec: "Believer" vs "Believer Megamix Medley" differ.
  // Brackets left out here: "(Live At Rock'n Coke)" describes the recording, not another song.
  const ownWords = songWords(title, new Set([...specArtistWords, ...authorWords]), false);
  const backward = share(ownWords.filter(w => !VARIANTS.some(([v]) => v.includes(w))), specAll);
  let score = 0.8 * forward + 0.2 * backward;
  // Soundtrack / album uploads name the game or album first: "Red Alert 2 Soundtrack - Brain Freeze"
  // is the song "Brain Freeze". One part of the spec that the track's title covers, and only that, counts nearly as much.
  for (const part of songParts(spec.title, specArtistWords)) {
    if (part.length < specWords.length) score = Math.max(score, 0.9 * Math.min(share(part, trackSet), share(ownWords, new Set(part))));
  }

  if (specArtistWords.size) {
    // The artist on the channel, or in the title for "Artist - Song" uploads.
    // Several artists ("A, B & C"): the best-covered one counts.
    const pool = new Set([...authorWords, ...titleWords]);
    const names = [specArtist, ...specArtist.split(/\s*(?:,|&|\/|;|\+|\bx\b|\band\b|\bve\b|\bfeat\.?|\bft\.?|\bwith\b)\s*/i)];
    const artist = Math.max(...names.map(n => tokenize(n)).filter(w => w.length).map(w => share(w, pool)));
    score *= 0.4 + 0.6 * artist;
  }

  // In the title or the channel ("Nightcore Hits"), and not something the song itself is.
  const specTitleWords = variantWords(spec.title);
  const marked = new Set([...variantWords(title), ...tokenize(author)]);
  for (const [variant, factor] of MATCH_VARIANTS) {
    if (variant.some(w => marked.has(w)) && !variant.some(w => specTitleWords.has(w))) score *= factor;
  }

  if (spec.durationMs) {
    if (isStream || !length) score *= 0.5;
    else {
      const diff = Math.abs(length - spec.durationMs);
      score *= diff <= 3000 ? 1 : diff <= 10_000 ? 0.95 : diff <= 30_000 ? 0.85 : diff <= 90_000 ? 0.65 : 0.45;
    }
  }
  return Math.max(0, Math.min(1, score));
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

// One slow source must not hold up /play: Shoukaku's own REST timeout is a minute.
const SEARCH_TIMEOUT_MS = 8000;

/** `work`, or `fallback` once `ms` have passed (the work keeps running, its result is ignored). */
function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>(done => { timer = setTimeout(done, ms, fallback); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Up to 10 results from one source; [] if it fails or is slower than `ms`, so the others still count. */
async function candidates(resolve: Resolver, prefix: string, query: string, source: Source, ms = SEARCH_TIMEOUT_MS): Promise<Candidate[]> {
  const res = await within(resolve(`${prefix}:${query}`).catch(() => undefined), ms, undefined);
  return tracksOf(res).slice(0, 10).map((track, rank) => ({ track, rank, source }));
}

/** Pool without duplicate videos (YouTube Music and YouTube share IDs). */
function merge(...lists: Candidate[][]): Candidate[] {
  const seen = new Set<string>();
  return lists.flat().filter(c => !seen.has(c.track.info.identifier) && !!seen.add(c.track.info.identifier));
}

/** Best track for a text query: YouTube Music, then YouTube if unsure, then SoundCloud if still nothing fits. */
async function searchText(resolve: Resolver, query: string, expectedMs?: number): Promise<Scored | null> {
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
  const hit = best && best.coverage > 0 ? best : null;
  // Normal level on purpose: updater/watch-snapshot.sh counts matches vs "no match".
  console.log(hit
    ? `[SEARCH] "${query}" → "${hit.track.info.title}" by ${hit.track.info.author} (${hit.source}, score=${hit.score.toFixed(1)}, coverage=${hit.coverage.toFixed(2)})`
    : `[SEARCH] "${query}" → no match`);
  return hit;
}

// ── Suggestions (/play autocomplete, website search box) ─────

const SUGGEST_PREFIX = { ytm: 'ytmsearch', sp: 'spsearch', sc: 'scsearch' } as const;
export type SuggestSource = keyof typeof SUGGEST_PREFIX;
const SUGGEST_TIMEOUT_MS = 2500; // Discord drops autocomplete answers after 3s
const SUGGEST_CACHE_MS = 10 * 60 * 1000;
const SUGGEST_CACHE_MAX = 500;
const SUGGEST_KEEP = 5;
const suggestCache = new Map<string, { at: number; tracks: Track[] }>();

/** Top matches from one source, ranked and cached; [] if the source takes longer than 2.5s. */
export async function suggest(resolve: Resolver, query: string, source: SuggestSource = 'ytm', limit = SUGGEST_KEEP): Promise<Track[]> {
  const text = cleanQuery(query);
  if (!tokenize(text).length) return [];
  const key = `${source}:${fold(text)}`;
  const cached = suggestCache.get(key);
  if (cached && Date.now() - cached.at < SUGGEST_CACHE_MS) return cached.tracks.slice(0, limit);

  const pool = await candidates(resolve, SUGGEST_PREFIX[source], text, source, SUGGEST_TIMEOUT_MS);
  const tracks = rankCandidates(text, pool).slice(0, SUGGEST_KEEP).map(s => s.track);
  if (tracks.length) {
    suggestCache.delete(key); // re-insert at the end: the Map's order is the eviction order
    if (suggestCache.size >= SUGGEST_CACHE_MAX) suggestCache.delete(suggestCache.keys().next().value!);
    suggestCache.set(key, { at: Date.now(), tracks });
  }
  return tracks.slice(0, limit);
}

// ── /play entry point ─────────────────────────────────────────

export interface SearchResult { tracks: Track[]; liveWarning: boolean }

const SPOTIFY_CONCURRENCY = 5;

async function searchSpotify(resolve: Resolver, url: string, room: number, guildId: string): Promise<Track[]> {
  let specs: SpotifyTrackSpec[];
  try {
    specs = await resolveSpotifyTracks(url, room);
  } catch (err) {
    if (err instanceof UserError) throw err;
    const appErr = logError(err, { guildId });
    throw new UserError('search.spotify_error', { ref: appErr.ref });
  }
  if (!specs.length) throw new UserError('search.spotify_empty');

  const tracks: Track[] = [];
  for (let i = 0; i < specs.length; i += SPOTIFY_CONCURRENCY) {
    const batch = await Promise.all(specs.slice(i, i + SPOTIFY_CONCURRENCY)
      .map(s => searchText(resolve, cleanQuery(`${s.artist} ${s.title}`), s.durationMs)));
    for (const hit of batch) if (hit) tracks.push(hit.track);
  }
  return tracks;
}

async function loadLink(resolve: Resolver, url: string): Promise<Track[]> {
  const res = await resolve(url);
  // A bare identifier NodeLink doesn't recognise is searched as text — for a
  // link that would play something random, so treat it as unsupported.
  if (!res || res.loadType === LoadType.SEARCH) throw new UserError('search.link_unsupported');
  if (res.loadType === LoadType.EMPTY) throw new UserError('search.link_empty');
  if (res.loadType === LoadType.ERROR) {
    if (/youtu/.test(new URL(url).hostname)) throw new UserError('search.video_unavailable');
    // NodeLink sends the reason as `exception`, Lavalink as `data`.
    const reason = (res.data ?? (res as { exception?: { message?: string } }).exception)?.message;
    throw reason ? new UserError('search.link_failed_reason', { reason }) : new UserError('search.link_failed');
  }
  return tracksOf(res);
}

/** Resolves a /play query to tracks. `room` = how many the queue can still take. */
export async function search(resolve: Resolver, query: string, room: number, guildId: string): Promise<SearchResult> {
  const link = normalizeLink(query);
  if (link && isSpotifyUrl(link)) return { tracks: await searchSpotify(resolve, link, room, guildId), liveWarning: false };
  if (link) return { tracks: await loadLink(resolve, link), liveWarning: false };

  const text = cleanQuery(query);
  // Only emoji / punctuation: nothing to match a result against.
  if (!tokenize(text).length) return { tracks: [], liveWarning: false };
  const best = await searchText(resolve, text);
  if (!best) return { tracks: [], liveWarning: false };
  const { isStream, length } = best.track.info;
  const words = new Set(tokenize(text));
  const liveWarning = (isStream || length === 0) && !['live', 'stream', 'canli', 'radio', 'radyo'].some(w => words.has(w));
  return { tracks: [best.track], liveWarning };
}
