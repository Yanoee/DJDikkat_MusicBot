/************************************************************
 * DJ DIKKAT - Music Bot
 * Radio host lines
 * What the radio host says between songs: "Up next... coming
 * in right now: Grinder." Pure text, no I/O; radio.ts picks
 * the moment and speaks it through Flowery TTS.
 * The Turkish lines are written in Turkish, not translated,
 * so they need real Turkish suffixes on names and titles
 * (Tarkan'dan, Kuzu Kuzu'yu, Bender'ın). trSuffix does that
 * and says null when it can't tell how a foreign word is
 * pronounced; every kind then still has suffix-free lines,
 * so a wrong ending is never spoken.
 * "..." is a radio pause: both voices hold a beat on it.
 * Author: Yanoee
 ************************************************************/
import { cleanTitle } from './autoplay.ts';
import type { Locale } from '../i18n/index.ts';

export type LineKind = 'next' | 'after' | 'request' | 'autoplay' | 'greeting' | 'milestone' | 'trivia' | 'jingle_tag';
export const LINE_KINDS: readonly LineKind[] = ['next', 'after', 'request', 'autoplay', 'greeting', 'milestone', 'trivia', 'jingle_tag'];

/** A song as the player knows it. `name`: the requester, already cleaned (speakable.ts); null = say "a listener". */
export interface SongRef { title: string; author?: string; name?: string | null }

/** Trivia fact from trivia.ts (§4). Only the shape is needed here. */
export interface FactLike { kind: string; data: Record<string, string> }

export interface LineData {
  song?: SongRef;        // the song starting now
  prev?: SongRef;        // the one that just ended ('after')
  seed?: SongRef;        // what autoplay based its pick on ('autoplay')
  server?: string;       // server name ('greeting')
  count?: number;        // songs played this session ('milestone')
  fact?: FactLike;       // ('trivia')
  now?: Date;            // greeting time; default: now
  avoid?: string;        // the last line spoken, so the same one doesn't come twice in a row
}

export type Rng = () => number;

/** Song counts that get a milestone line: 10, 25, 50, 100, then every 50. */
export const isMilestone = (count: number) => count === 10 || count === 25 || (count >= 50 && count % 50 === 0);

// ── Speech cleaning ──────────────────────────────────────────

const TITLE_MAX = 60;
const ARTIST_MAX = 40;

// Emojis, joiners, variation selectors, music notes, stars, box drawing.
const SYMBOLS = /[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣\p{So}\p{Co}]/gu;
// Upload decoration that cleanTitle keeps when it isn't in brackets.
const NOISE_WORDS = /\b(official\s+(music\s+)?video|official\s+audio|lyric\s+video|music\s+video|visuali[sz]er|lyrics?|full\s+hd|hd|hq|4k|1080p|720p|m\/v|mv|explicit|audio\s+only)\b/gi;
// Channels that aren't the artist: say no artist rather than "by Best OST Uploads".
const CHANNEL_NOISE = /\b(records|recordings|channel|uploads?|gaming|lyrics?|music\s*tv|ost|soundtracks?|various|unknown|nightcore|8d|hd|tv|plak|müzik|muzik|official\s+channel|playlist)\b/i;
// A " - " part that says which game/film/version, not who sings it.
const SOURCE_PART = /\b(ost|soundtrack|theme|from|remix|mix|version|ver|edit|live|cover|remaster(ed)?|instrumental|acoustic|akustik)\b/i;

const capAt = (text: string, max: number) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : text.slice(0, max)).replace(/[\s,;:&-]+$/, '');
};

/** Spoken "and" between artists / in titles ("Simon & Garfunkel"). */
const andWord = (locale: Locale) => (locale === 'tr' ? 've' : 'and');

function tidy(text: string, locale: Locale): string {
  return text
    .replace(SYMBOLS, ' ')
    .replace(/#\S+/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    // Bare links ("discord.gg/abc", "www.site.com") are never read out either.
    .replace(/\b(?:www\.)?[\w-]+\.(?:com|net|org|gg|tv|io|me|xyz|co|app|dev|link|ly|ru)(?:\.tr)?(?:\/\S*)?/gi, ' ')
    .replace(/[_*~`|"“”«»]+/g, ' ')
    .replace(/\s+(&|\+)\s+/g, ` ${andWord(locale)} `)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Artist name as said aloud, or null when it's a channel name / empty. */
export function speakArtist(author: string | undefined, locale: Locale = 'en'): string | null {
  if (!author) return null;
  let text = author
    .replace(/\s*-\s*topic\s*$/i, '').replace(/vevo\s*$/i, '').replace(/\s*official\s*$/i, '')
    .replace(/[([{【][^)\]}】]*[)\]}】]/g, ' ');
  text = tidy(text, locale);
  // "A, B, C" / "A feat. B" / "A x B" → the first two, joined by "and".
  const names = text.split(/\s*(?:,|;|\/|\s+x\s+|\bfeat\b\.?|\bft\b\.?|\bfeaturing\b)\s*/i).filter(Boolean);
  text = names.slice(0, 2).join(` ${andWord(locale)} `);
  if (!text || CHANNEL_NOISE.test(text) || !/\p{L}/u.test(text)) return null;
  return capAt(text, ARTIST_MAX);
}

/**
 * Title and artist as the host says them. cleanTitle drops "(Official
 * Video)", feat., "Artist - " and Spotify's " - Remastered"; here also every
 * other bracket, emojis, hashtags and upload words go, and an "Artist - Song"
 * upload by some channel becomes Song by Artist. Titles over 60 characters are
 * cut at a word.
 */
export function speakSong(title: string, author = '', locale: Locale = 'en'): { title: string; artist: string | null } {
  let text = cleanTitle(title, author)
    .replace(/[([{【][^)\]}】]*[)\]}】]/g, ' ')
    .replace(/[([{【].*$/, ' ')                    // an unclosed bracket: drop the rest
    .replace(NOISE_WORDS, ' ');
  text = tidy(text, locale);
  let artist = speakArtist(author, locale);
  let parts = text.split(/\s+[-–—:]\s+|\s+\/\/\s+/).map(p => p.trim()).filter(Boolean);
  // "Hell March - Red Alert OST": the tail names the source, not the singer.
  while (parts.length > 1 && SOURCE_PART.test(parts.at(-1)!)) parts.pop();
  if (parts.length === 2) {
    // "Frank Klepacki - Hell March" uploaded by anyone: part one is the artist.
    artist = speakArtist(parts[0], locale) ?? artist;
    parts = [parts[1]!];
  }
  let spoken = parts.join(', ').replace(/^[\s,.\-–—:;]+|[\s,.\-–—:;!?]+$/g, '').trim();
  if (!spoken || !/[\p{L}\p{N}]/u.test(spoken)) spoken = tidy(title, locale).replace(/[\s,.\-–—:;!?]+$/g, '');
  return { title: capAt(spoken, TITLE_MAX), artist };
}

/** Server name as said aloud, or null. */
export function speakServer(name: string | undefined, locale: Locale = 'en'): string | null {
  if (!name) return null;
  const text = tidy(name.replace(/[([{【][^)\]}】]*[)\]}】]/g, ' '), locale).replace(/[^\p{L}\p{N}\s'’.,!-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return /\p{L}/u.test(text) ? capAt(text, 32) : null;
}

// ── Turkish numbers ─────────────────────────────────────────

const ONES = ['', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz'];
const TENS = ['', 'on', 'yirmi', 'otuz', 'kırk', 'elli', 'altmış', 'yetmiş', 'seksen', 'doksan'];

function below1000(n: number): string[] {
  const h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), o = n % 10;
  const out: string[] = [];
  if (h > 1) out.push(ONES[h]!);
  if (h) out.push('yüz');
  if (t) out.push(TENS[t]!);
  if (o) out.push(ONES[o]!);
  return out;
}

/**
 * A whole number in Turkish words: 1996 → "bin dokuz yüz doksan altı".
 * Written out because a TTS voice may read "1996" digit by digit, and a word
 * takes a plain suffix without an apostrophe ("doksan altı yılında").
 */
export function trNumber(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'sıfır';
  const words: string[] = [];
  const millions = Math.floor(n / 1_000_000), thousands = Math.floor((n % 1_000_000) / 1000), rest = n % 1000;
  if (millions) words.push(...below1000(millions), 'milyon');
  if (thousands === 1) words.push('bin');
  else if (thousands) words.push(...below1000(thousands), 'bin');
  words.push(...below1000(rest));
  return words.join(' ');
}

/** Turkish ordinal in words: 25 → "yirmi beşinci", 4 → "dördüncü". */
export function trOrdinal(n: number): string {
  const words = trNumber(n).split(' ');
  const last = words.pop()!;
  const base = last === 'dört' ? 'dörd' : last;
  const i = fourWay(lastVowel(base)!);
  words.push(VOWELS.includes(base.at(-1)!) ? `${base}nc${i}` : `${base}${i}nc${i}`);
  return words.join(' ');
}

// ── Turkish suffixes ────────────────────────────────────────

/**
 * Turkish cases the lines use: ablative (-dan), genitive (-ın), accusative
 * (-ı), dative (-a), locative (-da), instrumental (-la, "ile" glued on) and
 * the past copula (-ydı: "Kuzu Kuzu'ydu").
 */
export type TrCase = 'abl' | 'gen' | 'acc' | 'dat' | 'loc' | 'ins' | 'cop';

const VOWELS = 'aeıioöuü';
const BACK = 'aıou';
const VOICELESS = 'fstkçşhp';   // "fıstıkçı şahap": a d after these becomes t

const lastVowel = (sound: string) => [...sound].reverse().find(ch => VOWELS.includes(ch));
const twoWay = (v: string) => (BACK.includes(v) ? 'a' : 'e');
const fourWay = (v: string) => ({ a: 'ı', ı: 'ı', o: 'u', u: 'u', e: 'i', i: 'i', ö: 'ü', ü: 'ü' })[v] ?? 'i';

// Loanwords that take front endings although their last vowel is back.
const FRONT_LOANS: Record<string, string> = {
  dikkat: 'dikket', saat: 'saet', kalp: 'kelp', hayal: 'hayel', hal: 'hel', gol: 'göl', rol: 'röl', alkol: 'alköl',
  kontrol: 'kontröl', petrol: 'petröl', sembol: 'semböl', kabul: 'kabül', meşgul: 'meşgül', istiklal: 'istiklel',
  ihtimal: 'ihtimel', hakikat: 'hakiket', kemal: 'kemel', celal: 'celel', cemal: 'cemel', iqbal: 'ikbel'
};

const TR_LETTERS = /[çğıöşüÇĞİÖŞÜ]/;
const TR_WORDS = /(?:^|\s)(ve|bir|ben|sen|biz|aşk|ask|gel|git|yok|var|beni|seni|bana|sana|gibi|için|icin|kalbim|gönül|gonul|sevda|yar|yarim|bu|şu|ne|olmaz|yeter|gece|gidiyorum|seviyorum|dudu|kuzu|tarkan|sezen|aksu|barış|baris|manço|manco|ajda|pekkan|teoman|duman|mor|ötesi|sertab|gülşen|hadise|kenan|doğulu|mabel|matiz|ezhel|ceza|sagopa|norm|ender)(?=\s|$)/i;

/** True when a phrase reads as Turkish (Turkish letters or common Turkish words / names). */
export const looksTurkish = (phrase: string) => TR_LETTERS.test(phrase) || TR_WORDS.test(phrase.toLocaleLowerCase('tr'));

/**
 * The last word of a name/title spelled the way a Turkish ear hears it, or
 * null when we can't tell. Digits are read as Turkish number words ("Red
 * Alert 2" → "iki"). English-looking words (w, x, th, ee, silent e, final y,
 * ...) are unsure on purpose: the line picker then uses a shape without a suffix.
 */
function sound(text: string, turkish: boolean): string | null {
  const word = text.trim().replace(/[\s.,!?;:'’"…)\]}-]+$/u, '').match(/[\p{L}\p{N}]+$/u)?.[0];
  if (!word) return null;
  const digits = word.match(/\d+$/)?.[0];
  if (digits) return digits.length > 9 ? null : trNumber(Number(digits)).split(' ').pop()!;
  if (turkish || TR_LETTERS.test(word)) {
    const lower = word.toLocaleLowerCase('tr');
    return FRONT_LOANS[lower] ?? lower;
  }
  if (word.length < 2) return null;
  if (word.length <= 4 && word === word.toUpperCase() && !/[AEIOU]/.test(word)) return null;   // "TNT", "DJ": spelled out
  const w = word.toLowerCase();
  if (FRONT_LOANS[w]) return FRONT_LOANS[w];
  if (!/[aeiouy]/.test(w)) return null;
  // "Grinder", "Bender", "Matters": an English -er(s) is heard as "ır(s)".
  if (/[^aeiou]ers?$/.test(w) && !/(w|x|q|th|sh|ph|gh)/.test(w)) return w.replace(/ers?$/, m => (m === 'ers' ? 'ırs' : 'ır'));
  // Any other English plural or -es ("Dragons", "Roses", "Hades") has a vowel before the s we
  // can't know, and a silent b ("Numb", "Bomb") hides the vowel: unsure.
  if (/(?:[^aeiou]|e)s$/.test(w) || /mb$/.test(w)) return null;
  // English spellings a Turkish reading would get wrong. ay/ey/oy only at the
  // end (Day, Money, Boy), so Zeynep, Ayla and Beyza still read Turkish.
  if (/(w|x|q|th|sh|ph|gh|ee|oo|ou|ea|aw|ow|ie|ue|ui|au|ai|oa)/.test(w) || /(ay|ey|oy)$/.test(w)) return null;
  if (/[^aeiou]y$/.test(w)) return null;                                  // Story, Lady
  if (/[aiouy][^aeiouy]e$/.test(w) || /(nce|dge|tch|ble|ple|tle)$/.test(w)) return null;   // Fame, Dance, Fire
  return w.replace(/ch$/, 'ç').replace(/ck$/, 'k').replace(/c$/, 'k');    // March → Març, Rock, 2Pac → Pak
}

/**
 * Turkish ending for a proper name or title, apostrophe included:
 * trSuffix('Tarkan', 'abl') → "Tarkan'dan", ('Kuzu Kuzu', 'acc') → "Kuzu
 * Kuzu'yu", ('Bender', 'gen') → "Bender'ın", ('Hell March', 'acc') → "Hell
 * March'ı", ('Red Alert 2', 'abl') → "Red Alert 2'den". Null when unsure how
 * the last word is pronounced. `context` (title + artist) says whether the
 * words are Turkish; defaults to the text itself.
 */
export function trSuffix(text: string, kind: TrCase, context = text): string | null {
  const base = text.trim().replace(/[\s.,!?;:'’…-]+$/u, '');
  const s = sound(base, looksTurkish(context));
  if (!s) return null;
  const v = lastVowel(s);
  if (!v) return null;
  const endsVowel = VOWELS.includes(s.at(-1)!);
  const hard = !endsVowel && VOICELESS.includes(s.at(-1)!);
  const a = twoWay(v), i = fourWay(v);
  const d = hard ? 't' : 'd';
  const y = endsVowel ? 'y' : '';
  const ending = {
    abl: `${d}${a}n`,
    loc: `${d}${a}`,
    dat: `${y}${a}`,
    acc: `${y}${i}`,
    gen: `${endsVowel ? 'n' : ''}${i}n`,
    ins: `${y}l${a}`,
    cop: `${y}${d}${i}`
  }[kind];
  return `${base}'${ending}`;
}

// "bir dinleyici" is a common noun: plain endings, no apostrophe.
const LISTENER_TR: Record<TrCase | 'nom', string> = {
  nom: 'bir dinleyici', abl: 'bir dinleyiciden', gen: 'bir dinleyicinin', acc: 'bir dinleyiciyi',
  dat: 'bir dinleyiciye', loc: 'bir dinleyicide', ins: 'bir dinleyiciyle', cop: 'bir dinleyiciydi'
};

// ── Line building ───────────────────────────────────────────

interface Song { t: string; a: string | null; ctx: string; name: string | null | undefined }
interface Ctx {
  song: Song | null; prev: Song | null; seed: Song | null;
  server: string | null; count: number; fact: FactLike | null; hour: number | null;
}
type Tpl = (c: Ctx) => string | null | undefined | false | '';

const toSong = (ref: SongRef | undefined, locale: Locale): Song | null => {
  if (!ref?.title) return null;
  const { title, artist } = speakSong(ref.title, ref.author ?? '', locale);
  // A title of only emojis / symbols / a link leaves nothing to say: no "coming in right now: ."
  if (!/[\p{L}\p{N}]/u.test(title)) return null;
  return { t: title, a: artist, ctx: `${ref.title} ${ref.author ?? ''}`, name: ref.name };
};

/** Turkish case form of a song title / artist, null when unsure. */
const tT = (s: Song | null, k: TrCase) => (s ? trSuffix(s.t, k, s.ctx) : null);
const tA = (s: Song | null, k: TrCase) => (s?.a ? trSuffix(s.a, k, s.ctx) : null);
/** Turkish requester form; "bir dinleyici" when the name was filtered out. */
const tN = (name: string | null | undefined, k: TrCase | 'nom') =>
  name ? (k === 'nom' ? name : trSuffix(name, k, name)) : LISTENER_TR[k];
const enN = (name: string | null | undefined) => name || 'a listener';

/** Uppercase first letter; Turkish-aware (i → İ) only in Turkish lines, so an English "isabel" isn't "İsabel". */
const cap = (text: string, locale: Locale = 'tr') => text.charAt(0).toLocaleUpperCase(locale === 'tr' ? 'tr' : 'en') + text.slice(1);

const by = (s: Song) => (s.a ? `, by ${s.a}` : '');

// Hour of day in Istanbul for Turkish servers.
function istanbulHour(now: Date): number {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', hour: 'numeric', hourCycle: 'h23' }).format(now);
  return Number(h) % 24;
}

const EN: Record<LineKind, Tpl[]> = {
  next: [
    c => c.song && `Up next... coming in right now: ${c.song.t}.`,
    c => c.song && `Here we go... ${c.song.t}${by(c.song)}.`,
    c => c.song && `And now... ${c.song.t}. Turn it up!`,
    c => c.song?.a && `Coming in hot... ${c.song.a}, with ${c.song.t}.`,
    c => c.song && `Keep it locked... this is ${c.song.t}.`,
    c => c.song && `Next up on D J Dikkat... ${c.song.t}.`,
    c => c.song && `No breaks, no waiting... ${c.song.t}, right now.`,
    c => c.song?.a && `Right on time... here's ${c.song.a}, with ${c.song.t}.`
  ],
  after: [
    c => c.prev && c.song && `That was ${c.prev.t}${by(c.prev)}. Up next... coming in right now: ${c.song.t}.`,
    c => c.prev && c.song && `You just heard ${c.prev.t}. Keep it here... ${c.song.t} is next.`,
    c => c.prev && c.song && `That was ${c.prev.t}... and we keep rolling. Here's ${c.song.t}.`,
    c => c.prev && c.song && `Hope you enjoyed ${c.prev.t}. Now... turn it up for ${c.song.t}!`,
    c => c.prev && c.song && `From ${c.prev.t}... straight into ${c.song.t}. Stay with us.`,
    c => c.prev?.a && c.song && `${c.prev.a}, with ${c.prev.t}. And coming in right now... ${c.song.t}.`,
    c => c.prev && c.prev.name !== undefined && c.song && `That was ${c.prev.t}, ${enN(c.prev.name)}'s pick. And now... ${c.song.t}.`,
    c => c.prev && c.song && `${c.prev.t}, done. No time to breathe... here comes ${c.song.t}!`
  ],
  request: [
    c => c.song && c.song.name && `This one goes out to ${c.song.name}... ${c.song.t}!`,
    c => c.song && `A request from ${enN(c.song.name)}... here's ${c.song.t}.`,
    c => c.song && `${cap(enN(c.song.name), 'en')} asked for it, so here it is... ${c.song.t}.`,
    c => c.song && `Coming in right now, requested by ${enN(c.song.name)}: ${c.song.t}.`,
    c => c.song && c.song.name && `Shout-out to ${c.song.name} for this one... ${c.song.t}!`,
    c => c.song && c.song.name && `You asked, we play. ${c.song.name}, this is ${c.song.t}.`,
    c => c.song && `Next, a pick from ${enN(c.song.name)}... ${c.song.t}${by(c.song)}.`,
    c => c.song && `Straight from the request line... ${c.song.t}, for ${enN(c.song.name)}.`
  ],
  autoplay: [
    c => c.song && `The queue's empty, but the music isn't... here's ${c.song.t}.`,
    c => c.song && c.seed && `Autoplay found something like ${c.seed.t}... here's ${c.song.t}.`,
    c => c.song && `We picked this one for you... ${c.song.t}${by(c.song)}.`,
    c => c.song && c.seed && `If you liked ${c.seed.t}, you'll love this... ${c.song.t}.`,
    c => c.song && `Keeping the vibe going... here's ${c.song.t}.`,
    c => c.song && `No requests in the line... so here's one from us. ${c.song.t}.`,
    c => c.song && `Fresh pick, same vibe... ${c.song.t}.`,
    c => c.song && `Add your own songs any time... meanwhile, here's ${c.song.t}.`
  ],
  greeting: [
    c => `Hey everybody, welcome to D J Dikkat${c.server ? ` on ${c.server}` : ''}! Turn it up... let's go.`,
    c => `You're locked in to D J Dikkat.${c.server ? ` ${c.server},` : ''} let's get this party started!`.replace('. let', '. Let'),
    c => c.server && `Hello, ${c.server}! D J Dikkat is on the air.`,
    () => `Welcome in, everyone... this is D J Dikkat, and the music starts right now.`,
    c => `Good to have you here${c.server ? `, ${c.server}` : ''}! D J Dikkat, live and loud.`,
    c => `It's D J Dikkat time! Grab your headphones${c.server ? `, ${c.server}` : ''}... here we go.`,
    () => `D J Dikkat is on the air... sit back, turn it up, and enjoy the ride.`
  ],
  milestone: [
    c => `That's song number ${c.count}! Thanks for keeping D J Dikkat busy.`,
    c => `${c.count} songs and counting... and we're not stopping now.`,
    c => `Look at that... ${c.count} songs on the air! Keep those requests coming.`,
    c => `Song number ${c.count}! You've got great taste, everyone.`,
    c => `We just hit ${c.count} songs. Stay with us, there's more to come.`,
    c => `${c.count} songs in... and the party's still going!`
  ],
  trivia: [],   // built by enTrivia
  jingle_tag: [
    () => `You're locked in to D J Dikkat.`,
    () => `This is D J Dikkat... don't touch that dial.`,
    () => `D J Dikkat... your requests, your radio.`,
    () => `Stay tuned... D J Dikkat.`,
    () => `D J Dikkat... on the air, all the time.`,
    () => `Turn it up... you're listening to D J Dikkat.`,
    () => `The music never stops... D J Dikkat.`
  ]
};

// Short tails that hand over to the song after a greeting / milestone line.
const EN_TAIL: Record<'greeting' | 'milestone', Tpl[]> = {
  greeting: [
    c => c.song && `First up... ${c.song.t}.`,
    c => c.song && `Kicking things off... ${c.song.t}.`,
    c => c.song && `And we start with ${c.song.t}.`
  ],
  milestone: [
    c => c.song && `Here's ${c.song.t}.`,
    c => c.song && `Coming in right now: ${c.song.t}.`,
    c => c.song && `And now... ${c.song.t}.`
  ]
};

const GREET_TR = (hour: number | null) => {
  if (hour === null) return 'Merhabalar';
  if (hour >= 5 && hour < 11) return 'Günaydın';
  if (hour >= 11 && hour < 18) return 'İyi günler';
  if (hour >= 18 && hour < 23) return 'İyi akşamlar';
  return 'Gece kuşlarına selam';
};

const TR: Record<LineKind, Tpl[]> = {
  next: [
    c => c.song && `Şimdi sırada... ${c.song.t} var. Sesi açın!`,
    c => c.song && `Ve şimdi... ${c.song.t} geliyor!`,
    c => c.song && `Sıradaki parçamız... ${c.song.t}. Keyfini çıkarın!`,
    c => { const a = tA(c.song, 'abl'); return a && `Hemen geçiyoruz... ${a} ${c.song!.t}!`; },
    c => c.song?.a && `Şimdi ${c.song.a}... ${c.song.t} ile karşınızda!`,
    c => c.song && `Durmak yok, devam ediyoruz... karşınızda ${c.song.t}!`,
    c => c.song && `Sesi biraz açın... çünkü sırada ${c.song.t} var!`,
    c => c.song && `Dicey Dikkat'te sıradaki şarkı... ${c.song.t}.`,
    c => c.song?.a && `Sırada ${c.song.a} var... ${c.song.t}. Eşlik edin!`
  ],
  after: [
    c => { const a = tA(c.prev, 'abl'), p = tT(c.prev, 'cop'); return a && p && c.song && `${a} ${p}... Şimdi sırada ${c.song.t} var. Sesi açın, devam ediyoruz!`; },
    c => c.prev && c.song && `Az önce dinlediğiniz parça: ${c.prev.t}. Ve şimdi... ${c.song.t}!`,
    c => c.prev && c.song && `Evet, ${c.prev.t} bitti... ama durmak yok! Şimdi ${c.song.t}.`,
    c => { const p = tT(c.prev, 'gen'); return p && c.song && `${p} ardından... sıra geldi ${c.song.t} parçasına!`; },
    c => { const p = tT(c.prev, 'cop'); return p && c.song && `Buraya kadar ${p}... Şimdi sesi açın, sırada ${c.song.t} var!`; },
    c => { const p = tT(c.prev, 'acc'); return p && c.song && `${p} dinlediniz... Hemen ardından, ${c.song.t} geliyor!`; },
    c => {
      if (!c.prev || c.prev.name === undefined || !c.song) return null;
      const n = tN(c.prev.name, 'gen');
      return n && `${c.prev.t}, ${n} isteğiydi. Ve şimdi... ${c.song.t} geliyor!`;
    },
    c => c.prev && c.song && `${c.prev.t} ile ısındık... şimdi sırada ${c.song.t} var. Bizden ayrılmayın!`
  ],
  request: [
    c => { const n = tN(c.song?.name, 'gen'); return c.song && n && `${cap(n)} isteği geliyor... ${c.song.t}!`; },
    c => { const n = tN(c.song?.name, 'gen'); return c.song && n && `Şimdi ${c.song.t}... ${n} seçimi. Sesi açın!`; },
    c => c.song && `İstek parçamız geldi... ${tN(c.song.name, 'nom')} istedi, biz çalıyoruz: ${c.song.t}!`,
    c => c.song && `Şimdi bir istek... gönderen ${tN(c.song.name, 'nom')}. Sırada ${c.song.t} var!`,
    c => c.song?.name && `${c.song.name}, bu şarkı senin için... ${c.song.t} geliyor!`,
    c => { const n = tN(c.song?.name, 'abl'); return c.song && n && `Bu istek ${n} geldi... ${c.song.t}, hepinize gelsin!`; },
    c => { const n = c.song?.name && trSuffix(c.song.name, 'dat'); return c.song && n && `${n} selamlar... İstediğin ${c.song.t} şimdi yayında!`; },
    c => c.song && `İstekleriniz bizim için emir... ${c.song.t}, ${tN(c.song.name, 'nom')} istedi!`
  ],
  autoplay: [
    c => c.song && `Kuyruk bitti ama müzik bitmez! Sırada ${c.song.t} var.`,
    c => c.song && `Sizin için seçtik... ${c.song.t} geliyor.`,
    c => c.song && c.seed && `${c.seed.t} sevenlere gelsin... ${c.song.t}!`,
    c => { const s = tT(c.seed, 'acc'); return s && c.song && `${s} beğendiyseniz, bunu da seveceksiniz... ${c.song.t}!`; },
    c => c.song && `Bu da bizden... ${c.song.t}. İsterseniz kuyruğa şarkı ekleyin, hemen çalalım!`,
    c => c.song && `Liste bitti, Dicey Dikkat devam ediyor... Şimdi ${c.song.t}!`,
    c => c.song && `Kuyrukta şarkı kalmadı ama merak etmeyin... ${c.song.t} geliyor.`,
    c => { const s = tT(c.seed, 'dat'); return s && c.song && `${s} benzer bir şey seçtik... ${c.song.t}. Keyfini çıkarın!`; }
  ],
  greeting: [
    c => `${GREET_TR(c.hour)}${c.server ? `, ${c.server}` : ''}! Dicey Dikkat yayında... Sesi açın, başlıyoruz!`,
    c => `${GREET_TR(c.hour)}, sevgili dinleyiciler! Burası Dicey Dikkat.`,
    c => `Dicey Dikkat'e hoş geldiniz! ${GREET_TR(c.hour)}${c.server ? `, ${c.server}` : ''}... Müzik başlıyor.`,
    c => `${GREET_TR(c.hour)}! Müzik bizden, keyif sizden... Dicey Dikkat yayında.`,
    c => c.server && `${c.server} sunucusundaki herkese selam! ${GREET_TR(c.hour)}, Dicey Dikkat başlıyor.`,
    c => `${GREET_TR(c.hour)}! Dicey Dikkat ile müzik dolu bir yayına hazır mısınız?`,
    c => c.hour !== null && (c.hour >= 23 || c.hour < 5) && `Gece kuşları, buradayız! Dicey Dikkat bu saatte de yayında.`,
    c => c.hour !== null && c.hour >= 5 && c.hour < 11 && `Günaydın! Kahveler hazırsa... Dicey Dikkat ile güne başlıyoruz.`
  ],
  milestone: [
    c => `Tam ${trNumber(c.count)} şarkı oldu! Siz istedikçe biz çalıyoruz.`,
    c => `${cap(trNumber(c.count))} şarkıyı geride bıraktık... ama daha bitmedi!`,
    c => `${cap(trOrdinal(c.count))} şarkıya geldik... Bizden ayrılmayın!`,
    c => `Saydık, tam ${trNumber(c.count)} şarkı! Dicey Dikkat'te kalın.`,
    c => `Bu yayının ${trOrdinal(c.count)} şarkısı... Sesi açın!`,
    c => `${cap(trNumber(c.count))} şarkı ve hâlâ buradayız! Devam ediyoruz.`
  ],
  trivia: [],   // built by trTrivia
  jingle_tag: [
    () => `Dicey Dikkat'te kalın.`,
    () => `Burası Dicey Dikkat... Frekansı bozmayın!`,
    () => `Dicey Dikkat... Sizin radyonuz.`,
    () => `Sesi açın... Dicey Dikkat yayında!`,
    () => `Dicey Dikkat... İstek sizden, müzik bizden.`,
    () => `Ayrılmayın, Dicey Dikkat'tesiniz.`,
    () => `Dicey Dikkat... Müzik hiç durmasın.`
  ]
};

const TR_TAIL: Record<'greeting' | 'milestone', Tpl[]> = {
  greeting: [
    c => c.song && `İlk şarkımız... ${c.song.t}!`,
    c => c.song && `Açılışı ${c.song.t} ile yapıyoruz!`,
    c => c.song && `İlk parça geliyor... ${c.song.t}.`
  ],
  milestone: [
    c => c.song && `Şimdi sırada... ${c.song.t}.`,
    c => c.song && `Ve şimdi... ${c.song.t}!`,
    c => c.song && `Sırada ${c.song.t} var.`
  ]
};

// ── Trivia ───────────────────────────────────────────────────
// Fact shapes come from trivia.ts (FactKind): released {year}, album {album,
// year?}, soundtrack {work, medium, year?}, composer {composer, artist? = the
// singer wrote it}, origin {artist, nationality, role}, born {artist, year},
// genre {artist, genre}. Facts are names and years only, so every sentence
// is a fixed frame around them.

const yearOk = (y: string | undefined): y is string => !!y && /^\d{4}$/.test(y) && Number(y) >= 1000 && Number(y) <= 2100;

const MEDIUM_EN: Record<string, string> = { game: 'video game', film: 'film', series: 'TV series', anime: 'anime', musical: 'musical' };
// "<work> oyunu için" / "<work> oyunundan": the case goes on the common noun, never on the name.
const MEDIUM_TR: Record<string, [of: string, from: string]> = {
  game: ['oyunu', 'oyunundan'], film: ['filmi', 'filminden'], series: ['dizisi', 'dizisinden'],
  anime: ['animesi', 'animesinden'], musical: ['müzikali', 'müzikalinden']
};
const ROLE_EN: Record<string, string> = {
  singer: 'singer', rapper: 'rapper', band: 'band', musician: 'musician', composer: 'composer',
  dj: 'D J', producer: 'producer', songwriter: 'songwriter'
};
const ROLE_TR: Record<string, string> = {
  singer: 'şarkıcı', rapper: 'rapçi', band: 'grup', musician: 'müzisyen', composer: 'besteci',
  dj: 'dicey', producer: 'prodüktör', songwriter: 'söz yazarı'
};
// Spotify genre tags are English; only the ones with a natural Turkish name are said in Turkish.
const GENRE_TR: Record<string, string> = {
  pop: 'pop', rock: 'rock', 'turkish pop': 'Türkçe pop', 'turkish rock': 'Türk rock', 'anadolu rock': 'Anadolu rock',
  'turkish hip hop': 'Türkçe rap', 'turkish trap': 'Türkçe trap', 'hip hop': 'hip hop', rap: 'rap', trap: 'trap',
  arabesk: 'arabesk', 'turkish folk': 'türkü', 'turkish classical': 'Türk sanat müziği', jazz: 'caz', metal: 'metal',
  'heavy metal': 'heavy metal', classical: 'klasik müzik', electronic: 'elektronik müzik', edm: 'elektronik dans müziği',
  'video game music': 'oyun müziği', soundtrack: 'film müziği', 'k-pop': 'K-pop', 'r&b': 'R&B', house: 'house', techno: 'tekno'
};

const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

// A fact value as said aloud ("Command & Conquer" → "and" / "ve").
const field = (f: FactLike, key: string, locale: Locale) => {
  const v = f.data[key]?.trim();
  return v ? capAt(tidy(v, locale), 48) : undefined;
};

function factParts(c: Ctx, locale: Locale) {
  const f = c.fact!;
  const get = (k: string) => field(f, k, locale);
  return {
    T: c.song?.t ?? get('title'),
    A: get('artist') ?? c.song?.a ?? undefined,
    year: yearOk(f.data.year) ? f.data.year : undefined,
    get
  };
}

function enTrivia(c: Ctx): Tpl[] {
  if (!c.fact) return [];
  const { T, A, year, get } = factParts(c, 'en');
  if (!T) return [];
  switch (c.fact.kind) {
    case 'released': return !year ? [] : [
      () => `${T}... did you know? This one came out in ${year}.`,
      () => `Here's ${T}, first released back in ${year}.`,
      () => `A trip back to ${year}... this is ${T}.`
    ];
    case 'album': { const album = get('album'); return !album ? [] : [
      () => `${T}... from the album ${album}${year ? `, released in ${year}` : ''}.`,
      () => `Did you know? ${T} is on the album ${album}.`,
      () => `Off the album ${album}... here's ${T}.`
    ]; }
    case 'soundtrack': {
      const work = get('work'), medium = MEDIUM_EN[c.fact.data.medium ?? ''];
      return !work ? [] : [
        () => medium && `Fun fact: ${T} comes from the ${year ? `${year} ` : ''}${medium} ${work}.`,
        () => `Straight from ${work}... here's ${T}.`,
        () => `${T}... did you know? It's from ${work}.`
      ];
    }
    case 'composer': {
      const composer = get('composer');
      if (!composer) return [];
      return c.fact.data.artist ? [
        () => `Fun fact: ${composer} wrote this one... ${T}.`,
        () => `${T}... written by ${composer}, who sings it too.`
      ] : [
        () => `${T}, composed by ${composer}.`,
        () => `Fun fact: ${T} was written by ${composer}.`
      ];
    }
    case 'origin': {
      const nat = get('nationality'), role = ROLE_EN[c.fact.data.role ?? ''];
      return !A || !nat || !role ? [] : [
        () => `Did you know? ${A} is ${article(nat)} ${nat} ${role}. Here's ${T}.`,
        () => `${T}... from ${A}, ${article(nat)} ${nat} ${role}.`
      ];
    }
    case 'born': return !A || !year ? [] : [
      () => `${A} was born in ${year}... and here's ${T}.`,
      () => `Fun fact: ${A} was born in ${year}. This is ${T}.`
    ];
    case 'genre': { const genre = get('genre'); return !genre ? [] : [
      () => `A little ${genre} for you... this is ${T}.`,
      () => A && `${A}, straight from the ${genre} scene... here's ${T}.`
    ]; }
    default: return [];
  }
}

function trTrivia(c: Ctx): Tpl[] {
  if (!c.fact) return [];
  const { T, A, year: yr, get } = factParts(c, 'tr');
  if (!T) return [];
  // Years in words: no digit-by-digit reading, and "yılında" needs no apostrophe.
  const year = yr ? trNumber(Number(yr)) : undefined;
  switch (c.fact.kind) {
    case 'released': return !year ? [] : [
      () => `${T}... Biliyor muydunuz? Bu şarkı ${year} yılında çıktı.`,
      () => `Şimdi ${T}... tam ${year} yılından bir parça!`,
      () => `${cap(year)} yılına gidiyoruz... ${T}!`
    ];
    case 'album': { const album = get('album'); return !album ? [] : [
      () => `${T}... ${album} albümünden geliyor.`,
      () => `Küçük bir bilgi: ${T}, ${album} albümünde yer alıyor.`,
      () => year && `${album} albümünden, ${year} yılından... ${T}!`
    ]; }
    case 'soundtrack': {
      const work = get('work'), medium = MEDIUM_TR[c.fact.data.medium ?? ''];
      return !work || !medium ? [] : [
        () => `Biliyor muydunuz? ${T} aslında ${work} ${medium[0]} için yapıldı.`,
        () => `${work} ${medium[1]}... ${T}!`,
        () => c.fact!.data.medium === 'game' && `Oyuncular buraya! ${work} oyunundan... ${T}.`,
        () => year && `${cap(year)} yapımı ${work} ${medium[1]}... Şimdi ${T}!`
      ];
    }
    case 'composer': {
      const composer = get('composer');
      if (!composer) return [];
      return c.fact.data.artist ? [
        () => `Bu şarkıyı ${composer} kendisi yazdı... ${T}!`,
        () => `${T}... Hem besteleyen hem söyleyen ${composer}.`
      ] : [
        () => `${T}... Bestesi ${composer} imzalı.`,
        () => `Besteci koltuğunda ${composer} var... Şimdi ${T}!`
      ];
    }
    case 'origin': {
      const nat = get('nationality'), role = ROLE_TR[c.fact.data.role ?? ''];
      return !A || !nat || !role ? [] : [
        () => `Biliyor muydunuz? ${A}, ${nat} bir ${role}. Şimdi... ${T}!`,
        () => `${T}... ${nat} ${role} ${A} geliyor!`
      ];
    }
    case 'born': return !A || !year ? [] : [
      () => `${A}, ${year} doğumlu... Şimdi ${T}!`,
      () => `Küçük bir bilgi: ${A} ${year} yılında doğdu. Ve şimdi... ${T}!`
    ];
    case 'genre': {
      const genre = GENRE_TR[(c.fact.data.genre ?? '').trim().toLowerCase()];
      return !genre ? [] : [
        () => `Biraz ${genre} zamanı... ${T}!`,
        () => A && `${A}, ${genre} dünyasından... ${T} geliyor!`
      ];
    }
    default: return [];
  }
}

// ── Picking ─────────────────────────────────────────────────

const finish = (text: string) => text
  .replace(/\s+/g, ' ')
  .replace(/\s+([,.!?])/g, '$1')
  .replace(/([!?])\.(?!\.)/g, '$1')
  .replace(/,\./g, '.')
  .trim();

function candidates(kind: LineKind, c: Ctx, locale: Locale): string[] {
  const tr = locale === 'tr';
  const tpls = kind === 'trivia' ? (tr ? trTrivia(c) : enTrivia(c)) : (tr ? TR : EN)[kind];
  return tpls.map(f => f(c)).filter((s): s is string => typeof s === 'string' && s.length > 0).map(finish);
}

function pickFrom(list: string[], rng: Rng, avoid?: string): string {
  let i = Math.min(list.length - 1, Math.floor(Math.max(0, rng()) * list.length));
  if (avoid && list.length > 1 && list[i] === avoid) i = (i + 1) % list.length;
  return list[i]!;
}

// When a kind has nothing to say (no previous song, unknown fact), the line falls back.
const FALLBACK: Partial<Record<LineKind, LineKind>> = { after: 'next', request: 'next', autoplay: 'next', trivia: 'next', next: 'jingle_tag' };

/**
 * One spoken line. Pure apart from `rng` (default Math.random) and `data.now`
 * (default: now). Never empty: a kind without the data it needs falls back to
 * 'next', and 'next' without a song to a station ID.
 */
export function buildLine(kind: LineKind, data: LineData, locale: Locale, rng: Rng = Math.random): string {
  const lang: Locale = locale === 'tr' ? 'tr' : 'en';
  const c: Ctx = {
    song: toSong(data.song, lang), prev: toSong(data.prev, lang), seed: toSong(data.seed, lang),
    server: speakServer(data.server, lang),
    count: Math.max(1, Math.floor(data.count ?? 1)),
    fact: data.fact ?? null,
    hour: lang === 'tr' ? istanbulHour(data.now ?? new Date()) : null
  };
  let k: LineKind | undefined = kind;
  while (k) {
    const list = candidates(k, c, lang);
    if (list.length) {
      let line = pickFrom(list, rng, data.avoid);
      // A greeting / milestone also hands over to the song that's starting.
      if ((k === 'greeting' || k === 'milestone') && c.song) {
        const tails = (lang === 'tr' ? TR_TAIL : EN_TAIL)[k].map(f => f(c)).filter((s): s is string => !!s);
        if (tails.length) line = finish(`${line} ${pickFrom(tails, rng)}`);
      }
      return line;
    }
    k = FALLBACK[k];
  }
  return lang === 'tr' ? 'Dicey Dikkat\'te kalın.' : 'You\'re locked in to D J Dikkat.';
}
