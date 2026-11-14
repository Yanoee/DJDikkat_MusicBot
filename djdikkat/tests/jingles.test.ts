// Radio jingles — `npm test`. Which jingle plays, the stock rotation, and which own links are allowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JINGLE_MAX_MS, isJingleLink, jingleFor, stockJingles } from '../src/music/jingles.ts';

const ON = { jingles: true, jingleUrl: null };

test('stockJingles: three absolute paths inside NodeLink local-music/jingles', () => {
  const ids = stockJingles();
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) assert.match(id, /^\/home\/apps\/nodelink\/local-music\/jingles\/dj-[a-z]+\.wav$/);
  assert.deepEqual(ids.map((id) => id.split('/').pop()), ['dj-classic.wav', 'dj-electro.wav', 'dj-cinematic.wav']);
});

test('JINGLE_MAX_MS is 10 s', () => {
  assert.equal(JINGLE_MAX_MS, 10_000);
});

test('jingleFor: off means no jingle, even with an own link', () => {
  assert.equal(jingleFor('1', { jingles: false, jingleUrl: null }), null);
  assert.equal(jingleFor('1', { jingles: false, jingleUrl: 'https://youtu.be/abc' }), null);
});

test('jingleFor: a valid own link always wins', () => {
  const url = 'https://soundcloud.com/someone/station-id';
  for (let i = 0; i < 4; i++) assert.equal(jingleFor('2', { jingles: true, jingleUrl: url }), url);
});

test('jingleFor: an invalid own link falls back to the stock ones', () => {
  const got = jingleFor('3', { jingles: true, jingleUrl: 'http://youtube.com/watch?v=x' });
  assert.ok(stockJingles().includes(got!));
});

test('jingleFor: stock jingles rotate per server, no repeats back to back', () => {
  const stock = stockJingles();
  const seq = Array.from({ length: 7 }, () => jingleFor('111111111111111111', ON)!);
  for (const id of seq) assert.ok(stock.includes(id));
  assert.equal(new Set(seq.slice(0, 3)).size, 3);           // every stock one in the first round
  for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1]);
  assert.equal(seq[3], seq[0]);                              // then the same order again
  // another server keeps its own place in the rotation
  const other = jingleFor('222222222222222222', ON);
  assert.equal(jingleFor('111111111111111111', ON), seq[1]);
  assert.ok(stock.includes(other!));
});

test('isJingleLink: https YouTube / YouTube Music / SoundCloud links only', () => {
  for (const ok of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=abc',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://soundcloud.com/artist/track',
    'https://m.soundcloud.com/artist/track',
    'https://YOUTU.BE/abc',
    'https://m.youtube.com/watch?v=abc',
    'https://on.soundcloud.com/AbCd',
  ]) assert.equal(isJingleLink(ok), true, ok);
  for (const bad of [
    'http://youtu.be/abc',                          // not https
    'https://youtu.be/',                            // no path
    'https://evil.com/youtube.com/watch?v=x',
    'https://youtube.com.evil.com/watch?v=x',
    'https://notyoutube.com/watch?v=x',
    'https://user:pw@youtube.com/watch?v=x',
    'https://youtube.com:8443/watch?v=x',
    'https://open.spotify.com/track/abc',
    'ftp://soundcloud.com/a/b',
    ' https://youtu.be/abc',
    'https://youtu.be/a b',
    'youtu.be/abc',
    `https://youtu.be/${'a'.repeat(300)}`,         // > 300 chars
    '', null, undefined, 42, {},
  ]) assert.equal(isJingleLink(bad), false, String(bad));
});
