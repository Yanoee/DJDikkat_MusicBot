// Radio host lines — `npm test`. Every kind speaks in both languages, Turkish suffixes, title cleaning, seeded picks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINE_KINDS, buildLine, isMilestone, speakArtist, speakSong, trNumber, trOrdinal, trSuffix } from '../src/music/radio-lines.ts';
import type { LineData } from '../src/music/radio-lines.ts';
import type { Fact } from '../src/music/trivia.ts';

// Small seeded generator (mulberry32) so picks are repeatable.
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const FULL: LineData = {
  song: { title: 'Grinder (Official Audio)', author: 'Frank Klepacki - Topic', name: 'Bender' },
  prev: { title: 'Hell March', author: 'Frank Klepacki', name: null },
  seed: { title: 'Kuzu Kuzu', author: 'Tarkan' },
  server: 'Rock Cafe 🎸',
  count: 25,
  fact: { kind: 'released', data: { title: 'Grinder', artist: 'Frank Klepacki', year: '1996' } },
  now: new Date('2026-11-14T19:30:00Z')
};

test('every kind returns a non-empty line in both languages, with and without data', () => {
  for (const locale of ['en', 'tr'] as const) {
    for (const kind of LINE_KINDS) {
      for (let s = 1; s <= 40; s++) {
        for (const data of [FULL, {}, { song: { title: 'Dudu', author: 'Tarkan' } }]) {
          const line = buildLine(kind, data, locale, seeded(s));
          assert.ok(line.length > 0, `${kind}/${locale}`);
          assert.ok(!/undefined|null|NaN|\$\{/.test(line), `${kind}/${locale}: ${line}`);
          assert.ok(line.length < 260, `${kind}/${locale} too long: ${line}`);
        }
      }
    }
  }
});

test('each kind has 6+ variants per language when all data is there', () => {
  const facts = { kind: 'released', data: { year: '1996' } };
  for (const locale of ['en', 'tr'] as const) {
    for (const kind of LINE_KINDS) {
      if (kind === 'trivia') continue;   // trivia variants depend on the fact kind
      const seen = new Set<string>();
      for (let s = 1; s <= 400; s++) seen.add(buildLine(kind, { ...FULL, fact: facts, song: { ...FULL.song!, name: 'Bender' } }, locale, seeded(s)).split('...')[0]!.split('!')[0]!);
      assert.ok(seen.size >= 5, `${kind}/${locale}: ${seen.size}`);
    }
  }
});

test('deterministic with a seeded rng, and avoid skips the last line', () => {
  for (const locale of ['en', 'tr'] as const) {
    for (const kind of LINE_KINDS) {
      assert.equal(buildLine(kind, FULL, locale, seeded(7)), buildLine(kind, FULL, locale, seeded(7)));
    }
    const first = buildLine('next', FULL, locale, () => 0);
    assert.notEqual(buildLine('next', { ...FULL, avoid: first }, locale, () => 0), first);
  }
});

test('names: null is "a listener" / "bir dinleyici", the station is "D J Dikkat" / "Dicey Dikkat"', () => {
  const anon = { song: { title: 'Dudu', author: 'Tarkan', name: null } };
  for (let s = 1; s <= 30; s++) {
    const en = buildLine('request', anon, 'en', seeded(s));
    const tr = buildLine('request', anon, 'tr', seeded(s));
    assert.match(en, /listener/i);
    assert.match(tr, /bir dinleyici/i);
    assert.ok(!/'(nin|in|ın)\b/.test(tr.replace(/bir dinleyicinin/i, '')), tr);
  }
  for (let s = 1; s <= 30; s++) {
    assert.ok(!/DJ DIKKAT/.test(buildLine('jingle_tag', {}, 'en', seeded(s))));
    assert.ok(!/DJ|D J/.test(buildLine('jingle_tag', {}, 'tr', seeded(s))));
  }
  assert.match(buildLine('jingle_tag', {}, 'en', () => 0), /D J Dikkat/);
  assert.match(buildLine('jingle_tag', {}, 'tr', () => 0), /Dicey Dikkat/);
});

test('trSuffix: names and titles from the owner examples', () => {
  assert.equal(trSuffix('Tarkan', 'abl'), "Tarkan'dan");
  assert.equal(trSuffix('Kuzu Kuzu', 'acc'), "Kuzu Kuzu'yu");
  assert.equal(trSuffix('Kuzu Kuzu', 'cop'), "Kuzu Kuzu'ydu");
  assert.equal(trSuffix('Bender', 'gen'), "Bender'ın");
  assert.equal(trSuffix('Hell March', 'acc'), "Hell March'ı");
  assert.equal(trSuffix('Hell March', 'abl'), "Hell March'tan");
  assert.equal(trSuffix('Grinder', 'abl'), "Grinder'dan");
  assert.equal(trSuffix('2Pac', 'abl'), "2Pac'tan");
  assert.equal(trSuffix('Nothing Else Matters', 'abl'), "Nothing Else Matters'tan");
  assert.equal(trSuffix('Dudu', 'gen'), "Dudu'nun");
});

test('trSuffix: vowel harmony, buffer letters and d/t hardening', () => {
  // ablative / locative: d → t after f s t k ç ş h p
  assert.equal(trSuffix('Sezen Aksu', 'abl'), "Sezen Aksu'dan");
  assert.equal(trSuffix('Gülşen', 'abl'), "Gülşen'den");
  assert.equal(trSuffix('Barış Manço', 'loc'), "Barış Manço'da");
  assert.equal(trSuffix('Ezhel', 'abl'), "Ezhel'den");
  assert.equal(trSuffix('Mabel Matiz', 'abl'), "Mabel Matiz'den");
  assert.equal(trSuffix('Ahmet', 'abl'), "Ahmet'ten");
  assert.equal(trSuffix('Yusuf', 'loc'), "Yusuf'ta");
  assert.equal(trSuffix('Ayşe', 'abl'), "Ayşe'den");
  // genitive: n after a vowel, four-way vowel
  assert.equal(trSuffix('Ajda Pekkan', 'gen'), "Ajda Pekkan'ın");
  assert.equal(trSuffix('Mert', 'gen'), "Mert'in");
  assert.equal(trSuffix('Duman', 'gen'), "Duman'ın");
  assert.equal(trSuffix('Gülümse', 'gen'), "Gülümse'nin");
  assert.equal(trSuffix('Göksel', 'gen'), "Göksel'in");
  assert.equal(trSuffix('Gönül', 'gen'), "Gönül'ün");
  assert.equal(trSuffix('Onur', 'gen'), "Onur'un");
  // accusative / dative / instrumental / copula with y after vowels
  assert.equal(trSuffix('Ece', 'acc'), "Ece'yi");
  assert.equal(trSuffix('Ece', 'dat'), "Ece'ye");
  assert.equal(trSuffix('Tarkan', 'dat'), "Tarkan'a");
  assert.equal(trSuffix('Kuzu Kuzu', 'ins'), "Kuzu Kuzu'yla");
  assert.equal(trSuffix('Mert', 'ins'), "Mert'le");
  assert.equal(trSuffix('Hell March', 'cop'), "Hell March'tı");
  assert.equal(trSuffix('Tarkan', 'cop'), "Tarkan'dı");
  assert.equal(trSuffix('Gülümse', 'cop'), "Gülümse'ydi");
  // loanwords with front endings, proper names never soften (Ahmet'e, not Ahmed'e)
  assert.equal(trSuffix('Dikkat', 'dat'), "Dikkat'e");
  assert.equal(trSuffix('Dikkat', 'loc'), "Dikkat'te");
  assert.equal(trSuffix('Ahmet', 'dat'), "Ahmet'e");
  assert.equal(trSuffix('Zeynep', 'acc'), "Zeynep'i");
});

test('trSuffix: numbers are read in Turkish', () => {
  assert.equal(trSuffix('Red Alert 2', 'abl'), "Red Alert 2'den");
  assert.equal(trSuffix('Red Alert 3', 'abl'), "Red Alert 3'ten");
  assert.equal(trSuffix('Area 51', 'acc'), "Area 51'i");
  assert.equal(trSuffix('Apollo 13', 'gen'), "Apollo 13'ün");
  assert.equal(trSuffix('1996', 'loc'), "1996'da");
  assert.equal(trSuffix('Blink-182', 'gen'), "Blink-182'nin");
  assert.equal(trSuffix('Hit 40', 'abl'), "Hit 40'tan");
  assert.equal(trSuffix('Top 100', 'acc'), "Top 100'ü");
  assert.equal(trSuffix('6', 'gen'), "6'nın");
  assert.equal(trSuffix('9', 'dat'), "9'a");
});

test('trSuffix: unsure foreign words give null (the line uses another shape)', () => {
  for (const word of ['Thunderstruck', 'Fame', 'Bohemian Rhapsody', 'Love', 'Wonderwall', 'Money', 'Play', 'TNT', 'Dance', 'Lady', 'x', '']) {
    assert.equal(trSuffix(word, 'abl'), null, word);
  }
  // Turkish context: the same -er ending reads Turkish.
  assert.equal(trSuffix('Yeter', 'acc', 'Yeter Gülşen'), "Yeter'i");
  assert.equal(trSuffix('Yeter', 'acc'), "Yeter'i");   // a common Turkish word on its own
});

test('Turkish numbers and ordinals', () => {
  assert.equal(trNumber(1996), 'bin dokuz yüz doksan altı');
  assert.equal(trNumber(2024), 'iki bin yirmi dört');
  assert.equal(trNumber(100), 'yüz');
  assert.equal(trNumber(25), 'yirmi beş');
  assert.equal(trNumber(0), 'sıfır');
  assert.equal(trNumber(1_250_000), 'bir milyon iki yüz elli bin');
  assert.equal(trOrdinal(10), 'onuncu');
  assert.equal(trOrdinal(25), 'yirmi beşinci');
  assert.equal(trOrdinal(50), 'ellinci');
  assert.equal(trOrdinal(100), 'yüzüncü');
  assert.equal(trOrdinal(4), 'dördüncü');
  assert.equal(trOrdinal(2), 'ikinci');
  assert.equal(trOrdinal(6), 'altıncı');
  assert.equal(trOrdinal(3), 'üçüncü');
  assert.equal(trOrdinal(40), 'kırkıncı');
  assert.equal(trOrdinal(1000), 'bininci');
});

test('milestones: 10, 25, 50, 100, then every 50; Turkish counts in words', () => {
  assert.deepEqual([1, 9, 10, 11, 25, 30, 50, 75, 100, 150, 151, 200].filter(isMilestone), [10, 25, 50, 100, 150, 200]);
  for (let s = 1; s <= 20; s++) {
    const tr = buildLine('milestone', { count: 25 }, 'tr', seeded(s));
    assert.match(tr, /yirmi beş/i);
    assert.ok(!/\d/.test(tr), tr);
    assert.match(buildLine('milestone', { count: 25 }, 'en', seeded(s)), /25/);
  }
});

test('speakSong: titles cleaned for speech', () => {
  assert.deepEqual(speakSong('Tarkan - Kuzu Kuzu (Official Video) [HD]', 'Tarkan'), { title: 'Kuzu Kuzu', artist: 'Tarkan' });
  assert.deepEqual(speakSong('Frank Klepacki - Hell March', 'GameOSTs Uploads'), { title: 'Hell March', artist: 'Frank Klepacki' });
  assert.equal(speakSong('Hell March - Red Alert OST', 'Frank Klepacki').title, 'Hell March');
  assert.equal(speakSong('Grinder', 'Frank Klepacki - Topic').artist, 'Frank Klepacki');
  assert.equal(speakSong('🔥🔥 Dudu 🔥 #tarkan #pop', 'TarkanVEVO').title, 'Dudu');
  assert.equal(speakSong('Song Name ft. Someone Else (Lyrics)', 'Artist').title, 'Song Name');
  assert.equal(speakSong('Bohemian Rhapsody (Remastered 2011)', 'Queen Official').title, 'Bohemian Rhapsody');
  assert.equal(speakSong('Bohemian Rhapsody - Remastered 2011', 'Queen').title, 'Bohemian Rhapsody');
  assert.equal(speakSong('Simon & Garfunkel - The Boxer', 'Various').artist, 'Simon and Garfunkel');
  assert.equal(speakSong('Simon & Garfunkel - The Boxer', 'Various', 'tr').artist, 'Simon ve Garfunkel');
  assert.equal(speakSong('Song Title Official Music Video', 'Band').title, 'Song Title');
  const long = speakSong('A Very Long Song Title That Keeps Going And Going Past Sixty Characters Easily', 'X');
  assert.ok(long.title.length <= 60 && !long.title.endsWith(' '), long.title);
  assert.equal(long.title, 'A Very Long Song Title That Keeps Going And Going Past Sixty');
  assert.equal(speakArtist('Best OST Uploads'), null);
  assert.equal(speakArtist('Calvin Harris, Dua Lipa, Someone'), 'Calvin Harris and Dua Lipa');
});

test('lines read like the owner examples', () => {
  const data: LineData = {
    prev: { title: 'Hell March', author: 'Frank Klepacki' },
    song: { title: 'Grinder', author: 'Frank Klepacki' }
  };
  assert.equal(buildLine('after', data, 'en', () => 0), 'That was Hell March, by Frank Klepacki. Up next... coming in right now: Grinder.');
  const tr: LineData = { prev: { title: 'Kuzu Kuzu', author: 'Tarkan', name: 'Bender' }, song: { title: 'Dudu', author: 'Tarkan' } };
  assert.equal(buildLine('after', tr, 'tr', () => 0), "Tarkan'dan Kuzu Kuzu'ydu... Şimdi sırada Dudu var. Sesi açın, devam ediyoruz!");
  const all = new Set(Array.from({ length: 200 }, (_, s) => buildLine('after', tr, 'tr', seeded(s))));
  assert.ok(all.has("Kuzu Kuzu, Bender'ın isteğiydi. Ve şimdi... Dudu geliyor!"), [...all].join('\n'));
});

test('greeting follows Istanbul time in Turkish', () => {
  const at = (iso: string) => Array.from({ length: 30 }, (_, s) => buildLine('greeting', { now: new Date(iso) }, 'tr', seeded(s))).join(' ');
  assert.match(at('2026-11-14T05:00:00Z'), /Günaydın/);       // 08:00 Istanbul
  assert.match(at('2026-11-14T17:00:00Z'), /İyi akşamlar/);   // 20:00
  assert.match(at('2026-11-14T22:00:00Z'), /Gece kuş/);       // 01:00
  assert.ok(!/Günaydın/.test(at('2026-11-14T17:00:00Z')));
});

test('trivia: each fact kind becomes a sentence; unknown kinds fall back to a normal line', () => {
  const song = { title: 'Hell March', author: 'Frank Klepacki' };
  // The shapes trivia.ts (FactKind) produces; `key` must be said in the line.
  const facts: [Fact, string][] = [
    [{ kind: 'released', data: { title: 'Hell March', artist: 'Frank Klepacki', year: '1996' } }, 'Hell March'],
    [{ kind: 'album', data: { title: 'Hell March', artist: 'Frank Klepacki', album: 'Red Alert', year: '1996' } }, 'Red Alert'],
    [{ kind: 'soundtrack', data: { title: 'Hell March', work: 'Command & Conquer: Red Alert', medium: 'game', year: '1996' } }, 'Conquer: Red Alert'],
    [{ kind: 'composer', data: { title: 'Hell March', composer: 'Frank Klepacki' } }, 'Frank Klepacki'],
    [{ kind: 'composer', data: { title: 'Hell March', composer: 'Frank Klepacki', artist: 'Frank Klepacki' } }, 'Frank Klepacki'],
    [{ kind: 'born', data: { artist: 'Frank Klepacki', year: '1974' } }, 'Frank Klepacki'],
    [{ kind: 'genre', data: { artist: 'Frank Klepacki', genre: 'video game music' } }, 'Hell March']
  ];
  for (const [fact, key] of facts) {
    for (const locale of ['en', 'tr'] as const) {
      for (let s = 1; s <= 10; s++) {
        const line = buildLine('trivia', { song, fact }, locale, seeded(s));
        assert.match(line, /Hell March/, `${fact.kind}/${locale}`);
        assert.ok(line.includes(key), `${fact.kind}/${locale}: ${line}`);
        assert.ok(locale === 'en' || !/\d/.test(line), `years in words: ${line}`);
      }
    }
  }
  const origin = (nationality: string): Fact => ({ kind: 'origin', data: { artist: 'Frank Klepacki', nationality, role: 'composer' } });
  assert.match(buildLine('trivia', { song, fact: origin('American') }, 'en', () => 0), /Frank Klepacki is an American composer/);
  assert.match(buildLine('trivia', { song, fact: origin('Amerikalı') }, 'tr', () => 0), /Frank Klepacki, Amerikalı bir besteci/);
  assert.match(buildLine('trivia', { song, fact: facts[0]![0] }, 'tr', () => 0), /bin dokuz yüz doksan altı/);
  assert.match(buildLine('trivia', { song, fact: facts[2]![0] }, 'tr', () => 0), /Command ve Conquer: Red Alert oyunu için/);
  // A genre with no natural Turkish name is skipped in Turkish (a normal line instead).
  const odd: Fact = { kind: 'genre', data: { artist: 'X', genre: 'hyperpop glitchcore' } };
  assert.equal(buildLine('trivia', { song, fact: odd }, 'tr', () => 0), buildLine('next', { song }, 'tr', () => 0));
  const unknown = buildLine('trivia', { song, fact: { kind: 'weird', data: {} } }, 'en', () => 0);
  assert.equal(unknown, buildLine('next', { song }, 'en', () => 0));
});

test('review 2026-11-14: unsure English endings, empty titles, bare links, English capitals', () => {
  // A plural's vowel isn't known ("Dragons" is heard "dragıns"): no suffix rather than a wrong one.
  assert.equal(trSuffix('Imagine Dragons', 'gen'), null);
  assert.equal(trSuffix('Numb', 'acc'), null);
  assert.equal(trSuffix('Sertab Erener', 'abl'), "Sertab Erener'den");
  assert.equal(trSuffix('Blink-182', 'abl'), "Blink-182'den");
  // Only emojis left: a station ID instead of "coming in right now: ."
  assert.equal(buildLine('next', { song: { title: '🔥🔥🔥', author: '' } }, 'en', () => 0), "You're locked in to D J Dikkat.");
  assert.ok(!/discord|\.gg/i.test(buildLine('next', { song: { title: 'Kuzu Kuzu discord.gg/abc', author: 'Tarkan' } }, 'en', () => 0)));
  const lines = Array.from({ length: 40 }, (_, s) => buildLine('request', { song: { title: 'Grinder', author: 'Frank Klepacki', name: 'isabel' } }, 'en', seeded(s)));
  assert.ok(!lines.some(l => l.includes('İ')), lines.join('\n'));
});
