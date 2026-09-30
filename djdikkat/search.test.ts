// Search engine checks — `npm test`. Candidate lists are real YouTube Music
// results (2026-10-01) for queries the old scorer got wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Track } from 'shoukaku';
import { fold, normalizeLink, rankCandidates } from './search.ts';

const track = (title: string, author: string, seconds: number, isStream = false): Track => ({
  encoded: '',
  info: {
    identifier: `${title}|${author}|${seconds}`, isSeekable: true, author, length: seconds * 1000, isStream,
    position: 0, title, uri: 'https://music.youtube.com/watch?v=x', sourceName: 'ytmusic'
  },
  pluginInfo: {}
});

/** Title and author of the winner for `query` among `tracks` (in YouTube Music's order). */
function pick(query: string, tracks: Track[], expectedMs?: number): string {
  const [best] = rankCandidates(query, tracks.map((t, rank) => ({ track: t, rank, source: 'ytm' as const })), expectedMs);
  return `${best!.track.info.title} | ${best!.track.info.author}`;
}

test('fold handles Turkish letters and accents', () => {
  assert.equal(fold('Barış Manço — Dönence'), 'baris manco — donence');
  assert.equal(fold('İZMİR Çiçek Ağaç'), 'izmir cicek agac');
  assert.equal(fold('Beyoncé'), 'beyonce');
});

test('short words do not match inside longer ones', () => {
  assert.equal(pick('in the end', [
    track('In the End', 'Linkin Park', 217),
    track('In The End', 'Tommee Profitt', 235),
    track('End of the Night', 'The Doors', 171)
  ]), 'In the End | Linkin Park');
});

test('an artist named like the song does not win twice', () => {
  assert.equal(pick('kuzu kuzu', [
    track('Kuzu Kuzu Orijinal Versiyon', 'Tarkan', 234),
    track('Dudu', 'Tarkan', 278),
    track('Kuzu Kuzu', 'Cem Yılmaz', 238),
    track('Kuzu Kuzu', 'RAMAZAN KUZU', 223)
  ]), 'Kuzu Kuzu Orijinal Versiyon | Tarkan');
});

test('typing without Turkish letters still matches', () => {
  const tracks = [track('Dönence', 'Barış Manço', 405), track('Domates Biber Patlıcan', 'Barış Manço', 267)];
  const [best] = rankCandidates('baris manco donence', tracks.map((t, rank) => ({ track: t, rank, source: 'ytm' as const })));
  assert.equal(best!.track.info.title, 'Dönence');
  assert.equal(best!.coverage, 1);
});

test('unrequested versions lose, requested ones win', () => {
  assert.equal(pick('believer', [
    track('Believer (Nightcore)', 'Nightcore Fan', 180),
    track('Believer', 'Imagine Dragons', 205)
  ]), 'Believer | Imagine Dragons');
  assert.equal(pick('duman bu aksam live', [
    track('Bu Akşam', 'Duman', 176),
    track('Bu Akşam (Live At Rock’n Coke Festival, İstanbul / 2006)', 'Duman', 187)
  ]), 'Bu Akşam (Live At Rock’n Coke Festival, İstanbul / 2006) | Duman');
});

test('livestreams lose unless asked for', () => {
  assert.equal(pick('lofi beats', [
    track('lofi beats radio 24/7', 'Lofi Girl', 0, true),
    track('lofi beats to study to', 'Chillhop', 180)
  ]), 'lofi beats to study to | Chillhop');
});

test('a weak match is not confident', () => {
  const [best] = rankCandidates('yalın ah be kalbim', [
    track('Sevgili Kalp Sancım', 'Yalın', 238), track('Ah Be Kardeşim', 'Yalın', 236)
  ].map((t, rank) => ({ track: t, rank, source: 'ytm' as const })));
  assert.ok(best!.coverage < 0.7, `coverage ${best!.coverage}`);
});

test('Spotify duration picks the matching version', () => {
  const [best] = rankCandidates('Imagine Dragons Believer', [
    track('Believer', 'Imagine Dragons', 230), track('Believer', 'Imagine Dragons', 204)
  ].map((t, rank) => ({ track: t, rank, source: 'ytm' as const })), 204_000);
  assert.equal(best!.track.info.length, 204_000);
});

test('normalizeLink', () => {
  const cases: [string, string | null][] = [
    ['https://www.youtube.com/watch?v=NAHRpEqgcL4&list=RDNAHRpEqgcL4&start_radio=1', 'https://www.youtube.com/watch?v=NAHRpEqgcL4'],
    ['https://www.youtube.com/watch?v=kJQP7kiw5Fk&list=PLirAqAtl_h2r5g8xGajEwdXd3x1sZh8hC&index=3', 'https://www.youtube.com/watch?v=kJQP7kiw5Fk'],
    ['https://m.youtube.com/watch?v=NAHRpEqgcL4&feature=share', 'https://www.youtube.com/watch?v=NAHRpEqgcL4'],
    ['www.youtube.com/watch?v=NAHRpEqgcL4', 'https://www.youtube.com/watch?v=NAHRpEqgcL4'],
    ['youtu.be/NAHRpEqgcL4?si=abc&list=PL1', 'https://youtu.be/NAHRpEqgcL4'],
    ['https://www.youtube.com/playlist?list=PLirAqAtl_h2r5g8xGajEwdXd3x1sZh8hC', 'https://www.youtube.com/playlist?list=PLirAqAtl_h2r5g8xGajEwdXd3x1sZh8hC'],
    ['https://open.spotify.com/track/0pqnGHJpmpxLKifKRmU6WP?si=123', 'https://open.spotify.com/track/0pqnGHJpmpxLKifKRmU6WP'],
    ['tarkan kuzu kuzu', null],
    ['ac/dc', null],
    ['despacito', null]
  ];
  for (const [input, expected] of cases) assert.equal(normalizeLink(input), expected, input);
});
