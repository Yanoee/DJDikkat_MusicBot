// Radio trivia checks — `npm test`. No network: a fake fetch plays Wikipedia and Spotify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  albumYear, artistFacts, createTrivia, mergeFacts, parseTrack, rotate, songFacts, spotifyFacts, workFact
} from '../src/music/trivia.ts';
import type { Fact, TriviaTrack, WikiPage } from '../src/music/trivia.ts';
import { createSpotifyClient } from '../src/music/spotify.ts';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const track = (title: string, author: string, extra: Partial<TriviaTrack['info']> = {}): TriviaTrack => ({
  info: { identifier: `${author}|${title}`, isSeekable: true, author, length: 203_000, isStream: false, position: 0, title, sourceName: 'youtube', ...extra }
} as TriviaTrack);

interface ApiPage { title: string; description?: string; extract?: string; disambiguation?: boolean; missing?: boolean }
const pagesBody = (pages: ApiPage[]) => json({
  query: { pages: pages.map(p => ({ title: p.title, description: p.description, extract: p.extract, missing: p.missing, pageprops: p.disambiguation ? { disambiguation: '' } : undefined })) }
});

/** A fake Wikipedia: `search` answers generator=search by query, `titles` answers title lookups. */
function wiki(opts: { search?: Record<string, ApiPage[]>; titles?: ApiPage[] }) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.href);
    if (url.hostname.endsWith('wikipedia.org')) {
      const q = url.searchParams.get('gsrsearch');
      if (q !== null) return pagesBody(opts.search?.[q] ?? []);
      const wanted = (url.searchParams.get('titles') ?? '').split('|');
      return pagesBody(wanted.map(t => opts.titles?.find(p => p.title === t) ?? { title: t, missing: true }));
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const LEVITATING: ApiPage = {
  title: 'Levitating (song)', description: '2020 single by Dua Lipa',
  extract: '"Levitating" is a song by English singer Dua Lipa from her second studio album, Future Nostalgia (2020). The song was written by Lipa, Clarence Coffee Jr., Sarah Hudson, and Koz.'
};
const DUA: ApiPage = {
  title: 'Dua Lipa', description: 'English singer and songwriter (born 1995)',
  extract: 'Dua Lipa (born 22 August 1995) is an English singer and songwriter.'
};
const enPage = (p: ApiPage): WikiPage => ({ ...p, lang: 'en' });
const trPage = (p: ApiPage): WikiPage => ({ ...p, lang: 'tr' });

// ── Pure parts ────────────────────────────────────────────────

test('reads song, artist and game/film from upload titles', () => {
  const a = parseTrack('Hell March (Red Alert 2 OST)', 'Frank Klepacki - Topic');
  assert.deepEqual(a.work, { name: 'Red Alert 2', sure: true });
  assert.equal(a.songs[0], 'Hell March');
  assert.deepEqual(a.artists, ['Frank Klepacki']);

  const b = parseTrack('Command & Conquer: Red Alert 2 - Hell March', 'C&C Music Archive');
  assert.deepEqual(b.work, { name: 'Command & Conquer: Red Alert 2', sure: false });
  assert.equal(b.songs[0], 'Hell March');

  const c = parseTrack('Red Alert 2 Soundtrack - Hell March', 'Some Channel');
  assert.deepEqual(c.work, { name: 'Red Alert 2', sure: true });
  assert.equal(c.songs[0], 'Hell March');

  const d = parseTrack('Let It Go (From "Frozen")', 'Idina Menzel');
  assert.deepEqual(d.work, { name: 'Frozen', sure: true });
  assert.equal(d.songs[0], 'Let It Go');

  const e = parseTrack('Tarkan - Kuzu Kuzu (Official Video)', 'TarkanVEVO');
  assert.equal(e.work, null);
  assert.equal(e.songs[0], 'Kuzu Kuzu');
  assert.deepEqual(e.artists, ['Tarkan']);
});

test('song page: right title + artist gives year and album', () => {
  const hit = songFacts(enPage(LEVITATING), ['Levitating'], ['Dua Lipa']);
  assert.ok(hit);
  assert.equal(hit.album, 'Future Nostalgia');
  assert.deepEqual(hit.facts.find(f => f.kind === 'released')?.data, { title: 'Levitating', artist: 'Dua Lipa', year: '2020' });
  assert.deepEqual(hit.facts.find(f => f.kind === 'album')?.data, { title: 'Levitating', artist: 'Dua Lipa', album: 'Future Nostalgia', year: '2020' });
  // The "written by A, B, C and D" list is not a single composer.
  assert.equal(hit.facts.some(f => f.kind === 'composer'), false);
});

test('song page: wrong artist, other title, disambiguation, non-song qualifier are rejected', () => {
  assert.equal(songFacts(enPage(LEVITATING), ['Levitating'], ['Kygo']), null);
  assert.equal(songFacts(enPage(LEVITATING), ['Levitate'], ['Dua Lipa']), null);
  assert.equal(songFacts(enPage({ ...LEVITATING, disambiguation: true }), ['Levitating'], ['Dua Lipa']), null);
  assert.equal(songFacts(enPage({ ...LEVITATING, title: 'Levitating (film)' }), ['Levitating'], ['Dua Lipa']), null);
  // Mentions the artist, but the description says it's someone else's song (a same-named cover/original).
  const other = { ...LEVITATING, description: '2019 single by Someone Else' };
  assert.equal(songFacts(enPage(other), ['Levitating'], ['Dua Lipa']), null);
});

test('Turkish song page: album, composer from "Sözleri ve müziği X\'e ait"', () => {
  const page = trPage({
    title: 'Kuzu Kuzu',
    extract: '"Kuzu Kuzu", Tarkan\'ın dördüncü stüdyo albümü Karma\'dan bir şarkı. Albümden yayınlanan ilk parçadır. Sözleri ve müziği Tarkan\'a ait olan parçanın düzenlemesini Ozan Çolakoğlu yaptı.'
  });
  const hit = songFacts(page, ['Kuzu Kuzu'], ['Tarkan']);
  assert.ok(hit);
  assert.equal(hit.album, 'Karma');
  assert.deepEqual(hit.facts.find(f => f.kind === 'composer')?.data, { title: 'Kuzu Kuzu', composer: 'Tarkan', artist: 'Tarkan' });
  const album = trPage({ title: 'Karma (albüm)', extract: 'Karma, Türk şarkıcı Tarkan\'ın 1 Ağustos 2001 tarihinde yayınlanan dördüncü albümüdür.' });
  assert.equal(albumYear(album, 'Karma', ['Tarkan']), '2001');
  assert.equal(albumYear(album, 'Karma', ['Sezen Aksu']), null);
});

test('game page: exact game only, with the year and medium', () => {
  const ra2 = enPage({ title: 'Command & Conquer: Red Alert 2', description: '2000 video game' });
  const ra1 = enPage({ title: 'Command & Conquer: Red Alert', description: '1996 video game' });
  assert.deepEqual(workFact(ra2, 'Red Alert 2', 'Hell March')?.data, { title: 'Hell March', work: 'Command & Conquer: Red Alert 2', medium: 'game', year: '2000' });
  assert.equal(workFact(ra1, 'Red Alert 2', 'Hell March'), null);
  // "Madonna - Frozen" on a fan channel: "Madonna" is a maybe-work, a qualified film page doesn't count.
  const film = enPage({ title: 'Madonna (1980 film)', description: '1980 film' });
  assert.equal(workFact(film, 'Madonna', 'Frozen', false), null);
  assert.equal(workFact(film, 'Madonna', 'Frozen', true)?.data.medium, 'film');
  // Same name but not a game/film (a person, a franchise without a year): no fact.
  assert.equal(workFact(enPage({ title: 'Tarkan', description: 'Turkish singer' }), 'Tarkan', 'Dudu'), null);
  assert.equal(workFact(enPage({ title: 'Command & Conquer', description: 'Real-time strategy video game franchise' }), 'Command & Conquer', 'X'), null);
});

test('artist page: nationality in the locale, role, birth year', () => {
  assert.deepEqual(artistFacts(enPage(DUA), 'Dua Lipa', 'en'), [
    { kind: 'origin', data: { artist: 'Dua Lipa', nationality: 'English', role: 'singer' } },
    { kind: 'born', data: { artist: 'Dua Lipa', year: '1995' } }
  ]);
  assert.deepEqual(artistFacts(enPage(DUA), 'Dua Lipa', 'tr')[0]?.data.nationality, 'İngiliz');
  const tarkan = trPage({ title: 'Tarkan', description: 'Türk şarkıcı ve söz yazarı', extract: 'Tarkan Tevetoğlu ya da sahne adıyla Tarkan (d. 17 Ekim 1972), Türk şarkıcı-şarkı yazarıdır.' });
  assert.deepEqual(artistFacts(tarkan, 'Tarkan', 'tr'), [
    { kind: 'origin', data: { artist: 'Tarkan', nationality: 'Türk', role: 'singer' } },
    { kind: 'born', data: { artist: 'Tarkan', year: '1972' } }
  ]);
  const queen = enPage({ title: 'Queen (band)', description: 'British rock band', extract: 'Queen are a British rock band formed in London in 1970.' });
  assert.deepEqual(artistFacts(queen, 'Queen', 'en'), [{ kind: 'origin', data: { artist: 'Queen', nationality: 'British', role: 'band' } }]);
  // Wrong page for the name, or a demonym we can't say in Turkish: nothing.
  assert.deepEqual(artistFacts(enPage({ title: 'Queen (chess)', description: 'Chess piece' }), 'Queen', 'en'), []);
  assert.deepEqual(artistFacts(enPage({ title: 'X', description: 'Martian singer' }), 'X', 'tr'), []);
});

test('Spotify facts: album/single/year rules, compilations and placeholder dates dropped', () => {
  const base = { id: 'abc', name: 'Levitating', duration_ms: 203_000, artists: [{ id: 'art', name: 'Dua Lipa' }] };
  assert.deepEqual(spotifyFacts({ ...base, album: { name: 'Future Nostalgia', album_type: 'album', release_date: '2020-03-27' } }, ['dance pop']), [
    { kind: 'album', data: { title: 'Levitating', artist: 'Dua Lipa', album: 'Future Nostalgia', year: '2020' } },
    { kind: 'genre', data: { artist: 'Dua Lipa', genre: 'dance pop' } }
  ]);
  assert.deepEqual(spotifyFacts({ ...base, album: { name: 'Levitating', album_type: 'single', release_date: '2020-10-01' } }, []), [
    { kind: 'released', data: { title: 'Levitating', artist: 'Dua Lipa', year: '2020' } }
  ]);
  assert.deepEqual(spotifyFacts({ ...base, album: { name: 'Greatest Hits', album_type: 'compilation', release_date: '2023-05-05' } }, []), []);
  // Catalogue placeholder date: album kept, year not.
  assert.deepEqual(spotifyFacts({ ...base, album: { name: 'Karma', album_type: 'album', release_date: '2017-01-01' } }, [])[0]?.data,
    { title: 'Levitating', artist: 'Dua Lipa', album: 'Karma' });
});

test('merge: Wikipedia wins, rotation walks the kinds and avoids repeating', () => {
  const wikiFacts: Fact[] = [{ kind: 'released', data: { title: 'S', artist: 'A', year: '2001' } }];
  const spot: Fact[] = [
    { kind: 'released', data: { title: 'S', artist: 'A', year: '2017' } },
    { kind: 'album', data: { title: 'S', artist: 'A', album: 'Karma', year: '1990' } }
  ];
  const merged = mergeFacts(wikiFacts, spot);
  assert.equal(merged.find(f => f.kind === 'released')?.data.year, '2001');
  assert.equal(merged.find(f => f.kind === 'album')?.data.year, undefined); // 1990 album vs 2001 single: can't both be right
  const list = merged;
  const first = rotate(list, 0, null);
  const second = rotate(list, first.next, first.fact!.kind);
  assert.notEqual(first.fact!.kind, second.fact!.kind);
  assert.equal(rotate([], 0, null).fact, null);
});

// ── getFact end to end (fake network) ────────────────────────

test('getFact: matched song gives facts, rotates kinds, caches per track', async () => {
  const { fetchFn, calls } = wiki({ search: { 'Levitating Dua Lipa': [LEVITATING] }, titles: [DUA] });
  const trivia = createTrivia({ fetch: fetchFn, spotify: null });
  const t = track('Dua Lipa - Levitating (Official Music Video)', 'Dua Lipa');
  const kinds = new Set<string>();
  for (let i = 0; i < 4; i++) kinds.add((await trivia.getFact(t, 'en'))!.kind);
  assert.deepEqual([...kinds].sort(), ['album', 'born', 'origin', 'released']);
  const fetched = calls.length;
  await trivia.getFact(t, 'en');
  assert.equal(calls.length, fetched, 'second play is served from the cache');
  assert.ok(calls.every(u => u.startsWith('https://en.wikipedia.org/w/api.php?')));
});

test('getFact: Turkish server asks tr.wikipedia first', async () => {
  const { fetchFn, calls } = wiki({});
  const trivia = createTrivia({ fetch: fetchFn, spotify: null });
  assert.equal(await trivia.getFact(track('Bilinmeyen Şarkı', 'Bilinmeyen Biri'), 'tr'), null);
  assert.ok(calls[0]!.startsWith('https://tr.wikipedia.org/'));
  assert.ok(calls.some(u => u.startsWith('https://en.wikipedia.org/')));
});

test('getFact: disambiguation page rejected', async () => {
  const disamb: ApiPage = { title: 'Dudu', description: 'Topics referred to by the same term', extract: 'Dudu may refer to: Dudu (song), a 2003 song by Tarkan', disambiguation: true };
  const { fetchFn } = wiki({ search: { 'Dudu Tarkan': [disamb] }, titles: [{ ...disamb, title: 'Tarkan' }] });
  const trivia = createTrivia({ fetch: fetchFn, spotify: null });
  assert.equal(await trivia.getFact(track('Dudu', 'Tarkan'), 'en'), null);
});

test('getFact: same title by another artist gets no song facts', async () => {
  const { fetchFn } = wiki({ search: { 'Levitating Kygo': [LEVITATING, DUA] } });
  const trivia = createTrivia({ fetch: fetchFn, spotify: null });
  assert.equal(await trivia.getFact(track('Levitating', 'Kygo'), 'en'), null);
});

test('getFact: soundtrack of the exact game', async () => {
  const { fetchFn } = wiki({
    search: {
      'Red Alert 2': [
        { title: 'Command & Conquer: Red Alert', description: '1996 video game' },
        { title: 'Command & Conquer: Red Alert 2', description: '2000 video game' }
      ]
    }
  });
  const trivia = createTrivia({ fetch: fetchFn, spotify: null });
  const fact = await trivia.getFact(track('Hell March (Red Alert 2 OST)', 'GameMusicChannel'), 'en');
  assert.deepEqual(fact, { kind: 'soundtrack', data: { title: 'Hell March', work: 'Command & Conquer: Red Alert 2', medium: 'game', year: '2000' } });
});

test('getFact: timeout → null within the budget, never throws', async () => {
  const hang = ((_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  })) as typeof fetch;
  const trivia = createTrivia({ fetch: hang, spotify: () => new Promise(() => {}), requestTimeout: 60, totalTimeout: 150 });
  const started = Date.now();
  assert.equal(await trivia.getFact(track('Levitating', 'Dua Lipa'), 'tr'), null);
  assert.ok(Date.now() - started < 1_000);

  const boom = (() => { throw new Error('boom'); }) as unknown as typeof fetch;
  assert.equal(await createTrivia({ fetch: boom, spotify: null }).getFact(track('Levitating', 'Dua Lipa'), 'en'), null);
  assert.equal(await createTrivia({ fetch: boom, spotify: null }).getFact({ info: undefined } as unknown as TriviaTrack, 'en'), null);
  assert.equal(await createTrivia({ fetch: boom, spotify: null }).getFact(track('Radio', 'Live', { isStream: true }), 'en'), null);
});

test('getFact: Wikipedia 429 → cooldown, no hammering', async () => {
  let hits = 0;
  const limited = (async () => { hits += 1; return new Response('slow down', { status: 429, headers: { 'retry-after': '5' } }); }) as typeof fetch;
  const trivia = createTrivia({ fetch: limited, spotify: null });
  await trivia.getFact(track('A Song', 'An Artist'), 'en');
  const after = hits;
  await trivia.getFact(track('Other Song', 'Other Artist'), 'en');
  assert.equal(hits, after, 'cooling down: no new Wikipedia requests');
});

// ── Spotify through the real client (fake fetch) ─────────────

function spotifyFake(items: unknown[], artist: unknown = { genres: ['dance pop'] }) {
  const calls: string[] = [];
  const client = createSpotifyClient({
    fetch: async input => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/api/token')) return json({ access_token: 'tok', expires_in: 3600 });
      if (url.includes('/v1/search')) return json({ tracks: { items } });
      if (url.includes('/v1/artists/')) return json(artist);
      return json({}, 404);
    },
    sleep: async () => {},
    credentials: () => ({ clientId: 'id', clientSecret: 'secret' })
  });
  return { get: client.get, calls };
}
const noWiki = wiki({}).fetchFn;

test('Spotify: matching hit gives album + genre', async () => {
  const sp = spotifyFake([
    { id: 'other1234567', name: 'Levitating', duration_ms: 180_000, artists: [{ id: 'kygo1234567', name: 'Kygo' }], album: { name: 'Kygo Album', album_type: 'album', release_date: '2021-02-02' } },
    { id: 'right1234567', name: 'Levitating', duration_ms: 203_000, artists: [{ id: 'dua12345678', name: 'Dua Lipa' }], album: { name: 'Future Nostalgia', album_type: 'album', release_date: '2020-03-27' } }
  ]);
  const trivia = createTrivia({ fetch: noWiki, spotify: sp.get });
  const t = track('Dua Lipa - Levitating', 'Dua Lipa');
  const got = [await trivia.getFact(t, 'en'), await trivia.getFact(t, 'en')];
  assert.deepEqual(got, [
    { kind: 'album', data: { title: 'Levitating', artist: 'Dua Lipa', album: 'Future Nostalgia', year: '2020' } },
    { kind: 'genre', data: { artist: 'Dua Lipa', genre: 'dance pop' } }
  ]);
  assert.ok(sp.calls.some(u => u.endsWith('/v1/artists/dua12345678')));
});

test('Spotify: only another artist\'s song with that title → no fact', async () => {
  const sp = spotifyFake([
    { id: 'other1234567', name: 'Levitating', duration_ms: 203_000, artists: [{ id: 'kygo1234567', name: 'Kygo' }], album: { name: 'Kygo Album', album_type: 'album', release_date: '2021-02-02' } }
  ]);
  const trivia = createTrivia({ fetch: noWiki, spotify: sp.get });
  assert.equal(await trivia.getFact(track('Dua Lipa - Levitating', 'Dua Lipa'), 'en'), null);
});
