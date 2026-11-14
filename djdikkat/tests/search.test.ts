// Search engine checks — `npm test`. Candidate lists are real YouTube Music
// results (2026-10-01) for queries the old scorer got wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Track } from 'shoukaku';
import type { LavalinkResponse } from 'shoukaku';
import { cleanQuery, fold, matchScore, normalizeLink, playlistLink, rankCandidates, search, suggest } from '../src/music/search.ts';

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

test('a one-letter typo still finds the song, over a title that copies the typo', () => {
  const tracks = [track('Bohemain Rapsody- Queen (Cover)', 'Mejis', 311), track('Bohemian Rhapsody', 'Queen', 355)];
  const [best] = rankCandidates('bohemain rapsody', tracks.map((t, rank) => ({ track: t, rank, source: 'ytm' as const })));
  assert.equal(best!.track.info.author, 'Queen');
  assert.ok(best!.coverage >= 0.7, `coverage ${best!.coverage}`);
  // short words are never fuzzy: "end" must not match "and"
  assert.equal(pick('in the end', [track('In and Out', 'Someone', 200), track('In the End', 'Linkin Park', 217)]), 'In the End | Linkin Park');
});

test('a query that is an artist name prefers that artist', () => {
  assert.equal(pick('duman', [
    track('Kafa Duman', 'Hünkar Göksu', 147),
    track('Senden Daha Güzel', 'Duman', 270)
  ]), 'Senden Daha Güzel | Duman');
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
    ['spotify:track:0pqnGHJpmpxLKifKRmU6WP', 'https://open.spotify.com/track/0pqnGHJpmpxLKifKRmU6WP'],
    ['spotify:artist:53XhwfbYqKCa1cC15pYq2q', 'https://open.spotify.com/artist/53XhwfbYqKCa1cC15pYq2q'],
    // Discord's no-preview <link>
    ['<https://youtu.be/NAHRpEqgcL4?si=x>', 'https://youtu.be/NAHRpEqgcL4'],
    // NodeLink only matches watch?v= as the first parameter, and no embeds
    ['https://www.youtube.com/watch?app=desktop&v=NAHRpEqgcL4&t=42s', 'https://www.youtube.com/watch?v=NAHRpEqgcL4'],
    ['https://www.youtube.com/embed/NAHRpEqgcL4?autoplay=1', 'https://www.youtube.com/watch?v=NAHRpEqgcL4'],
    ['https://www.youtube-nocookie.com/embed/NAHRpEqgcL4', 'https://www.youtube.com/watch?v=NAHRpEqgcL4'],
    ['https://music.youtube.com/watch?v=NAHRpEqgcL4&list=RDAMVMNAHRpEqgcL4&si=q', 'https://music.youtube.com/watch?v=NAHRpEqgcL4'],
    ['https://youtube.com/shorts/NAHRpEqgcL4?si=abc&feature=share', 'https://www.youtube.com/shorts/NAHRpEqgcL4'],
    ['https://m.youtube.com/watch?list=PLirAqAtl_h2r5g8xGajEwdXd3x1sZh8hC', 'https://www.youtube.com/playlist?list=PLirAqAtl_h2r5g8xGajEwdXd3x1sZh8hC'],
    ['https://www.youtube.com/playlist?feature=shared&app=desktop&list=PLirAqAtl_h2r5g8xGajEwdXd3x1sZh8hC', 'https://www.youtube.com/playlist?list=PLirAqAtl_h2r5g8xGajEwdXd3x1sZh8hC'],
    ['https://open.spotify.com/intl-tr/track/0pqnGHJpmpxLKifKRmU6WP?si=1', 'https://open.spotify.com/intl-tr/track/0pqnGHJpmpxLKifKRmU6WP'],
    // NodeLink's SoundCloud pattern fails on a trailing slash
    ['https://m.soundcloud.com/duman/bu-aksam/?utm_source=clipboard#t=0:30', 'https://m.soundcloud.com/duman/bu-aksam'],
    // never a raw NodeLink identifier
    ['local:/etc/passwd', null],
    ['ytsearch:despacito', null],
    ['sprec:seed_tracks=1', null],
    ['tarkan kuzu kuzu', null],
    ['ac/dc', null],
    ['despacito', null]
  ];
  for (const [input, expected] of cases) assert.equal(normalizeLink(input), expected, input);
});

test('playlistLink keeps the list (import), no network for these', async () => {
  const pl = 'PLnAyjjSacQnnnd29Tl5wTZ6cFGBhLnEpy';
  const cases: [string, object][] = [
    [`https://www.youtube.com/watch?v=pq9yGUpa6bY&list=${pl}`, { url: `https://www.youtube.com/playlist?list=${pl}`, mix: false }],
    [`https://music.youtube.com/watch?v=pq9yGUpa6bY&list=${pl}&si=x`, { url: `https://music.youtube.com/playlist?list=${pl}`, mix: false }],
    [`youtu.be/pq9yGUpa6bY?list=${pl}`, { url: `https://www.youtube.com/playlist?list=${pl}`, mix: false }],
    [`https://m.youtube.com/playlist?list=${pl}`, { url: `https://www.youtube.com/playlist?list=${pl}`, mix: false }],
    ['https://www.youtube.com/watch?v=NAHRpEqgcL4&list=RDNAHRpEqgcL4&start_radio=1', { url: 'https://www.youtube.com/playlist?list=RDNAHRpEqgcL4', mix: true }],
    ['https://www.youtube.com/playlist?list=LL', { error: 'import_private' }],
    ['https://music.youtube.com/playlist?list=LM', { error: 'import_private' }],
    ['spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', { url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', mix: false }],
    ['https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy?si=1', { url: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy', mix: false }],
    ['https://soundcloud.com/user/sets/name', { url: 'https://soundcloud.com/user/sets/name', mix: false }],
    ['lofi beats', { error: 'import_failed' }]
  ];
  for (const [input, expected] of cases) assert.deepEqual(await playlistLink(input), expected, input);
});

test('normalizeLink only ever returns http(s) links', () => {
  for (const input of ['local:/etc/passwd', 'file:///etc/passwd', 'ftts://hello', 'javascript:alert(1)', 'ytrec:abc', 'spotify:local:x']) {
    const out = normalizeLink(input);
    assert.ok(out === null || /^https?:\/\//.test(out), `${input} → ${out}`);
  }
});

test('playlistLink unwraps <link> and keeps private lists private', async () => {
  const pl = 'PLnAyjjSacQnnnd29Tl5wTZ6cFGBhLnEpy';
  assert.deepEqual(await playlistLink(`<https://www.youtube.com/watch?v=x&list=${pl}>`), { url: `https://www.youtube.com/playlist?list=${pl}`, mix: false });
  assert.deepEqual(await playlistLink('https://www.youtube.com/watch?v=x&list=WL'), { error: 'import_private' });
});

test('cleanQuery: one line, no typed source prefix, no leading slash, capped', () => {
  assert.equal(cleanQuery('  tarkan\n\tkuzu   kuzu \u200b '), 'tarkan kuzu kuzu');
  assert.equal(cleanQuery('ytsearch:despacito'), 'despacito');
  assert.equal(cleanQuery('ytmsearch: scsearch:  despacito'), 'despacito');
  assert.equal(cleanQuery('local:/etc/passwd'), 'etc/passwd');
  assert.equal(cleanQuery('sprec:seed_tracks=1'), 'seed_tracks=1');
  assert.equal(cleanQuery('/play duman bu akşam'), 'duman bu akşam');
  assert.equal(cleanQuery('Mission: Impossible theme'), 'Mission: Impossible theme');
  assert.equal(cleanQuery('AC/DC Thunderstruck'), 'AC/DC Thunderstruck');
  const long = cleanQuery(`${'word '.repeat(100)}🎵`);
  assert.ok([...long].length <= 200 && !long.endsWith(' '), `${long.length}`);
  assert.equal([...cleanQuery('🎵'.repeat(300))].length, 200); // no half emoji
});

/** A fake NodeLink: answers per prefix, records what it was asked. */
function fakeNode(answers: Record<string, Track[] | 'throw' | 'hang'>) {
  const asked: string[] = [];
  const resolve = async (id: string): Promise<LavalinkResponse | undefined> => {
    asked.push(id);
    const answer = answers[id.slice(0, id.indexOf(':'))];
    if (answer === 'throw') throw new Error('source down');
    if (answer === 'hang') return new Promise(() => {});
    return { loadType: 'search', data: answer ?? [] } as unknown as LavalinkResponse;
  };
  return { asked, resolve };
}

test('search sends only fixed prefixes, with the cleaned query', async () => {
  const node = fakeNode({ ytmsearch: [track('Despacito', 'Luis Fonsi', 229)] });
  const res = await search(node.resolve, 'ytsearch:despacito', 10, 'test');
  assert.equal(res.tracks[0]!.info.title, 'Despacito');
  assert.deepEqual(node.asked, ['ytmsearch:despacito']);
  const empty = fakeNode({});
  assert.deepEqual((await search(empty.resolve, '🎵🎶', 10, 'test')).tracks, []);
  assert.deepEqual(empty.asked, []); // nothing to look for: no request at all
});

test('one source down does not fail the search', async () => {
  const node = fakeNode({ ytmsearch: 'throw', ytsearch: [track('Bu Akşam', 'Duman', 176)] });
  const res = await search(node.resolve, 'duman bu akşam', 10, 'test');
  assert.equal(res.tracks[0]!.info.title, 'Bu Akşam');
});

test('a hanging source times out instead of holding /play', { timeout: 15_000 }, async () => {
  const node = fakeNode({ ytmsearch: 'hang', ytsearch: [track('Bu Akşam', 'Duman', 176)] });
  const started = Date.now();
  const res = await search(node.resolve, 'duman bu akşam', 10, 'test');
  assert.equal(res.tracks[0]!.info.title, 'Bu Akşam');
  assert.ok(Date.now() - started < 10_000);
});

test('suggest cleans the query and caches by it', async () => {
  const node = fakeNode({ ytmsearch: [track('Dönence', 'Barış Manço', 405)] });
  await suggest(node.resolve, '  barış   manço dönence ');
  await suggest(node.resolve, 'Baris Manco Donence');
  assert.deepEqual(node.asked, ['ytmsearch:barış manço dönence']);
  assert.deepEqual(await suggest(node.resolve, '🎵🎵🎵'), []);
});

test('unrequested sped up / bass boosted / Turkish variants lose', () => {
  assert.equal(pick('şımarık', [
    track('Şımarık (Hızlandırılmış)', 'Speed Songs TR', 150),
    track('Şımarık', 'Tarkan', 236)
  ]), 'Şımarık | Tarkan');
  assert.equal(pick('believer imagine dragons', [
    track('Imagine Dragons - Believer (Bass Boosted)', 'Bass Nation', 204),
    track('Believer', 'Imagine Dragons', 204)
  ]), 'Believer | Imagine Dragons');
  assert.equal(pick('believer sped up', [
    track('Believer', 'Imagine Dragons', 204),
    track('Believer (Sped Up)', 'Imagine Dragons', 170)
  ]), 'Believer (Sped Up) | Imagine Dragons');
});

// ── matchScore ──

test('matchScore: the same song scores high through upload noise', () => {
  const spec = { title: 'Kuzu Kuzu', artist: 'Tarkan', durationMs: 234_000 };
  for (const t of [
    track('Kuzu Kuzu', 'Tarkan', 234),
    track('Tarkan - Kuzu Kuzu (Official Video) [HD]', 'TarkanVEVO', 235),
    track('Kuzu Kuzu', 'Tarkan - Topic', 233),
    track('TARKAN | Kuzu Kuzu (Official Audio)', 'Tarkan Official', 236)
  ]) assert.ok(matchScore(spec, t) >= 0.9, `${t.info.title} by ${t.info.author}: ${matchScore(spec, t)}`);
  // a YouTube seed as the spec: its own title and channel are noisy too
  assert.ok(matchScore({ title: 'Tarkan - Kuzu Kuzu (Official Video)', artist: 'TarkanVEVO' }, track('Kuzu Kuzu', 'Tarkan', 234)) >= 0.9);
});

test('matchScore: same title by someone else is clearly lower', () => {
  const spec = { title: 'Kuzu Kuzu', artist: 'Tarkan' };
  const other = matchScore(spec, track('Kuzu Kuzu', 'Cem Yılmaz', 238));
  assert.ok(other < 0.5, `${other}`);
  assert.ok(matchScore({ title: 'Believer', artist: 'Imagine Dragons' }, track('Believer', 'Kane Brown', 190)) < 0.5);
  // a soundtrack spec: game title, then the song
  const ost = { title: "Red Alert 2 Yuri's Revenge Soundtrack - Brain Freeze", artist: 'Frank Klepacki' };
  assert.ok(matchScore(ost, track('Brain Freeze', 'Frank Klepacki', 260)) >= 0.7, `${matchScore(ost, track('Brain Freeze', 'Frank Klepacki', 260))}`);
  assert.ok(matchScore(ost, track('Brain Freeze', 'Some Band', 200)) < 0.5);
  assert.ok(matchScore({ title: 'Brain Freeze', artist: 'Frank Klepacki' }, track("Red Alert 2 Yuri's Revenge Soundtrack - Brain Freeze", 'Frank Klepacki', 260)) >= 0.7);
  assert.ok(matchScore(ost, track('Hell March', 'Frank Klepacki', 200)) < 0.3);
  // and another song by the right artist is lower still
  assert.ok(matchScore(spec, track('Dudu', 'Tarkan', 278)) < 0.3);
});

test('matchScore: Turkish letters, typos and credits', () => {
  const cases: [{ title: string; artist?: string }, Track][] = [
    [{ title: 'Dönence', artist: 'Barış Manço' }, track('Donence', 'Baris Manco', 405)],
    [{ title: 'Senorita (feat. Camila Cabello)', artist: 'Shawn Mendes, Camila Cabello' },
      track('Shawn Mendes, Camila Cabello - Señorita (Official Music Video)', 'ShawnMendesVEVO', 205)],
    [{ title: 'Bohemian Rhapsody - Remastered 2011', artist: 'Queen' }, track('Bohemian Rhapsody (Official Video Remastered)', 'Queen Official', 359)],
    [{ title: 'With or Without You', artist: 'U2' }, track('U2 - With Or Without You (Official Music Video)', 'U2VEVO', 296)],
    [{ title: 'Let It Go - From "Frozen"', artist: 'Idina Menzel' }, track('Let It Go', 'Idina Menzel - Topic', 224)]
  ];
  for (const [spec, t] of cases) assert.ok(matchScore(spec, t) >= 0.9, `${spec.title}: ${matchScore(spec, t)}`);
  const typo = matchScore({ title: 'Bohemian Rhapsody', artist: 'Queen' }, track('Bohemain Rhapsody', 'Queen', 355));
  assert.ok(typo >= 0.8 && typo < 1, `${typo}`);
});

test('matchScore: versions and lengths', () => {
  const spec = { title: 'Believer', artist: 'Imagine Dragons', durationMs: 204_000 };
  const original = matchScore(spec, track('Believer', 'Imagine Dragons', 204));
  assert.equal(original, 1);
  for (const t of [
    track('Believer (Nightcore)', 'Imagine Dragons', 204),
    track('Imagine Dragons - Believer (Live)', 'Imagine Dragons', 204),
    track('Believer (Cover)', 'Imagine Dragons', 204),
    track('Believer', 'Nightcore Hits', 204),
    track('Believer', 'Imagine Dragons', 260),
    track('Believer 1 Hour', 'Imagine Dragons', 3600),
    track('Believer', 'Imagine Dragons', 0, true)
  ]) assert.ok(matchScore(spec, t) < 0.8, `${t.info.title} by ${t.info.author}: ${matchScore(spec, t)}`);
  // a live version matches a live spec
  assert.ok(matchScore({ title: 'Bu Akşam (Live)', artist: 'Duman' }, track('Duman - Bu Akşam (Live At Rock’n Coke)', 'Duman', 187)) >= 0.9);
  // no artist: the spec may be "artist song"
  assert.ok(matchScore({ title: 'duman bu aksam' }, track('Bu Akşam', 'Duman', 176)) >= 0.9);
});

test('cleanQuery keeps real words that look like a prefix', () => {
  for (const q of ['Research: Stacks', 'Speak: Now', 'Re: Stacks', 'Mission: Impossible theme', '24K Magic', '7 rings', '2pac', 'Barış Manço - Dönence', 'Search & Destroy'])
    assert.equal(cleanQuery(q), q);
  assert.equal(cleanQuery('scsearch:despacito'), 'despacito');
  assert.equal(cleanQuery('dzisrc:USUM71703861'), 'USUM71703861');
});

test('normalizeLink: embed playlists and live embeds are not video ids', () => {
  assert.equal(normalizeLink('https://www.youtube.com/embed/videoseries?list=PLirAqAtl_h2r5g8xGajEwdXd3x1sZh8hC'),
    'https://www.youtube.com/playlist?list=PLirAqAtl_h2r5g8xGajEwdXd3x1sZh8hC');
  assert.notEqual(normalizeLink('https://www.youtube.com/embed/live_stream?channel=UCabc'), 'https://www.youtube.com/watch?v=live_stream');
});

test('songs named with "speed" or "hour" are not treated as versions', () => {
  assert.equal(pick('jvke', [track('golden hour', 'JVKE', 209), track('this is what falling in love feels like', 'JVKE', 120)]), 'golden hour | JVKE');
  assert.equal(pick('coldplay', [track('Speed of Sound', 'Coldplay', 288), track('Yellow', 'Coldplay', 266)]), 'Speed of Sound | Coldplay');
  // …but a "1 hour" upload still is, even when the song itself has "hour" in it
  assert.equal(pick('golden hour', [track('golden hour (1 hour loop)', 'loops', 3600), track('golden hour', 'JVKE', 209)]), 'golden hour | JVKE');
  assert.equal(pick('believer', [track('Believer (Speed Up)', 'x', 170), track('Believer', 'Imagine Dragons', 204)]), 'Believer | Imagine Dragons');
  const spec = { title: 'golden hour', artist: 'JVKE', durationMs: 209_000 };
  assert.ok(matchScore(spec, track('JVKE - golden hour (Official Video)', 'JVKE', 210)) >= 0.9);
  assert.ok(matchScore(spec, track('golden hour 10 hours', 'JVKE', 209)) < 0.8);
  assert.ok(matchScore({ title: 'Speed of Sound', artist: 'Coldplay' }, track('Coldplay - Speed Of Sound (Official Video)', 'Coldplay', 290)) >= 0.9);
});
