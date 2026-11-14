// Spotify resolver checks — `npm test`. No network: a fake fetch plays Spotify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpotifyClient, parseSpotifyUrl, toSpec } from '../src/music/spotify.ts';
import { UserError } from '../src/lib/errors.ts';

const ID = '4uLU6hMCjMI75M1A2tKUQC';
const API = 'https://api.spotify.com/v1';

/** A client whose fetch answers from `route(url)`; logs every URL it was asked for. */
function fake(route: (url: string, calls: string[]) => Response | Promise<Response>) {
  const calls: string[] = [];
  const client = createSpotifyClient({
    fetch: async input => {
      const url = String(input);
      calls.push(url);
      return route(url, calls);
    },
    sleep: async () => {},
    credentials: () => ({ clientId: 'id', clientSecret: 'secret' })
  });
  return { client, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const tokenRes = () => json({ access_token: 'tok', expires_in: 3600 });
const song = (n: number) => ({ type: 'track', name: `Song ${n}`, artists: [{ name: 'Artist' }], duration_ms: 1000 * n });

test('parses track/album/playlist/artist links in every form', () => {
  assert.deepEqual(parseSpotifyUrl(`https://open.spotify.com/track/${ID}`), { type: 'track', id: ID });
  assert.deepEqual(parseSpotifyUrl(`https://open.spotify.com/track/${ID}?si=abc123&context=x`), { type: 'track', id: ID });
  assert.deepEqual(parseSpotifyUrl(`https://open.spotify.com/intl-tr/album/${ID}?si=1`), { type: 'album', id: ID, market: 'TR' });
  assert.deepEqual(parseSpotifyUrl(`https://open.spotify.com/intl-pt-br/artist/${ID}`), { type: 'artist', id: ID, market: 'PT' });
  assert.deepEqual(parseSpotifyUrl(`https://open.spotify.com/embed/playlist/${ID}`), { type: 'playlist', id: ID });
  assert.deepEqual(parseSpotifyUrl(`https://open.spotify.com/user/someone/playlist/${ID}`), { type: 'playlist', id: ID });
  assert.deepEqual(parseSpotifyUrl(`https://play.spotify.com/track/${ID}/`), { type: 'track', id: ID });
});

test('rejects links that are not a usable Spotify item', () => {
  assert.equal(parseSpotifyUrl(`https://open.spotify.com/episode/${ID}`), null);
  assert.equal(parseSpotifyUrl('https://open.spotify.com/track/'), null);
  assert.equal(parseSpotifyUrl('https://open.spotify.com/track/abc%2F..%2Fme'), null);
  assert.equal(parseSpotifyUrl(`https://evil.example/track/${ID}`), null);
  assert.equal(parseSpotifyUrl('not a url'), null);
});

test('skips removed, local and episode entries', () => {
  assert.equal(toSpec(null), null);
  assert.equal(toSpec({ name: 'Local', is_local: true }), null);
  assert.equal(toSpec({ name: 'Podcast', type: 'episode' }), null);
  assert.equal(toSpec({ name: '  ' }), null);
  assert.deepEqual(toSpec(song(3)), { title: 'Song 3', artist: 'Artist', durationMs: 3000 });
});

test('playlist paging stops at the limit and at the page cap', async () => {
  const { client, calls } = fake(url => {
    if (url.includes('accounts.spotify.com')) return tokenRes();
    const page = Number(new URL(url).searchParams.get('page') ?? 0);
    // Every page: 2 songs + junk, and always another page.
    return json({
      items: [{ track: song(page * 2) }, null, { track: null }, { track: { name: 'L', is_local: true } }, { item: song(page * 2 + 1) }],
      next: `${API}/playlists/${ID}/tracks?page=${page + 1}`
    });
  });
  const few = await client.resolve(`https://open.spotify.com/playlist/${ID}`, 3);
  assert.deepEqual(few.map(s => s.title), ['Song 0', 'Song 1', 'Song 2']);

  calls.length = 0;
  const many = await client.resolve(`https://open.spotify.com/playlist/${ID}`, 1000);
  assert.equal(many.length, 8);                                // first page + 3 more, 2 songs each
  assert.equal(calls.filter(u => u.includes('/playlists/')).length, 4);
});

test('a next link outside the API is not followed with the token', async () => {
  const { client, calls } = fake(url => url.includes('accounts') ? tokenRes()
    : json({ items: [{ track: song(1) }], next: 'https://evil.example/steal' }));
  await assert.rejects(client.resolve(`https://open.spotify.com/playlist/${ID}`, 5));
  assert.ok(!calls.some(u => u.includes('evil.example')));
});

test('parallel requests share one token request', async () => {
  const { client, calls } = fake(url => url.includes('accounts') ? tokenRes() : json(song(1)));
  await Promise.all([1, 2, 3].map(() => client.resolve(`https://open.spotify.com/track/${ID}`)));
  assert.equal(calls.filter(u => u.includes('accounts')).length, 1);
});

test('a 401 gets one retry with a fresh token', async () => {
  let rejected = false;
  const { client, calls } = fake(url => {
    if (url.includes('accounts')) return tokenRes();
    if (!rejected) { rejected = true; return json({}, 401); }
    return json(song(1));
  });
  assert.equal((await client.resolve(`https://open.spotify.com/track/${ID}`))[0]?.title, 'Song 1');
  assert.equal(calls.filter(u => u.includes('accounts')).length, 2);
});

test('5xx is retried a bounded number of times', async () => {
  const { client, calls } = fake(url => url.includes('accounts') ? tokenRes() : json({}, 503));
  await assert.rejects(client.resolve(`https://open.spotify.com/track/${ID}`), /HTTP 503/);
  assert.equal(calls.filter(u => u.includes('/tracks/')).length, 3);
});

test('a short 429 is waited out, a long one becomes a UserError without more requests', async () => {
  let n = 0;
  const short = fake(url => url.includes('accounts') ? tokenRes()
    : (n += 1) === 1 ? json({}, 429, { 'retry-after': '1' }) : json(song(1)));
  assert.equal((await short.client.resolve(`https://open.spotify.com/track/${ID}`)).length, 1);

  const long = fake(url => url.includes('accounts') ? tokenRes() : json({}, 429, { 'retry-after': '3600' }));
  await assert.rejects(long.client.resolve(`https://open.spotify.com/track/${ID}`),
    (err: unknown) => err instanceof UserError && err.key === 'search.spotify_busy');
  const before = long.calls.length;
  await assert.rejects(long.client.resolve(`https://open.spotify.com/track/${ID}`), UserError);
  assert.equal(long.calls.length, before);                   // blocked locally while the ban lasts
});

test('a missing track is no tracks, not an error', async () => {
  const { client } = fake(url => url.includes('accounts') ? tokenRes() : json({ error: { status: 404 } }, 404));
  assert.deepEqual(await client.resolve(`https://open.spotify.com/track/${ID}`), []);
});

test('short links: followed hop by hop, never off Spotify', async () => {
  const short = new Set(['spotify.link', 'spotify.app.link']);
  const pages = new Set(['open.spotify.com']);
  const asked: string[] = [];
  const redirect = (to: string) => new Response(null, { status: 307, headers: { location: to } });
  const fetchFn = (async (input: string | URL) => {
    const url = String(input);
    asked.push(url);
    if (url.includes('/good')) return redirect('https://spotify.app.link/next');
    if (url.includes('/next')) return redirect(`https://open.spotify.com/playlist/${ID}?si=1`);
    if (url.includes('/evil')) return redirect('http://169.254.169.254/latest/meta-data/');
    if (url.includes('/loop')) return redirect('https://spotify.link/loop');
    return new Response('page', { status: 200 });
  }) as typeof fetch;
  const { followShortLink } = await import('../src/music/spotify.ts');
  assert.equal((await followShortLink('https://spotify.link/good', short, pages, fetchFn))?.href, `https://open.spotify.com/playlist/${ID}?si=1`);
  assert.ok(!asked.some(u => u.includes('open.spotify.com'))); // the target itself isn't fetched
  assert.equal(await followShortLink('https://spotify.link/evil', short, pages, fetchFn), null);
  assert.equal(await followShortLink('https://spotify.link/loop', short, pages, fetchFn), null);
  assert.equal(await followShortLink('https://spotify.link/page', short, pages, fetchFn), null);
  assert.equal(await followShortLink('https://spotify.link:8443/x', short, pages, fetchFn), null);
  assert.ok(!asked.some(u => u.includes('169.254') || u.includes(':8443')));
  assert.ok(asked.filter(u => u.includes('/loop')).length <= 6);
});

test('a spotify.link resolves through the redirect', async () => {
  const { client } = fake(url => {
    if (url.startsWith('https://spotify.link/')) return new Response(null, { status: 307, headers: { location: `https://open.spotify.com/track/${ID}` } });
    return url.includes('accounts') ? tokenRes() : json(song(4));
  });
  assert.equal((await client.resolve('https://spotify.link/abc'))[0]?.title, 'Song 4');
});

test('playlist entries: `item` wins over a non-object `track`; a bad playlist id is no tracks', async () => {
  const { client } = fake(url => url.includes('accounts') ? tokenRes()
    : json({ items: [{ track: true, item: song(7) }, { track: song(8) }], next: null }));
  assert.deepEqual((await client.resolve(`https://open.spotify.com/playlist/${ID}`, 5)).map(s => s.title), ['Song 7', 'Song 8']);
  const bad = fake(url => url.includes('accounts') ? tokenRes() : json({ error: { status: 400 } }, 400));
  assert.deepEqual(await bad.client.resolve(`https://open.spotify.com/playlist/${ID}`, 5), []);
});

test('a failed token request is not cached', async () => {
  let tokenCalls = 0;
  const { client } = fake(url => {
    if (url.includes('accounts')) return (tokenCalls += 1) === 1 ? json({}, 400) : tokenRes();
    return json(song(2));
  });
  await assert.rejects(client.resolve(`https://open.spotify.com/track/${ID}`), /check client id/);
  assert.equal((await client.resolve(`https://open.spotify.com/track/${ID}`))[0]?.title, 'Song 2');
});
