/************************************************************
 * DJ DIKKAT - Music Bot
 * Radio host trivia
 * Short, checkable facts about a song from real sources only
 * (Spotify Web API, Wikipedia), for radio-lines.ts to phrase
 * Author: Yanoee
 ************************************************************/
import type { Track } from 'shoukaku';
import type { Locale } from '../i18n/index.ts';
import { config } from '../config.ts';
import { createSpotifyClient } from './spotify.ts';
import { fold, matchScore } from './search.ts';
import { cleanTitle } from './autoplay.ts';

/*
 * A wrong fact said with confidence is worse than none, so every rule here
 * leans towards "no fact": a page or a Spotify hit only counts when it
 * clearly is this song (title AND artist, or the game/film the upload names),
 * and only short structured bits are kept — a year, a name, an enum. Never a
 * sentence from a page.
 *
 * NodeLink's /v4/meaning and /v4/loadchapters were checked and are NOT used:
 * meaning's Wikipedia provider takes the first page for the raw upload title
 * or the uploader with no match check (wrong pages), its other provider
 * (letras.mus.br) returns lyric interpretations (free text); chapters are
 * YouTube timestamps, no facts.
 */

// ── Fact shapes (the contract with radio-lines.ts) ───────────

/**
 * One fact. `data` keys per kind (all strings; years are 4 digits; names are
 * as the source spells them, never translated):
 * - `released`   { title, artist, year }           the song came out in `year`
 * - `album`      { title, artist, album, year? }   the song is on the album `album` (released `year`)
 * - `soundtrack` { title, work, medium, year? }    the song is from `work`, a `medium`
 *                                                  ('game' | 'film' | 'series' | 'anime' | 'musical') released in `year`
 * - `composer`   { title, composer, artist? }      the song was written/composed by `composer`
 *                                                  (artist set when it's the artist themself, "written by Tarkan himself")
 * - `origin`     { artist, nationality, role }     `nationality` is an adjective in the requested locale
 *                                                  ("English" / "İngiliz"); `role` is 'singer' | 'rapper' | 'band' |
 *                                                  'musician' | 'composer' | 'dj' | 'producer' | 'songwriter'
 * - `born`       { artist, year }                  the (solo) artist was born in `year`
 * - `genre`      { artist, genre }                 Spotify's genre tag for the artist, lowercase English ("turkish pop")
 */
export type FactKind = 'released' | 'album' | 'soundtrack' | 'composer' | 'origin' | 'born' | 'genre';
export interface Fact { kind: FactKind; data: Record<string, string> }

/** The bits of a track trivia looks at (a shoukaku Track fits). */
export type TriviaTrack = Pick<Track, 'info'>;

// ── Limits ────────────────────────────────────────────────────

const REQUEST_TIMEOUT = 3_000;     // per HTTP request
const TOTAL_TIMEOUT = 5_000;       // whole getFact
const CACHE_TTL = 24 * 3_600_000;  // facts of a song don't change
const RETRY_TTL = 10 * 60_000;     // a source failed / timed out: try again later, not every song
const PARTIAL_TTL = 3_600_000;     // a source failed but another gave facts
const CACHE_MAX = 500;
const WIKI_COOLDOWN = 60_000;      // after a 429 Wikipedia is left alone this long
const MATCH_MIN = 0.7;             // Spotify hit must really be the song (search.ts matchScore)
const USER_AGENT = 'DJDIKKAT-Bot/6 (music bot trivia)';

// ── Text helpers (pure, exported for tests) ──────────────────

/** Folded words joined by single spaces: "Kuzu Kuzu!" → "kuzu kuzu", "Barış" → "baris". */
export function textKey(text: string): string {
  return fold(text).replace(/['’‘`´]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
}

/** True when `needle`'s words appear as a run of whole words in `hay`. */
function mentions(hay: string, needle: string): boolean {
  const n = textKey(needle);
  if (n.length < 2) return false;
  // Turkish suffixes hang on an apostrophe ("Tarkan'ın"), so also try with it as a break.
  return [hay, hay.replace(/['’‘`´]/g, ' ')].some(h => ` ${textKey(h)} `.includes(` ${n} `));
}

/** "Levitating (song)" → ["Levitating", "song"]. */
function splitQualifier(title: string): [base: string, qualifier: string] {
  const m = title.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  return m ? [m[1]!, m[2]!] : [title, ''];
}

// Uploader names that say nothing about who sings.
const GENERIC_ARTIST = /^(?:music|musics|muzik|official|records?|topic|lyrics?|various artists|unknown|unknown artist|ost|soundtracks?|game music|vgm|nightcore|karaoke|radio)$/;

export function cleanArtist(author: string): string {
  return author.replace(/\s*-\s*topic\s*$/i, '').replace(/vevo\s*$/i, '').replace(/\b(?:official|resmi)\b/gi, '')
    .replace(/\s+/g, ' ').trim();
}

const OST_RE = /\b(?:o\.?s\.?t\.?|soundtracks?|original score|game music|motion picture)\b/i;
const WORK_NOISE = /^(?:original|official|video|game|music|full|complete|ost|soundtracks?|score|theme|motion|picture|album|the\s+game)$/i;

/** "Red Alert 2 OST" → "Red Alert 2": the noise words at either end dropped. */
function cleanWork(text: string): string {
  const words = text.replace(/[\s:\-–—]+$/, '').replace(/^[\s:\-–—]+/, '').split(/\s+/).filter(Boolean);
  while (words.length && WORK_NOISE.test(words[0]!.replace(/[^\p{L}.]/gu, ''))) words.shift();
  while (words.length && WORK_NOISE.test(words.at(-1)!.replace(/[^\p{L}.]/gu, ''))) words.pop();
  return words.join(' ').replace(/^["“'‘]|["”'’]$/g, '').trim();
}

export interface ParsedTrack {
  /** Song name candidates, best first. */
  songs: string[];
  /** Artist candidates, best first (may be empty). */
  artists: string[];
  /** The game/film the upload says it's from; `sure` when it said OST/soundtrack/"from". */
  work: { name: string; sure: boolean } | null;
}

/**
 * What an upload title says: song, artist, game/film. Pure (exported for
 * tests). "Hell March (Red Alert 2 OST)", "Red Alert 2 Soundtrack - Hell March",
 * "Let It Go (From "Frozen")" give a sure work; "Command & Conquer: Red Alert 2
 * - Hell March" by a channel that isn't "Command & Conquer…" gives a maybe-work
 * (it only counts when Wikipedia says it's a game/film of that exact name).
 */
export function parseTrack(title: string, author: string): ParsedTrack {
  const artist = cleanArtist(author);
  let rest = title.replace(/\s+/g, ' ').trim();
  let work: ParsedTrack['work'] = null;

  const from = rest.match(/\s*(?:[(\[]\s*|\s-\s*)from\s+(?:the\s+)?(?:(?:video\s+)?game|film|movie|motion picture|series)?\s*["“'‘]([^"”'’]{2,80})["”'’][^)\]]*[)\]]?/i);
  const ostBracket = rest.match(/\s*[(\[]([^)\]]*)[)\]]/g)?.find(b => OST_RE.test(b));
  if (from) {
    work = { name: from[1]!.trim(), sure: true };
    rest = rest.replace(from[0], ' ');
  } else if (ostBracket) {
    work = { name: cleanWork(ostBracket.replace(/[()[\]]/g, ' ').replace(OST_RE, ' ')), sure: true };
    rest = rest.replace(ostBracket, ' ');
  } else {
    const parts = rest.split(/\s+[-–—|]\s+|\s*\|\s*/);
    const i = parts.findIndex(p => OST_RE.test(p));
    if (i >= 0 && parts.length >= 2) {
      work = { name: cleanWork(parts[i]!.replace(OST_RE, ' ')), sure: true };
      parts.splice(i, 1);
      rest = parts.join(' - ');
    }
  }
  if (work && work.name.length < 2) work = null;

  const cleaned = cleanTitle(rest, artist).trim();
  const songs: string[] = [];
  const artists: string[] = [];
  const split = cleaned.split(/\s+[-–—]\s+/);
  if (split.length === 2 && split[0] && split[1]) {
    // "A - B" left after the artist prefix was removed: the uploader isn't A,
    // so A is the artist ("Tarkan - Dudu" on a fan channel) or the game.
    songs.push(cleanTitle(split[1], split[0]));
    artists.push(split[0]);
    if (!work && !mentions(artist, split[0])) work = { name: split[0], sure: false };
  }
  songs.push(cleaned);
  if (artist && !GENERIC_ARTIST.test(textKey(artist))) artists.push(artist);
  // Several artists ("Calvin Harris, Dua Lipa"): each one alone too.
  for (const a of [...artists]) {
    for (const part of a.split(/\s*(?:,|&|\bx\b|\bfeat\.?|\bft\.?|\bve\b|\band\b)\s*/i)) if (part && part !== a) artists.push(part);
  }
  const uniq = (list: string[]) => [...new Map(list.filter(s => textKey(s).length >= 2).map(s => [textKey(s), s.trim()])).values()];
  return { songs: uniq(songs), artists: uniq(artists).filter(a => !GENERIC_ARTIST.test(textKey(a))), work };
}

// ── Demonyms: a nationality adjective in the requested language ──

// English Wikipedia adjective → Turkish. Anything not listed gives no
// `origin` fact for a Turkish server rather than an English word in Turkish speech.
const DEMONYM_TR: Record<string, string> = {
  Albanian: 'Arnavut', American: 'Amerikalı', Argentine: 'Arjantinli', Argentinian: 'Arjantinli', Armenian: 'Ermeni',
  Australian: 'Avustralyalı', Austrian: 'Avusturyalı', Azerbaijani: 'Azerbaycanlı', Barbadian: 'Barbadoslu', Belgian: 'Belçikalı',
  Bosnian: 'Boşnak', Brazilian: 'Brezilyalı', British: 'Britanyalı', Bulgarian: 'Bulgar', Canadian: 'Kanadalı', Chilean: 'Şilili',
  Chinese: 'Çinli', Colombian: 'Kolombiyalı', Croatian: 'Hırvat', Cuban: 'Kübalı', Czech: 'Çek', Danish: 'Danimarkalı',
  Dutch: 'Hollandalı', Egyptian: 'Mısırlı', English: 'İngiliz', Estonian: 'Estonyalı', Finnish: 'Fin', French: 'Fransız',
  Georgian: 'Gürcü', German: 'Alman', Ghanaian: 'Ganalı', Greek: 'Yunan', Hungarian: 'Macar', Icelandic: 'İzlandalı',
  Indian: 'Hintli', Iranian: 'İranlı', Irish: 'İrlandalı', Israeli: 'İsrailli', Italian: 'İtalyan', Jamaican: 'Jamaikalı',
  Japanese: 'Japon', Kazakh: 'Kazak', Korean: 'Koreli', Lebanese: 'Lübnanlı', Mexican: 'Meksikalı', Moroccan: 'Faslı',
  'New Zealand': 'Yeni Zelandalı', Nigerian: 'Nijeryalı', Norwegian: 'Norveçli', Pakistani: 'Pakistanlı', Polish: 'Polonyalı',
  Portuguese: 'Portekizli', 'Puerto Rican': 'Porto Rikolu', Romanian: 'Romen', Russian: 'Rus', Scottish: 'İskoç', Serbian: 'Sırp',
  'South African': 'Güney Afrikalı', 'South Korean': 'Güney Koreli', Spanish: 'İspanyol', Swedish: 'İsveçli', Swiss: 'İsviçreli',
  Turkish: 'Türk', Ukrainian: 'Ukraynalı', Uzbek: 'Özbek', Venezuelan: 'Venezuelalı', Welsh: 'Galli'
};
const TR_NATIONALITIES = new Set(Object.values(DEMONYM_TR));
const EN_DEMONYM_RE = new RegExp(`^(${Object.keys(DEMONYM_TR).sort((a, b) => b.length - a.length).join('|')})\\b`);
const TR_DEMONYM_RE = new RegExp(`^(${[...TR_NATIONALITIES].sort((a, b) => b.length - a.length).join('|')})\\s`, 'u');

const EN_ROLES: [RegExp, string][] = [
  [/^(?:singer|singer-songwriter|vocalist)\b/i, 'singer'], [/^(?:rapper|hip hop artist)\b/i, 'rapper'],
  [/^(?:\w+\s+)?(?:band|group|duo|trio)\b/i, 'band'], [/^(?:musician|multi-instrumentalist|guitarist|pianist)\b/i, 'musician'],
  [/^(?:\w+\s+){0,2}composer\b/i, 'composer'], [/^(?:dj|disc jockey)\b/i, 'dj'], [/^(?:record\s+)?producer\b/i, 'producer'],
  [/^songwriter\b/i, 'songwriter']
];
const TR_ROLES: [RegExp, string][] = [
  [/^(?:şarkıcı|şarkıcı-şarkı yazarı|şarkıcı-söz yazarı|vokalist)/iu, 'singer'], [/^(?:rapçi|rap sanatçısı)/iu, 'rapper'],
  [/^(?:\S+\s+)?(?:müzik grubu|grup|grubu|ikili)/iu, 'band'], [/^müzisyen/iu, 'musician'], [/^besteci/iu, 'composer'],
  [/^dj\b/iu, 'dj'], [/^(?:müzik )?yapımcı/iu, 'producer'], [/^söz yazarı/iu, 'songwriter']
];

// ── Wikipedia extraction (pure, exported for tests) ──────────

export interface WikiPage { title: string; description?: string; extract?: string; disambiguation?: boolean; lang: string }

const SONG_QUALIFIER = /^(?:.*\s)?(?:song|single|şarkı|şarkısı)$/i;
const ALBUM_QUALIFIER = /^(?:.*\s)?(?:album|albüm|albümü|ep|mixtape)$/i;
const ARTIST_QUALIFIER = /^(?:.*\s)?(?:singer|band|musician|rapper|composer|dj|group|şarkıcı|grup|müzisyen|rapçi|besteci)$/i;
const MEDIUM: [RegExp, string][] = [
  [/video game|game\b|video oyunu|oyun/i, 'game'], [/anime/i, 'anime'], [/television series|tv series|web series|dizi/i, 'series'],
  [/musical\b|müzikal/i, 'musical'], [/film|movie/i, 'film']
];

const YEAR = (y: string | undefined): string | null => {
  const n = Number(y);
  return y && /^\d{4}$/.test(y) && n >= 1900 && n <= new Date().getFullYear() + 1 ? y : null;
};
const firstSentences = (text = '') => text.replace(/\s+/g, ' ').slice(0, 600);

/** A song page for one of `songs` by one of `artists`? Then its facts. */
export function songFacts(page: WikiPage, songs: string[], artists: string[]): { facts: Fact[]; album: string | null } | null {
  if (page.disambiguation || !artists.length) return null;
  const [base, qualifier] = splitQualifier(page.title);
  if (qualifier && !SONG_QUALIFIER.test(qualifier)) return null;
  if (!songs.some(s => textKey(s) === textKey(base))) return null;
  const desc = page.description ?? '';
  const text = firstSentences(page.extract);
  const artist = artists.find(a => mentions(`${qualifier} ${desc} ${text.slice(0, 300)}`, a));
  if (!artist) return null;
  const isSong = page.lang === 'tr'
    ? /(?<!\p{L})(?:şarkı|şarkısı|şarkıdır|tekli|teklisi|parça|parçası|parçadır)(?!\p{L})/iu.test(`${desc} ${text}`)
    : /\b(?:single|song)\b/i.test(desc) || /\bis an? (?:[\w-]+ ){0,4}(?:song|single)\b/i.test(text);
  if (!isSong) return null;
  // "2020 single by Dua Lipa": a "by" naming someone else = the same title by another act.
  const by = desc.match(/\bby\s+(.+)$/i);
  if (by && !artists.some(a => mentions(by[1]!, a))) return null;

  const facts: Fact[] = [];
  const title = base.replace(/^["“]|["”]$/g, '');
  let album: string | null = null;
  let albumYear: string | null = null;
  let year: string | null = null;
  if (page.lang === 'tr') {
    album = text.match(/albümü\s+([^'’,.;"]{1,60}?)['’](?:dan|den|tan|ten)\b/u)?.[1]?.trim() ?? null;
    year = YEAR(text.match(/\b(\d{4})\s+(?:yılında\s+|tarihinde\s+)?(?:tekli olarak\s+)?(?:yayımlan|yayınlan|piyasaya)/u)?.[1]);
    const comp = text.match(/(?:Sözleri ve müziği|Müziği ve sözleri|Bestesi|Müziği)\s+([\p{Lu}][\p{L}]+(?: [\p{Lu}][\p{L}]+){0,3})['’](?:a|e|ya|ye|na|ne)\s+ait/u);
    if (comp) facts.push(composerFact(title, comp[1]!, artists));
  } else {
    year = YEAR(desc.match(/^(\d{4})\s+(?:(?:promotional|debut|charity|lead|non-album)\s+)?(?:single|song)\b/i)?.[1]);
    // "from her second studio album, Future Nostalgia (2020)", "from British rock band Queen's fourth studio album, A Night at the Opera".
    const m = text.match(/\bfrom (?:(?:his|her|their|its|the)\s+)?(?:[\p{L}\d'’-]+\s+){0,6}?(?:album|EP|extended play|mixtape),?\s+([\p{Lu}\d"“][^,.;()"]{0,59}?)(?:\s+\((\d{4})\))?(?=[,.;]|\s+\(|\s+and\b|\s+by\b|$)/u);
    if (m) { album = m[1]!.trim(); albumYear = YEAR(m[2]); }
    // One person only: "composed by A, B and C" is a list we can't say short and safe.
    const comp = text.match(/\b(?:composed|written and composed|composed and written|composed and produced) by ([\p{Lu}][\p{L}.'’-]+(?: [\p{Lu}][\p{L}.'’-]+){0,3})(?=\s*[.;]|\s+(?:for|in|as|on)\b)/u);
    if (comp) facts.push(composerFact(title, comp[1]!, artists));
  }
  if (album && (textKey(album) === textKey(title) || /\b(?:single|song)\b/i.test(album))) album = null;
  if (year) facts.push({ kind: 'released', data: { title, artist, year } });
  if (album) facts.push({ kind: 'album', data: albumYear ? { title, artist, album, year: albumYear } : { title, artist, album } });
  return { facts, album };
}

function composerFact(title: string, composer: string, artists: string[]): Fact {
  const self = artists.find(a => textKey(a) === textKey(composer));
  return { kind: 'composer', data: self ? { title, composer, artist: self } : { title, composer } };
}

/** The album page for `album` by one of `artists`? Then its release year. */
export function albumYear(page: WikiPage, album: string, artists: string[]): string | null {
  if (page.disambiguation) return null;
  const [base, qualifier] = splitQualifier(page.title);
  if (qualifier && !ALBUM_QUALIFIER.test(qualifier)) return null;
  if (textKey(base) !== textKey(album)) return null;
  const desc = page.description ?? '';
  const text = firstSentences(page.extract);
  if (!artists.some(a => mentions(`${qualifier} ${desc} ${text.slice(0, 300)}`, a))) return null;
  if (page.lang === 'tr') {
    if (!/albüm/iu.test(text.slice(0, 200))) return null;
    return YEAR(text.match(/\b(\d{4})\s+(?:yılında\s+|tarihinde\s+)?(?:yayımlan|yayınlan|piyasaya|çıkan|çıkardığı)/u)?.[1]);
  }
  return YEAR(desc.match(/^(\d{4})\s+(?:[\w-]+\s+){0,2}?(?:album|EP|extended play|mixtape)\b/i)?.[1]);
}

/**
 * The game/film page for `work`? Then the soundtrack fact. `sure` = the upload
 * said OST/soundtrack/"from"; otherwise the name was only the left half of
 * "X - Song", which is usually an artist: then only an unqualified page counts
 * ("Madonna - Frozen" must never become "from the 1980 film Madonna").
 */
export function workFact(page: WikiPage, work: string, song: string, sure = true): Fact | null {
  if (page.disambiguation) return null;
  const title = page.title;
  const [base, qualifier] = splitQualifier(title);
  if (qualifier && !sure) return null;
  const want = textKey(work);
  // "Command & Conquer: Red Alert 2" is "Red Alert 2", but "Command & Conquer: Red Alert" is not.
  const names = [base, base.split(/:\s+/).at(-1)!].map(textKey);
  if (!want || !names.includes(want)) return null;
  const desc = page.description ?? '';
  const m = desc.match(/^(\d{4})\s+(?:[\w-]+\s+){0,3}?(video game|game|film|movie|television series|tv series|web series|anime(?: television series| film)?|musical|video oyunu|filmi?|dizi(?:si)?)\b/i);
  if (!m) return null;
  const medium = MEDIUM.find(([re]) => re.test(m[2]!))?.[1];
  if (!medium) return null;
  const year = YEAR(m[1]);
  return { kind: 'soundtrack', data: year ? { title: song, work: base, medium, year } : { title: song, work: base, medium } };
}

/** The artist's own page? Then origin (nationality + role) and birth year. */
export function artistFacts(page: WikiPage, artist: string, locale: Locale): Fact[] {
  if (page.disambiguation) return [];
  const [base, qualifier] = splitQualifier(page.title);
  if (qualifier && !ARTIST_QUALIFIER.test(qualifier)) return [];
  if (textKey(base) !== textKey(artist)) return [];
  const desc = (page.description ?? '').trim();
  const text = firstSentences(page.extract);
  const facts: Fact[] = [];
  let nationality: string | null = null;
  let role: string | undefined;
  if (page.lang === 'tr') {
    const m = desc.match(TR_DEMONYM_RE);
    if (m) { nationality = m[1]!; role = TR_ROLES.find(([re]) => re.test(desc.slice(m[0].length)))?.[1]; }
  } else {
    const m = desc.match(EN_DEMONYM_RE);
    if (m) {
      const rest = desc.slice(m[0].length).replace(/^[\s-]+(?:born\s+)?/, '').replace(/^(?:pop|rock|rap|hip hop|electronic|folk|jazz|country|indie|heavy metal|metal|r&b|soul|dance|classical|video game|film|record)\s+/i, '');
      role = EN_ROLES.find(([re]) => re.test(rest))?.[1];
      nationality = locale === 'tr' ? DEMONYM_TR[m[1]!] ?? null : m[1]!;
    }
  }
  if (locale === 'en' && page.lang !== 'en') nationality = null;
  const name = base;
  if (nationality && role) facts.push({ kind: 'origin', data: { artist: name, nationality, role } });
  // Birth year for people only (a band "formed in" isn't "born").
  if (role && role !== 'band') {
    const born = page.lang === 'tr'
      ? text.match(/\(\s*d\.\s*(?:\d{1,2}\s+\S+\s+)?(\d{4})\b/u)?.[1]
      : desc.match(/\(born (\d{4})\)/)?.[1] ?? text.slice(0, 250).match(/\bborn (?:(?:\d{1,2} )?[A-Z][a-z]+ (?:\d{1,2}, )?)?(\d{4})\b/)?.[1];
    const year = YEAR(born);
    if (year) facts.push({ kind: 'born', data: { artist: name, year } });
  }
  return facts;
}

// ── Spotify extraction (pure, exported for tests) ────────────

export interface SpotifyFullTrack {
  id?: string; name?: string; duration_ms?: number;
  artists?: { id?: string; name?: string }[];
  album?: { name?: string; album_type?: string; release_date?: string; release_date_precision?: string };
}

// Reissue/compilation album names: their date isn't the song's, and "it's on
// the album Greatest Hits" isn't news.
const REISSUE_RE = /\b(?:remaster(?:ed)?|deluxe|anniversary|edition|expanded|reissue|re-?recorded|taylor's version)\b/i;
const COMPILATION_RE = /\b(?:greatest hits|best of|the best|hits|collection|essentials?|anthology|now that|karaoke|playlist|vol(?:ume)?\.?\s*\d|en iyiler|seçmeler|arşiv)\b/i;

/** Facts from a matched Spotify track (+ its artist's genres). */
export function spotifyFacts(item: SpotifyFullTrack, genres: string[]): Fact[] {
  const artist = item.artists?.[0]?.name?.trim();
  const albumName = item.album?.name?.trim() ?? '';
  if (!artist || !item.name) return [];
  const title = cleanTitle(item.name, artist);
  const facts: Fact[] = [];
  const type = item.album?.album_type;
  const date = item.album?.release_date ?? '';
  // Catalogue uploads of old records often carry a placeholder Jan 1st date.
  const year = REISSUE_RE.test(albumName) || COMPILATION_RE.test(albumName) || /-01-01$/.test(date) ? null : YEAR(date.slice(0, 4));
  const albumIsSong = textKey(albumName) === textKey(title) || textKey(albumName) === textKey(item.name);
  if (type === 'album' && albumName && !albumIsSong && !COMPILATION_RE.test(albumName)) {
    facts.push({ kind: 'album', data: year ? { title, artist, album: albumName, year } : { title, artist, album: albumName } });
  }
  if (year && (type === 'single' || albumIsSong)) facts.push({ kind: 'released', data: { title, artist, year } });
  const genre = genres.map(g => g.trim().toLowerCase()).find(g => /^[a-z0-9][a-z0-9 &'-]{2,29}$/.test(g));
  if (genre) facts.push({ kind: 'genre', data: { artist, genre } });
  return facts;
}

/** Spotify hit → a shoukaku-shaped track for matchScore. */
const asTrack = (item: SpotifyFullTrack): Track => ({
  encoded: '',
  info: {
    identifier: item.id ?? '', isSeekable: true, author: (item.artists ?? []).map(a => a.name ?? '').filter(Boolean).join(', '),
    length: item.duration_ms ?? 0, isStream: false, position: 0, title: item.name ?? '', uri: undefined, sourceName: 'spotify'
  },
  pluginInfo: {}
} as unknown as Track);

// ── Merge + rotation (pure, exported for tests) ──────────────

const ORDER: FactKind[] = ['soundtrack', 'album', 'released', 'composer', 'origin', 'born', 'genre'];

/**
 * One fact per kind. Wikipedia wins over Spotify (Spotify dates are often a
 * reissue's); a Spotify year that disagrees with Wikipedia's is dropped.
 */
export function mergeFacts(wiki: Fact[], spotify: Fact[]): Fact[] {
  const byKind = new Map<FactKind, Fact>();
  for (const f of wiki) if (!byKind.has(f.kind)) byKind.set(f.kind, f);
  for (const f of spotify) {
    const have = byKind.get(f.kind);
    if (!have) { byKind.set(f.kind, f); continue; }
    // Same album both places, only Spotify knows the year: take it if Wikipedia has no other year.
    if (f.kind === 'album' && !have.data.year && f.data.year && textKey(have.data.album!) === textKey(f.data.album!)) {
      const released = byKind.get('released')?.data.year;
      if (!released || released === f.data.year) byKind.set('album', { kind: 'album', data: { ...have.data, year: f.data.year } });
    }
  }
  // A Spotify-only album year older than the Wikipedia single year can't both be right.
  const album = byKind.get('album');
  const released = byKind.get('released');
  if (album?.data.year && released && Number(album.data.year) + 1 < Number(released.data.year) && !wiki.includes(album)) {
    const { year: _drop, ...rest } = album.data;
    byKind.set('album', { kind: 'album', data: rest });
  }
  return ORDER.flatMap(k => byKind.get(k) ?? []);
}

/** Next fact of the list, skipping `avoid` (the kind said last time) when there's another. */
export function rotate(facts: Fact[], start: number, avoid: FactKind | null): { fact: Fact | null; next: number } {
  if (!facts.length) return { fact: null, next: start };
  let i = start % facts.length;
  if (facts.length > 1 && facts[i]!.kind === avoid) i = (i + 1) % facts.length;
  return { fact: facts[i]!, next: i + 1 };
}

// ── Sources (IO) ──────────────────────────────────────────────

export type SpotifyGet = (path: string) => Promise<unknown>;

export interface TriviaDeps {
  fetch: typeof fetch;
  now: () => number;
  /** Spotify Web API GET (path like "/search?…"), or null when Spotify isn't set up. */
  spotify: SpotifyGet | null;
  /** Per request / whole lookup, ms (tests shorten them). */
  requestTimeout: number;
  totalTimeout: number;
}

interface Entry { facts: Fact[]; expires: number; next: number }

/** A Spotify client of its own: fast (3 s, no retry waits) so trivia never holds up the radio. */
function defaultSpotify(): SpotifyGet | null {
  let client: ReturnType<typeof createSpotifyClient> | null = null;
  return path => {
    if (!config.spotify.clientId || !config.spotify.clientSecret) return Promise.resolve(null);
    client ??= createSpotifyClient({
      fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT)]) : AbortSignal.timeout(REQUEST_TIMEOUT) }),
      sleep: () => Promise.reject(new Error('no retry waits for trivia'))
    });
    return client.get(path);
  };
}

/** A trivia source with its own cache. The bot uses one; tests build their own. */
export function createTrivia(overrides: Partial<TriviaDeps> = {}) {
  const deps: TriviaDeps = {
    fetch: (i, init) => fetch(i, init), now: () => Date.now(), spotify: defaultSpotify(),
    requestTimeout: REQUEST_TIMEOUT, totalTimeout: TOTAL_TIMEOUT, ...overrides
  };
  const cache = new Map<string, Entry>();
  const pending = new Map<string, Promise<Entry>>();
  let wikiBlockedUntil = 0;
  let lastKind: FactKind | null = null;

  const remember = (key: string, entry: Entry) => {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  };

  /** One Wikipedia API query → pages. Throws on HTTP/network failure (the caller marks the result short-lived). */
  async function wikiQuery(lang: string, params: Record<string, string>, signal: AbortSignal): Promise<WikiPage[]> {
    if (wikiBlockedUntil > deps.now()) throw new Error('wikipedia cooling down');
    const qs = new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2', redirects: '1', prop: 'description|extracts|pageprops',
      exintro: '1', explaintext: '1', exsentences: '3', exlimit: 'max', ppprop: 'disambiguation', ...params
    });
    const res = await deps.fetch(`https://${lang}.wikipedia.org/w/api.php?${qs}`, {
      headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(deps.requestTimeout)])
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after'));
      wikiBlockedUntil = deps.now() + Math.max(WIKI_COOLDOWN, Number.isFinite(wait) ? wait * 1000 : 0);
    }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`wikipedia HTTP ${res.status}`); }
    const body = await res.json() as { query?: { pages?: { title?: string; missing?: boolean; invalid?: boolean; description?: string; extract?: string; pageprops?: Record<string, string> }[] } };
    return (body.query?.pages ?? [])
      .filter(p => p.title && !p.missing && !p.invalid)
      .map(p => ({ title: p.title!, description: p.description, extract: p.extract, disambiguation: p.pageprops?.disambiguation !== undefined, lang }));
  }

  /** Facts from one Wikipedia language. `failed` = a request didn't answer. */
  async function fromWikipedia(lang: string, parsed: ParsedTrack, locale: Locale, signal: AbortSignal): Promise<{ facts: Fact[]; failed: boolean }> {
    const { songs, artists, work } = parsed;
    const artist = artists[0];
    const song = songs[0];
    if (!song) return { facts: [], failed: false };
    const suffixes = lang === 'tr' ? ['', ' (şarkıcı)', ' (grup)', ' (müzisyen)'] : ['', ' (singer)', ' (band)', ' (musician)', ' (rapper)'];
    const calls: Promise<WikiPage[]>[] = [
      wikiQuery(lang, { generator: 'search', gsrsearch: artist ? `${song} ${artist}` : song, gsrlimit: '6' }, signal),
      artist ? wikiQuery(lang, { titles: suffixes.map(s => artist + s).join('|') }, signal) : Promise.resolve([]),
      work ? wikiQuery(lang, { generator: 'search', gsrsearch: work.name, gsrlimit: '4' }, signal) : Promise.resolve([])
    ];
    const settled = await Promise.allSettled(calls);
    const failed = settled.some(s => s.status === 'rejected');
    const pages = settled.flatMap(s => (s.status === 'fulfilled' ? s.value : []));

    const facts: Fact[] = [];
    let album: string | null = null;
    for (const page of pages) {
      const hit = songFacts(page, songs, artists);
      if (hit) { facts.push(...hit.facts); album = hit.album; break; }
    }
    if (album) {
      const albumFact = facts.find(f => f.kind === 'album');
      if (albumFact && !albumFact.data.year) {
        for (const page of pages) {
          const year = albumYear(page, album, artists);
          if (year) { albumFact.data.year = year; break; }
        }
      }
    }
    let artistName: string | null = null;
    for (const a of artists) {
      const page = pages.find(p => artistFacts(p, a, locale).length);
      if (page) { facts.push(...artistFacts(page, a, locale)); artistName = a; break; }
    }
    // A maybe-work that turned out to be a musician is the artist, not a game/film.
    if (work && (work.sure || !artistName || textKey(artistName) !== textKey(work.name))) {
      for (const page of pages) {
        const fact = workFact(page, work.name, song, work.sure);
        if (fact) { facts.push(fact); break; }
      }
    }
    return { facts, failed };
  }

  /** Facts from Spotify for the best-matching track (score ≥ 0.7). */
  async function fromSpotify(track: TriviaTrack, parsed: ParsedTrack): Promise<Fact[]> {
    if (!deps.spotify) return [];
    const { info } = track;
    let item: SpotifyFullTrack | null = null;
    if (info.sourceName === 'spotify' && /^[A-Za-z0-9]{10,40}$/.test(info.identifier)) {
      item = await deps.spotify(`/tracks/${info.identifier}`) as SpotifyFullTrack | null;
    } else {
      const song = parsed.songs[0];
      const artist = parsed.artists[0];
      if (!song || !artist) return [];
      const res = await deps.spotify(`/search?type=track&limit=5&q=${encodeURIComponent(`${song} ${artist}`)}`) as { tracks?: { items?: (SpotifyFullTrack | null)[] } } | null;
      let best = 0;
      for (const cand of res?.tracks?.items ?? []) {
        if (!cand?.name) continue;
        for (const title of parsed.songs) for (const a of parsed.artists) {
          const score = matchScore({ title, artist: a, durationMs: info.length || undefined }, asTrack(cand));
          if (score > best) { best = score; item = cand; }
        }
      }
      if (best < MATCH_MIN) item = null;
    }
    if (!item) return [];
    const artistId = item.artists?.[0]?.id;
    let genres: string[] = [];
    if (artistId && /^[A-Za-z0-9]{10,40}$/.test(artistId)) {
      const artist = await deps.spotify(`/artists/${artistId}`).catch(() => null) as { genres?: string[] } | null;
      genres = Array.isArray(artist?.genres) ? artist.genres.filter(g => typeof g === 'string') : [];
    }
    return spotifyFacts(item, genres);
  }

  async function collect(track: TriviaTrack, locale: Locale): Promise<Entry> {
    const parsed = parseTrack(track.info.title ?? '', track.info.author ?? '');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), deps.totalTimeout);
    let failed = false;
    try {
      // Spotify runs beside Wikipedia; whatever it hasn't answered by the deadline is left out.
      const deadline = new Promise<Fact[]>(done => ctl.signal.addEventListener('abort', () => { failed = true; done([]); }, { once: true }));
      const spotify = Promise.race([fromSpotify(track, parsed).catch(() => { failed = true; return [] as Fact[]; }), deadline]);
      // Turkish servers: tr.wikipedia first; English pages fill what it doesn't know.
      const langs = locale === 'tr' ? ['tr', 'en'] : ['en'];
      const wiki: Fact[] = [];
      for (const lang of langs) {
        if (ctl.signal.aborted) { failed = true; break; }
        const got = await fromWikipedia(lang, parsed, locale, ctl.signal).catch(() => ({ facts: [] as Fact[], failed: true }));
        failed ||= got.failed;
        for (const f of got.facts) if (!wiki.some(w => w.kind === f.kind)) wiki.push(f);
        if (wiki.some(f => f.kind === 'released' || f.kind === 'album' || f.kind === 'soundtrack') && wiki.some(f => f.kind === 'origin')) break;
      }
      const facts = mergeFacts(wiki, await spotify);
      // A source that didn't answer may know more next time: nothing found → retry soon, some facts → in an hour.
      const ttl = !failed ? CACHE_TTL : facts.length ? PARTIAL_TTL : RETRY_TTL;
      return { facts, expires: deps.now() + ttl, next: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A fact about this song, or null (no source knew it for sure, a live
   * stream, a timeout). Never throws; at most ~5 s; cached a day per song.
   * Each call on the same song gives the next kind of fact.
   */
  async function getFact(track: TriviaTrack, locale: Locale): Promise<Fact | null> {
    try {
      const { info } = track;
      if (!info || info.isStream || !info.title) return null;
      const key = `${locale}:${info.sourceName ?? ''}:${info.identifier || `${info.author}|${info.title}`}`;
      let entry = cache.get(key);
      if (!entry || entry.expires <= deps.now()) {
        let job = pending.get(key);
        if (!job) {
          // Cached even when this caller gave up waiting: the next play of the song has it ready.
          job = collect(track, locale)
            .then(got => { remember(key, got); return got; })
            .finally(() => pending.delete(key));
          pending.set(key, job);
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<null>(done => { timer = setTimeout(() => done(null), deps.totalTimeout + 250); });
        const got = await Promise.race([job, late]).finally(() => clearTimeout(timer));
        if (!got) return null;
        entry = got;
      }
      const { fact, next } = rotate(entry.facts, entry.next, lastKind);
      entry.next = next;
      if (fact) lastKind = fact.kind;
      return fact ? { kind: fact.kind, data: { ...fact.data } } : null;
    } catch {
      return null;
    }
  }

  return { getFact, cacheSize: () => cache.size };
}

const shared = createTrivia();

/** A checkable fact about the song for the radio host, or null. Never throws. */
export function getFact(track: TriviaTrack, locale: Locale): Promise<Fact | null> {
  return shared.getFact(track, locale);
}
