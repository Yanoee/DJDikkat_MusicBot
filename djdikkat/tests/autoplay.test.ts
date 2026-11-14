// Smart autoplay checks — `npm test`. The resolver is a fake NodeLink that
// answers the identifiers autoplay.ts really asks for (ytrec:, YouTube Mix
// links, spsearch:, ytmsearch:, sprec:) with canned Lavalink v4 responses.
// The drift case is the owner's report from 2026-11-14: after RA2 Yuri's
// Revenge it went RA3 Soviet March (ok) → Farewell of Slavianka → Worker's March.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LavalinkResponse, Track } from 'shoukaku';
import type { QueueTrack } from '../src/lib/types.ts';
import {
  avoidFor, diversify, noteRejected, pickSeeds, pickSimilar, playedKeys, scoreCandidate, songKey, sourcePlan, variantsOf
} from '../src/music/autoplay.ts';
import type { Hit, Seed, SeedEntry } from '../src/music/autoplay.ts';

// Autoplay logs one debug line per batch; keep test output clean.
console.debug = () => {};

let nextId = 0;
/** A track; YouTube ones get an 11-character video id so autoplay can ask for their radio. */
function track(title: string, author: string, opts: { source?: string; seconds?: number; id?: string; stream?: boolean } = {}): Track {
  const source = opts.source ?? 'youtube';
  const id = opts.id ?? (source === 'spotify' ? `sp${++nextId}` : `vid${String(++nextId).padStart(8, '0')}`);
  const uri = source === 'spotify' ? `https://open.spotify.com/track/${id}` : `https://www.youtube.com/watch?v=${id}`;
  return {
    encoded: id,
    info: { identifier: id, isSeekable: true, author, length: (opts.seconds ?? 200) * 1000, isStream: !!opts.stream, position: 0, title, uri, sourceName: source },
    pluginInfo: {}
  };
}
const queued = (t: Track, requesterId = 'u1'): QueueTrack => ({ ...t, requesterId, requesterTag: 'someone' });
const search = (tracks: Track[]) => ({ loadType: 'search', data: tracks }) as LavalinkResponse;
const playlist = (tracks: Track[]) => ({ loadType: 'playlist', data: { info: { name: 'Mix', selectedTrack: -1 }, pluginInfo: {}, tracks } }) as LavalinkResponse;

/** A fake NodeLink: first matching prefix wins; unknown identifiers come back empty. Records every call. */
function fakeResolver(routes: [prefix: string, answer: () => Promise<LavalinkResponse | undefined> | LavalinkResponse | undefined][]) {
  const asked: string[] = [];
  const resolve = async (identifier: string) => {
    asked.push(identifier);
    const route = routes.find(([prefix]) => identifier.startsWith(prefix));
    return route ? route[1]() : ({ loadType: 'empty', data: {} } as LavalinkResponse);
  };
  return { resolve, asked };
}
const mixOf = (id: string) => `https://www.youtube.com/watch?v=${id}&list=RD${id}`;
const titles = (picks: { track: Track }[]) => picks.map(p => p.track.info.title);
const seed = (t: Track, weight = 1): Seed => ({ track: t, weight });

const MIN = 60_000;
const NOW = 1_800_000_000_000;

// ── pickSeeds ────────────────────────────────────────────────

test('pickSeeds: max 3 from the last 30 min, newest first, weights 1 / 0.6 / 0.35', () => {
  const a = queued(track('Song A', 'Artist A'));
  const b = queued(track('Song B', 'Artist B'));
  const c = queued(track('Song C', 'Artist C'));
  const d = queued(track('Song D', 'Artist D'));
  const old = queued(track('Old Song', 'Artist E'));
  // Deliberately out of order: pickSeeds must sort by time itself.
  const requested: SeedEntry[] = [
    { track: c, at: NOW - 10 * MIN }, { track: a, at: NOW - 1 * MIN }, { track: old, at: NOW - 45 * MIN },
    { track: d, at: NOW - 20 * MIN }, { track: b, at: NOW - 5 * MIN }
  ];
  const seeds = pickSeeds(requested, NOW);
  assert.deepEqual(seeds.map(s => s.track.info.title), ['Song A', 'Song B', 'Song C']);
  assert.deepEqual(seeds.map(s => s.weight), [1, 0.6, 0.35]);
});

test('pickSeeds: songs older than 30 min are left out', () => {
  const recent = queued(track('Recent', 'X'));
  const old = queued(track('Old', 'Y'));
  const seeds = pickSeeds([{ track: recent, at: NOW - 2 * MIN }, { track: old, at: NOW - 31 * MIN }], NOW);
  assert.deepEqual(seeds.map(s => s.track.info.title), ['Recent']);
});

test('pickSeeds: nothing in 30 min → just the newest one; nothing at all → []', () => {
  const older = queued(track('Older', 'X'));
  const newer = queued(track('Newer', 'Y'));
  const seeds = pickSeeds([{ track: older, at: NOW - 5 * 60 * MIN }, { track: newer, at: NOW - 2 * 60 * MIN }], NOW);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0]!.track.info.title, 'Newer');
  assert.equal(seeds[0]!.weight, 1);
  assert.deepEqual(pickSeeds([], NOW), []);
});

test('pickSeeds: the same song requested twice counts once', () => {
  const t = track('Gülümse', 'Sezen Aksu');
  const other = queued(track('Other', 'Z'));
  const seeds = pickSeeds([
    { track: queued(t), at: NOW - 1 * MIN }, { track: queued({ ...t }), at: NOW - 3 * MIN }, { track: other, at: NOW - 4 * MIN }
  ], NOW);
  assert.deepEqual(seeds.map(s => s.track.info.title), ['Gülümse', 'Other']);
});

test('pickSeeds: never more than 3 seeds, even with many requests', () => {
  const requested = Array.from({ length: 10 }, (_, i) => ({ track: queued(track(`Song ${i}`, `Artist ${i}`)), at: NOW - i * MIN }));
  assert.equal(pickSeeds(requested, NOW).length, 3);
});

// ── Pure helpers ─────────────────────────────────────────────

test('variantsOf spots unwanted versions, not normal titles', () => {
  assert.ok(variantsOf('Believer (Nightcore)').has('nightcore'));
  assert.ok(variantsOf('Believer 8D Audio').has('8d'));
  assert.ok(variantsOf('Hell March 1 Hour').has('hours'));
  assert.ok(variantsOf('Song (slowed + reverb)').has('slowed'));
  assert.ok(variantsOf('Song - Sped Up').has('sped'));
  assert.equal(variantsOf('Hell March').size, 0);
  assert.equal(variantsOf('Red Alert 3 Theme - Soviet March').size, 0);
});

test('songKey / playedKeys: the same song from another source has the same key', () => {
  assert.equal(songKey('Gülümse (Official Video)', 'Sezen Aksu'), songKey('Gülümse', 'Sezen Aksu'));
  assert.equal(songKey('Levitating', 'Dua Lipa - Topic'), songKey('Levitating', 'Dua Lipa'));
  const keys = playedKeys('Hell March', 'Frank Klepacki', 'https://www.youtube.com/watch?v=abc');
  assert.ok(keys.includes('https://www.youtube.com/watch?v=abc'));
  assert.ok(keys.includes(songKey('Hell March', 'Frank Klepacki')));
});

// Bench 2026-11-14: fan uploads of one soundtrack song, the uploader as "artist".
test('song core: the seed again from another uploader ("07. ... (Re-Master, HD/HQ)") is left out', async () => {
  const s = track("Command & Conquer Red Alert 2 - Yuri's Revenge Expansion Music - Trance L. Vania", 'medalex195', { id: 'TranceVania' });
  const again = track("Command & Conquer: Red Alert 2 Yuri's Revenge - 07. Trance L. Vania (Re-Master, HD/HQ)", 'Repulsive Music', { source: 'ytmusic' });
  const other = track('Red Alert 2 - Yuri\'s Revenge Music - Bully Kit', '95ellington', { source: 'ytmusic' });
  const picks = titles(await pickSimilar(fakeResolver([['ytrec:', () => search([again, other])]]).resolve, [seed(s)], new Set(), { count: 3 }));
  assert.ok(!picks.includes(again.info.title), picks.join(' / '));
  assert.ok(picks.includes(other.info.title), picks.join(' / '));
  // Played history keeps titles only: the same check through the played set.
  const played = new Set(playedKeys(s.info.title, '', 'https://example.com/elsewhere'));
  const s2 = track('Hell March', 'Frank Klepacki', { id: 'HellMarch02' });
  const picks2 = titles(await pickSimilar(fakeResolver([['ytrec:', () => search([again, other])]]).resolve, [seed(s2)], played, { count: 3 }));
  assert.ok(!picks2.includes(again.info.title), picks2.join(' / '));
});

test('song core: one song from two uploaders comes once per batch', async () => {
  const s = track("Command & Conquer Red Alert 2 - Yuri's Revenge Expansion Music - Trance L. Vania", 'medalex195', { id: 'TranceVani2' });
  const a = track("Command & Conquer Red Alert 2 - Yuri's Revenge Expansion Music - Deceiver", 'medalex195');
  const b = track("Command & Conquer: Red Alert 2 Yuri's Revenge - 08. Deceiver (Re-Master, HD/HQ)", 'Repulsive Music', { source: 'ytmusic' });
  const c = track("Red Alert 2 - Yuri's Revenge Music - Brain Freeze", '95ellington', { source: 'ytmusic' });
  const picks = titles(await pickSimilar(fakeResolver([['ytrec:', () => search([a, b, c])]]).resolve, [seed(s)], new Set(), { count: 3 }));
  assert.equal(picks.filter(t => t.includes('Deceiver')).length, 1, picks.join(' / '));
});

test('song core: same one-word title by unrelated artists, no shared context, both allowed', async () => {
  const s = track('Red Alert 2 - Tension', 'capt. Slygor', { id: 'TensionRA2x' });
  const t1 = track('Tension', 'Some Band');
  const t2 = track('Night Drive - Tension', 'Synth Person');
  assert.deepEqual(playedKeys(t1.info.title, t1.info.author).filter(k => playedKeys(s.info.title, s.info.author).includes(k)), []);
  assert.deepEqual(playedKeys(t2.info.title, t2.info.author).filter(k => playedKeys(s.info.title, s.info.author).includes(k)), []);
  const seeds = [seed(track('Calm', 'Some Band', { id: 'CalmSomeBnd' })), seed(track('Night Drive - Overture', 'Synth Person', { id: 'NightDrive1' }), 0.6)];
  const picks = titles(await pickSimilar(fakeResolver([['ytrec:', () => search([s, t1, t2])]]).resolve, seeds, new Set(), { count: 3 }));
  assert.ok(picks.includes('Tension') && picks.includes('Night Drive - Tension'), picks.join(' / '));
});

test('sourcePlan: home service first, the other one second', () => {
  const yt = sourcePlan(track('x', 'y', { source: 'youtube' }), true);
  assert.equal(yt[0]!.name, 'ytrec');
  assert.ok(yt.some(p => p.name === 'sprec' && !p.primary));
  const sp = sourcePlan(track('x', 'y', { source: 'spotify' }), true);
  assert.equal(sp[0]!.name, 'sprec');
  assert.ok(sp.some(p => p.name.startsWith('yt') && !p.primary));
});

test('diversify: one per artist when possible, never more than two', () => {
  const items = ['A', 'A', 'A', 'B', 'C'].map((artist, i) => ({ track: track(`Song ${i}`, artist) }));
  assert.deepEqual(diversify(items, 3).map(i => i.track.info.author), ['A', 'B', 'C']);
  const onlyA = ['A', 'A', 'A', 'A'].map((artist, i) => ({ track: track(`Song ${i}`, artist) }));
  assert.equal(diversify(onlyA, 3).length, 2);
});

test('scoreCandidate: related songs beat unrelated ones from the same list', () => {
  const s = [seed(track("Red Alert 2 Yuri's Revenge - Brain Freeze", 'Frank Klepacki'))];
  const hit = (rank: number): Hit[] => [{ seed: 0, list: 'ytrec', rank, primary: true }];
  const sameArtist = scoreCandidate(track('Hell March 3', 'Frank Klepacki'), hit(5), s);
  const sharedWords = scoreCandidate(track('Red Alert 3 Theme - Soviet March', 'James Hannigan'), hit(5), s);
  // Unrelated songs even get the better rank: relevance has to outweigh list order.
  const slavianka = scoreCandidate(track('Farewell of Slavianka', 'Red Army Choir'), hit(0), s);
  const workers = scoreCandidate(track("Worker's March", 'Soviet Music Archive'), hit(1), s);
  assert.ok(sameArtist.related && sharedWords.related);
  assert.ok(!slavianka.related && !workers.related);
  for (const good of [sameArtist, sharedWords]) for (const bad of [slavianka, workers]) assert.ok(good.score > bad.score, `${good.score} > ${bad.score}`);
});

test('scoreCandidate: streams score -1, variants and very long uploads lose', () => {
  const s = [seed(track('Believer', 'Imagine Dragons'))];
  const hit: Hit[] = [{ seed: 0, list: 'ytrec', rank: 0, primary: true }];
  assert.equal(scoreCandidate(track('Believer Radio', 'Imagine Dragons', { stream: true }), hit, s).score, -1);
  const plain = scoreCandidate(track('Thunder', 'Imagine Dragons'), hit, s).score;
  assert.ok(scoreCandidate(track('Thunder (Nightcore)', 'Imagine Dragons'), hit, s).score < plain);
  assert.ok(scoreCandidate(track('Thunder 1 Hour', 'Imagine Dragons', { seconds: 3600 }), hit, s).score < plain);
  // When the seed is such a version, the same version is fine.
  const nc = [seed(track('Believer (Nightcore)', 'Nightcore Land'))];
  const ncPlain = scoreCandidate(track('Thunder', 'Nightcore Land'), hit, nc).score;
  assert.ok(scoreCandidate(track('Thunder (Nightcore)', 'Nightcore Land'), hit, nc).score >= ncPlain);
});

test('scoreCandidate: the avoid set lowers matching artists and words', () => {
  const s = [seed(track('Hell March', 'Frank Klepacki'))];
  const hit: Hit[] = [{ seed: 0, list: 'ytrec', rank: 0, primary: true }];
  const cand = track('Grinder', 'Frank Klepacki');
  const free = scoreCandidate(cand, hit, s).score;
  const avoided = scoreCandidate(cand, hit, s, { artists: new Set(['frankklepacki']), words: new Set() }).score;
  assert.ok(avoided < free - 0.3, `${avoided} < ${free} - 0.3`);
});

// ── Avoid set ────────────────────────────────────────────────

test('noteRejected / avoidFor: per guild, expires after an hour', () => {
  const t0 = NOW;
  noteRejected('guild-avoid-1', track('Farewell of Slavianka', 'Red Army Choir'), t0);
  const avoid = avoidFor('guild-avoid-1', t0 + 1000);
  assert.ok(avoid.artists.has('redarmychoir'));
  assert.ok(avoid.words.has('slavianka'));
  assert.equal(avoidFor('guild-avoid-other', t0).artists.size, 0);
  assert.equal(avoidFor('guild-avoid-1', t0 + 61 * MIN).artists.size, 0);
});

test('noteRejected: the avoid list is capped', () => {
  for (let i = 0; i < 100; i++) noteRejected('guild-avoid-cap', track(`Song ${i}`, `Artist Number${i}`), NOW + i);
  const avoid = avoidFor('guild-avoid-cap', NOW + 200);
  assert.ok(avoid.artists.size > 0 && avoid.artists.size <= 50, `${avoid.artists.size}`);
  assert.ok(avoid.artists.has('artistnumber99'));
  assert.ok(!avoid.artists.has('artistnumber0'));
});

// ── pickSimilar with a fake NodeLink ─────────────────────────

/** The owner's case: an RA2 Yuri's Revenge seed whose YouTube radio also offers Soviet marches. */
function yuriCase() {
  const seedTrack = track("Red Alert 2 Yuri's Revenge Soundtrack - Brain Freeze", 'Frank Klepacki', { id: 'RA2yuri0001' });
  const sovietMarch = track('Red Alert 3 Theme - Soviet March', 'James Hannigan');
  const hellMarch = track('Hell March 3', 'Frank Klepacki');
  const grinder = track('Grinder (Red Alert 2 Soundtrack)', 'Frank Klepacki');
  const yuriTheme = track("Yuri's Revenge - Destroy", 'C&C Music Archive');
  const slavianka = track('Farewell of Slavianka', 'Red Army Choir');
  const workers = track("Worker's March", 'Soviet Music Archive');
  const { resolve, asked } = fakeResolver([
    // Unrelated marches on top, as YouTube's radio does after a few hops.
    ['ytrec:', () => search([slavianka, workers, sovietMarch, hellMarch, grinder, yuriTheme])],
    [mixOf('RA2yuri0001'), () => playlist([seedTrack, workers, hellMarch, yuriTheme, sovietMarch])],
    ['spsearch:', () => search([track('Brain Freeze', 'Frank Klepacki', { source: 'spotify', id: 'spBrainFreeze' })])],
    ['sprec:', () => search([track('Act On Instinct', 'Frank Klepacki', { source: 'spotify' }), track('Farewell of Slavianka', 'Red Army Choir', { source: 'spotify' })])]
  ]);
  return { seedTrack, sovietMarch, slavianka, workers, resolve, asked };
}

test('drift case: unrelated marches are not picked over related songs', async () => {
  const c = yuriCase();
  const picks = await pickSimilar(c.resolve, [seed(c.seedTrack)], new Set(), { count: 3 });
  assert.equal(picks.length, 3);
  const picked = titles(picks);
  assert.ok(!picked.includes('Farewell of Slavianka'), picked.join(' / '));
  assert.ok(!picked.includes("Worker's March"), picked.join(' / '));
  assert.ok(!picked.includes(c.seedTrack.info.title), 'the seed itself is not replayed');
  // It asked YouTube's own radio for the YouTube seed.
  assert.ok(c.asked.includes('ytrec:RA2yuri0001'), c.asked.join(' '));
});

test('every pick carries its seed and a score, best first', async () => {
  const c = yuriCase();
  const second = track('Hell March', 'Frank Klepacki', { id: 'HellMarch01' });
  const picks = await pickSimilar(c.resolve, [seed(c.seedTrack), seed(second, 0.6)], new Set(), { count: 3 });
  assert.ok(picks.length > 0);
  for (const p of picks) {
    assert.ok(p.seed === c.seedTrack || p.seed === second, 'seed is one of the seeds');
    assert.equal(typeof p.score, 'number');
    assert.ok(Number.isFinite(p.score));
  }
  for (let i = 1; i < picks.length; i++) assert.ok(picks[i - 1]!.score >= picks[i]!.score);
});

test('played songs are left out, by link and by song key', async () => {
  const c = yuriCase();
  const all = titles(await pickSimilar(c.resolve, [seed(c.seedTrack)], new Set(), { count: 10 }));
  assert.ok(all.includes('Red Alert 3 Theme - Soviet March'));
  assert.ok(all.includes('Hell March 3'));
  const played = new Set([c.sovietMarch.info.uri!, songKey('Hell March 3', 'Frank Klepacki')]);
  const picks = titles(await pickSimilar(c.resolve, [seed(c.seedTrack)], played, { count: 10 }));
  assert.ok(!picks.includes('Red Alert 3 Theme - Soviet March'), picks.join(' / '));
  assert.ok(!picks.includes('Hell March 3'), picks.join(' / '));
});

test('diversity: at most two songs by one artist in a batch', async () => {
  const s = track('Hell March', 'Frank Klepacki', { id: 'HellMarch01' });
  const { resolve } = fakeResolver([
    ['ytrec:', () => search([
      track('Grinder', 'Frank Klepacki'), track('Act On Instinct', 'Frank Klepacki'), track('Hell March 2', 'Frank Klepacki'),
      track('Bigfoot', 'Frank Klepacki'), track('Red Alert 3 Theme - Soviet March', 'James Hannigan')
    ])]
  ]);
  const picks = await pickSimilar(resolve, [seed(s)], new Set(), { count: 3 });
  const klepacki = picks.filter(p => p.track.info.author === 'Frank Klepacki').length;
  assert.ok(klepacki <= 2, `${klepacki} by one artist`);
  assert.ok(picks.some(p => p.track.info.author === 'James Hannigan'), 'the other artist gets a slot');
});

test('variants (nightcore, 8D, 1 hour) are dropped unless the seed is one', async () => {
  const s = track('Believer', 'Imagine Dragons', { id: 'Believer001' });
  const recs = () => search([
    track('Thunder (Nightcore)', 'Nightcore Land'), track('Radioactive 8D Audio', '8D Tunes'), track('Demons 1 Hour', 'Loop Channel', { seconds: 3600 }),
    track('Thunder', 'Imagine Dragons'), track('Natural', 'Imagine Dragons'), track('Enemy', 'Imagine Dragons')
  ]);
  const picks = titles(await pickSimilar(fakeResolver([['ytrec:', recs]]).resolve, [seed(s)], new Set(), { count: 3 }));
  for (const bad of ['Thunder (Nightcore)', 'Radioactive 8D Audio', 'Demons 1 Hour']) assert.ok(!picks.includes(bad), picks.join(' / '));

  // A nightcore seed may get nightcore songs.
  const nc = track('Believer (Nightcore)', 'Nightcore Land', { id: 'NcBeliever1' });
  const ncPicks = titles(await pickSimilar(fakeResolver([['ytrec:', () => search([
    track('Thunder (Nightcore)', 'Nightcore Land'), track('Monster (Nightcore)', 'Nightcore Land')
  ])]]).resolve, [seed(nc)], new Set(), { count: 3 }));
  assert.ok(ncPicks.some(t => t.includes('Nightcore')), ncPicks.join(' / '));
});

test('live streams are never picked', async () => {
  const s = track('Lofi Song', 'Lofi Artist', { id: 'LofiSong001' });
  const { resolve } = fakeResolver([['ytrec:', () => search([
    track('lofi hip hop radio - beats to relax/study to', 'Lofi Artist', { stream: true }),
    track('Lofi Song 2', 'Lofi Artist')
  ])]]);
  const picks = await pickSimilar(resolve, [seed(s)], new Set(), { count: 3 });
  assert.ok(picks.every(p => !p.track.info.isStream));
  assert.ok(picks.length >= 1);
});

test('the avoid set keeps a rejected artist out when there are alternatives', async () => {
  const s = track('Hell March', 'Frank Klepacki', { id: 'HellMarch01' });
  const recs = () => search([
    track('Grinder', 'Frank Klepacki'), track('Red Alert 3 Theme - Soviet March', 'James Hannigan'),
    track('Hell March Remake', 'Some Fan'), track('Command and Conquer Hell March', 'Another Fan')
  ]);
  const free = titles(await pickSimilar(fakeResolver([['ytrec:', recs]]).resolve, [seed(s)], new Set(), { count: 1 }));
  noteRejected('guild-avoid-pick', track('Act On Instinct', 'Frank Klepacki'));
  const avoid = avoidFor('guild-avoid-pick');
  assert.ok(avoid.artists.has('frankklepacki'));
  // Same lists, avoid set passed explicitly and via the guild id.
  for (const opts of [{ avoid }, { guildId: 'guild-avoid-pick' }]) {
    const picks = await pickSimilar(fakeResolver([['ytrec:', recs]]).resolve, [seed(s)], new Set(), { count: 1, ...opts });
    assert.ok(picks.every(p => p.track.info.author !== 'Frank Klepacki'), `${titles(picks).join(' / ')} (free: ${free.join(' / ')})`);
  }
});

test('a source that throws does not break the others', async () => {
  const c = yuriCase();
  const { resolve } = fakeResolver([
    ['ytrec:', () => { throw new Error('NodeLink down'); }],
    [mixOf('RA2yuri0001'), () => playlist([track('Hell March 3', 'Frank Klepacki'), c.sovietMarch])]
  ]);
  const picks = await pickSimilar(resolve, [seed(c.seedTrack)], new Set(), { count: 3 });
  assert.ok(titles(picks).includes('Hell March 3'), titles(picks).join(' / '));
});

test('a source that hangs times out and the others still count', async () => {
  const c = yuriCase();
  const { resolve } = fakeResolver([
    ['ytrec:', () => new Promise<undefined>(() => {})],
    [mixOf('RA2yuri0001'), () => playlist([track('Hell March 3', 'Frank Klepacki')])]
  ]);
  const started = Date.now();
  const picks = await pickSimilar(resolve, [seed(c.seedTrack)], new Set(), { count: 3 });
  assert.ok(Date.now() - started < 8000, 'returned within the time budget');
  assert.deepEqual(titles(picks), ['Hell March 3']);
});

test('everything failing gives [] instead of throwing; no seeds gives []', async () => {
  const c = yuriCase();
  const { resolve } = fakeResolver([['', () => { throw new Error('down'); }]]);
  assert.deepEqual(await pickSimilar(resolve, [seed(c.seedTrack)], new Set()), []);
  assert.deepEqual(await pickSimilar(resolve, [], new Set()), []);
});

test('Spotify mapping: a wrong search hit is not used as the seed', async () => {
  const s = track("Red Alert 2 Yuri's Revenge Soundtrack - Brain Freeze", 'Frank Klepacki', { id: 'RA2yuri0001' });
  const { resolve, asked } = fakeResolver([
    ['spsearch:', () => search([track('Soviet March', 'James Hannigan', { source: 'spotify', id: 'spWrong' })])],
    ['sprec:', () => search([track('Farewell of Slavianka', 'Red Army Choir', { source: 'spotify' })])],
    ['ytrec:', () => search([track('Hell March 3', 'Frank Klepacki')])]
  ]);
  await pickSimilar(resolve, [seed(s)], new Set(), { count: 3 });
  assert.ok(asked.some(id => id.startsWith('spsearch:')), 'it tried to map the seed');
  assert.ok(!asked.some(id => id.includes('spWrong')), asked.join(' '));
});

test('Spotify mapping: a hit that really is the seed song borrows its Spotify recs', async () => {
  const s = track('Hell March', 'Frank Klepacki', { id: 'HellMarch01' });
  const { resolve, asked } = fakeResolver([
    ['spsearch:', () => search([track('Hell March', 'Frank Klepacki', { source: 'spotify', id: 'spHellMarch' })])],
    ['sprec:', () => search([track('Act On Instinct', 'Frank Klepacki', { source: 'spotify' })])]
  ]);
  const picks = await pickSimilar(resolve, [seed(s)], new Set(), { count: 3 });
  assert.ok(asked.includes('sprec:seed_tracks=spHellMarch'), asked.join(' '));
  assert.ok(titles(picks).includes('Act On Instinct'), titles(picks).join(' / '));
});

test('a Spotify seed asks Spotify recommendations with its own id', async () => {
  const s = track('Brain Freeze', 'Frank Klepacki', { source: 'spotify', id: 'spSeed' });
  const { resolve, asked } = fakeResolver([
    ['sprec:', () => search([track('Act On Instinct', 'Frank Klepacki', { source: 'spotify' }), track('Grinder', 'Frank Klepacki', { source: 'spotify' })])]
  ]);
  const picks = await pickSimilar(resolve, [seed(s)], new Set(), { count: 2 });
  assert.ok(asked.includes('sprec:seed_tracks=spSeed'), asked.join(' '));
  assert.ok(!asked.some(id => id.startsWith('spsearch:')), 'no search needed for a Spotify seed');
  assert.ok(picks.length >= 1);
});
