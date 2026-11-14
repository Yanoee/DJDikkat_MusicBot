/************************************************************
 * DJ DIKKAT - Music Bot
 * Speakable names
 * Turns a Discord display name into something the Radio Host
 * can read aloud: fancy fonts become plain letters, emojis,
 * zalgo, clan tags, links and mentions go, and names that are
 * empty, mostly digits or rude come back as null (the host
 * then says "a listener" / "bir dinleyici"). A name is read
 * out in a voice channel, so when in doubt it is dropped.
 * Author: Yanoee
 ************************************************************/
import type { Guild } from 'discord.js';
import { getFeatures } from './features.ts';

const MAX_LENGTH = 24;

// Bad words, matched on the folded form (see fold()): lowercase, ı→i, no
// accents, leetspeak digits as letters, doubled letters as one ("yarrak" →
// "yarak"). STRONG words are caught inside a word ("xXorospuXx"); WORD ones
// only as a whole word, because they hide inside real names (Işık → "isik"
// holds "sik", Ramazan holds "am", Hitchcock holds "cock").
const STRONG_EN = [
  'fuck', 'shit', 'bitch', 'whore', 'slut', 'nigger', 'nigga', 'faggot', 'retard', 'rapist', 'pussy',
  'penis', 'vagina', 'porn', 'hitler', 'tranny', 'dildo', 'horny', 'bastard', 'asshole', 'molest',
  'pedophil', 'motherf', 'blowjob', 'handjob', 'masturb', 'idiot', 'moron', 'cunts', 'boobies', 'nazis',
  'cocksuck', 'cumshot', 'fcuk', 'phuck', 'killyourself'
];
// No "boob": folded it is "bob", a real name.
const WORD_EN = [
  'ass', 'cunt', 'dick', 'dicks', 'dickhead', 'cock', 'cocks', 'sex', 'sexy', 'cum', 'tits', 'titties', 'anal', 'anus',
  'rape', 'raped', 'rapes', 'nazi', 'kys', 'kike', 'chink', 'spic', 'jizz', 'milf', 'wank', 'wanker', 'twat', 'prick',
  'piss', 'pedo', 'fag', 'fuk', 'fck', 'wtf', 'stfu', 'skank', 'douche', 'hoe', 'hoes'
];
const STRONG_TR = [
  'orospu', 'orosbu', 'orspu', 'orsbu', 'oruspu', 'yarrak', 'yarrag', 'dalyarak', 'amcik', 'aminako', 'siktir', 'sikis',
  'sikerim', 'skerim', 'sikeyim', 'siktim', 'siktig', 'sikik', 'sikko', 'ananisik', 'yavsak', 'serefsiz', 'pezevenk',
  'kahpe', 'gavat', 'ibne', 'ipne', 'kaltak', 'kancik', 'surtuk', 'gotveren', 'gotlek', 'gotos', 'tassak', 'kevase',
  'fahise', 'gerizekali', 'dangalak', 'pedofil', 'pickurusu'
];
const WORD_TR = [
  'am', 'amk', 'amq', 'aq', 'sik', 'sikim', 'sikimi', 'got', 'pic', 'oc', 'mal', 'salak', 'salaksin', 'aptal', 'aptalsin',
  'pust', 'yarak', 'amina', 'bok', 'boktan', 'pezo', 'kasar'
];

// Cyrillic letters that look Latin, so "оrоspu" with Cyrillic о is still caught.
const LOOKALIKE: Record<string, string> = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', к: 'k', і: 'i', ѕ: 's', ј: 'j', м: 'm', т: 't', в: 'b', н: 'h' };
// Leetspeak, only for matching (the spoken name keeps its digits).
const LEET: Record<string, string> = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '€': 'e', '|': 'i' };
// Small caps are Latin letters NFKC leaves alone; TTS would stumble on them.
const SMALL_CAPS: Record<string, string> = {
  ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ꜰ: 'f', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l', ᴍ: 'm',
  ɴ: 'n', ᴏ: 'o', ᴘ: 'p', ǫ: 'q', ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z'
};
// Accents a real name uses (Turkish ç ğ ş ö ü İ, é, ñ, å ...). Any other mark,
// or more than one on a letter, is zalgo and goes.
const KEEP_MARKS = new Set([0x300, 0x301, 0x302, 0x303, 0x304, 0x306, 0x307, 0x308, 0x30a, 0x30b, 0x30c, 0x327, 0x328]);

const BRACKETS = /\[[^\]]*\]|【[^】]*】|「[^」]*」|『[^』]*』|〔[^〕]*〕|〖[^〗]*〗|［[^］]*］|｛[^｝]*｝|\{[^}]*\}|\([^)]*\)|（[^）]*）|⟦[^⟧]*⟧|«[^»]*»/g;
const URL = /(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|net|org|gg|tv|io|me|tr|xyz|co|app|dev|link|ly|ru)(?:\/\S*)?/gi;
const MENTION = /<[@#][!&]?\d+>|(^|\s)@\S+/g;
const DISCRIMINATOR = /#\d{4}\b/g;

const swap = (text: string, map: Record<string, string>) => [...text].map(ch => map[ch] ?? ch).join('');

/** Matching form: lowercase, ı→i, no accents, leet as letters, anything else a space, doubles as one. */
function fold(text: string): string {
  const lower = swap(swap(text.normalize('NFKC'), SMALL_CAPS).toLowerCase().replace(/ı/g, 'i'), LOOKALIKE);
  return swap(lower.normalize('NFD').replace(/\p{M}/gu, ''), LEET)
    .replace(/[^a-z]+/g, ' ').replace(/([a-z])\1+/g, '$1').trim();
}

/** Words of a folded text, with runs of single letters joined ("a m k" → "amk"). */
function tokens(folded: string): string[] {
  const out: string[] = [];
  let run = '';
  for (const word of folded.split(' ').filter(Boolean)) {
    if (word.length === 1) { run += word; continue; }
    if (run) out.push(run);
    run = '';
    out.push(word);
  }
  if (run) out.push(run);
  return out;
}

const foldList = (words: string[]) => [...new Set(words.map(fold).filter(Boolean))];
const STRONG = foldList([...STRONG_EN, ...STRONG_TR]);
const WORDS = new Set(foldList([...WORD_EN, ...WORD_TR]));

/**
 * The built-in lists: strong words anywhere in a word, the rest as whole
 * words. Across words only when the words are the insult split up ("oro spu",
 * "kill yourself") or are all tiny pieces ("or os pu"): joined real names hide
 * strong words across the gap ("Heidi Otto" → "idiot", "Işık Işık" → "sikis").
 */
function rudeBuiltIn(words: string[]): boolean {
  if (words.some(w => WORDS.has(w) || STRONG.some(s => w.includes(s)))) return true;
  for (let i = 0; i < words.length; i++) {
    let joined = words[i]!;
    let tiny = joined.length <= 3;
    for (let j = i + 1; j < words.length; j++) {
      joined += words[j]!;
      tiny &&= words[j]!.length <= 3;
      if (WORDS.has(joined) || STRONG.includes(joined) || (tiny && STRONG.some(s => s.length >= 5 && joined.includes(s)))) return true;
    }
  }
  return false;
}

/**
 * The server's AutoMod keywords, Discord's syntax: "cat" whole word, "cat*" a
 * word starting with it, "*cat" ending with it, "*cat*" anywhere.
 */
function rudeForServer(words: string[], keywords: string[]): boolean {
  if (!keywords.length) return false;
  const line = ` ${words.join(' ')} `;
  const compact = words.join('');
  return keywords.some(raw => {
    const start = raw.startsWith('*');
    const end = raw.endsWith('*');
    const kw = fold(raw.replace(/\*/g, ' '));
    if (!kw) return false;
    if (start && end) return compact.includes(kw.replace(/ /g, ''));
    if (end) return words.some(w => w.startsWith(kw)) || line.includes(` ${kw}`);
    if (start) return words.some(w => w.endsWith(kw)) || line.includes(`${kw} `);
    return line.includes(` ${kw} `) || compact === kw.replace(/ /g, '');
  });
}

/** Keeps one real accent per letter, drops zalgo stacks and every other mark. */
function dropZalgo(text: string): string {
  return text.normalize('NFD').replace(/(\P{M})(\p{M}*)/gu, (_, base: string, marks: string) => {
    if (marks.length === 1 && KEEP_MARKS.has(marks.codePointAt(0)!) && (base + marks).normalize('NFC').length === 1) return base + marks;
    return base;
  }).normalize('NFC');
}

/** "IŞIL" → "Işıl", "BENDER" → "Bender"; short caps like "DJ" stay. Turkish casing when the word is Turkish. */
function fixCaps(word: string): string {
  if (word.length < 4 || word !== word.toUpperCase() || word === word.toLowerCase()) return word;
  const locale = /[ÇĞİŞÖÜçğışöü]/.test(word) ? 'tr' : 'en';
  return word[0] + word.slice(1).toLocaleLowerCase(locale);
}

/** One word: no edge punctuation, "xXnameXx" → "name", "aaaa" → "aa", gamer digits at the end gone. */
function tidyWord(word: string): string {
  let w = word.replace(/^['-]+|['-]+$/g, '');
  if (/^(?:x+X+x*|X+x+X*)$/.test(w)) return '';   // the "xX" of "xX_name_Xx"
  w = w.replace(/^x+X+(?=\p{L}{2})/u, '').replace(/(?<=\p{L}{2})X+x+$/u, '');
  w = w.replace(/(\p{L}|\d)\1{2,}/giu, '$1$1');
  if (/\p{L}/u.test(w)) w = w.replace(/(?<=\p{L})\d+$/u, '');
  return fixCaps(w.replace(/^['-]+|['-]+$/g, ''));
}

/** The name with fancy fonts, emojis, tags, links and noise removed; may come back empty. */
export function cleanName(displayName: string): string {
  let text = displayName.replace(URL, ' ').replace(MENTION, '$1 ').replace(DISCRIMINATOR, ' ');
  const untagged = text.replace(BRACKETS, ' ');
  // A name that is only a tag ("[Bender]") keeps what was inside.
  text = /[\p{L}\d]/u.test(untagged) ? untagged : text;
  text = dropZalgo(swap(text.normalize('NFKC'), SMALL_CAPS)).replace(/[’‘`´]/g, "'");
  text = text.replace(/[^\p{Script=Latin}\d' -]+/gu, ' ').replace(/(?<![\p{L}\d])['-]+|['-]+(?![\p{L}\d])/gu, ' ');
  const words = text.split(/\s+/).map(tidyWord).filter(Boolean);
  let name = words.join(' ');
  while (name.length > MAX_LENGTH && words.length > 1) {
    words.pop();
    name = words.join(' ');
  }
  return name.slice(0, MAX_LENGTH).trim();
}

/** Whether a name (raw or cleaned) hits the built-in lists or the given AutoMod keywords. */
export function isRudeName(name: string, keywords: string[] = []): boolean {
  const words = tokens(fold(name));
  return rudeBuiltIn(words) || rudeForServer(words, keywords);
}

/**
 * The display name as the host should say it, or null when nothing sayable is
 * left, it is mostly digits or a single letter, or it is rude (built-in EN/TR
 * lists + the server's own AutoMod keywords).
 */
export function speakableName(displayName: string, guild?: Pick<Guild, 'id'> | null): string | null {
  if (typeof displayName !== 'string' || !displayName.trim()) return null;
  const name = cleanName(displayName);
  const letters = name.match(/\p{L}/gu)?.length ?? 0;
  const digits = name.match(/\d/g)?.length ?? 0;
  const plain = fold(name).replace(/ /g, '');
  if (letters < 2 || digits > letters || new Set(plain).size < 2 || !/[aeiouy]/.test(plain)) return null;
  const keywords = guild ? getFeatures(guild.id).words.words : [];
  // The raw name is checked too: tags, links and symbols removed from the
  // spoken name can still carry the insult ("[0r0spu] Ali", "s.i.k").
  if (isRudeName(displayName.replace(DISCRIMINATOR, ' '), keywords) || isRudeName(name, keywords)) return null;
  return name;
}
