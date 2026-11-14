// Radio host setting — `npm test`. The setting's validation (types, choices, jingle links) and the permission key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JINGLE_URL_MAX, cleanRadio, defaultFeatures, isJingleUrl } from '../src/services/features.ts';
import type { Radio } from '../src/services/features.ts';
import { NORMAL_DJ_KEYS, PERM_KEYS } from '../src/services/access.ts';

const DEFAULT: Radio = { enabled: false, every: 3, trivia: true, names: true, volume: 'normal', jingles: true, jingleUrl: null };

test('radio: off by default, every 3 songs, everything else on', () => {
  assert.deepEqual(defaultFeatures().radio, DEFAULT);
});

test('cleanRadio: every and volume only take their choices', () => {
  for (const every of [0, 1, 3, 5] as const) assert.equal(cleanRadio({ every }, DEFAULT).every, every);
  for (const every of [2, 4, 6, 10, -1, 3.5, '3', null, true, NaN]) {
    assert.equal(cleanRadio({ every } as never, DEFAULT).every, 3, String(every));
  }
  for (const volume of ['quiet', 'normal', 'loud'] as const) assert.equal(cleanRadio({ volume }, DEFAULT).volume, volume);
  for (const volume of ['Loud', 'max', '', 1, null, true]) {
    assert.equal(cleanRadio({ volume } as never, { ...DEFAULT, volume: 'quiet' }).volume, 'quiet', String(volume));
  }
});

test('cleanRadio: booleans only as booleans, partial input keeps the rest', () => {
  const current: Radio = { ...DEFAULT, enabled: true, trivia: false };
  for (const bad of ['true', 1, 0, null, 'yes', {}]) {
    const out = cleanRadio({ enabled: bad, trivia: bad, names: bad, jingles: bad } as never, current);
    assert.deepEqual(out, current, String(bad));
  }
  assert.deepEqual(cleanRadio({ enabled: true }, DEFAULT), { ...DEFAULT, enabled: true });
  assert.deepEqual(cleanRadio({ names: false, jingles: false }, DEFAULT), { ...DEFAULT, names: false, jingles: false });
});

test('cleanRadio: garbage input and unknown fields', () => {
  for (const input of [null, undefined, 'on', 42, true, [], [1, 2], {}]) {
    assert.deepEqual(cleanRadio(input as never, DEFAULT), DEFAULT, JSON.stringify(input) ?? 'undefined');
  }
  const out = cleanRadio({ every: 5, evil: 'x', __proto__: { polluted: true } } as never, DEFAULT);
  assert.deepEqual(Object.keys(out).sort(), ['enabled', 'every', 'jingleUrl', 'jingles', 'names', 'trivia', 'volume']);
  const before = { ...DEFAULT };
  cleanRadio({ enabled: true, every: 1 }, DEFAULT);
  assert.deepEqual(DEFAULT, before);                                                         // never mutates current
});

test('cleanRadio: jingle links from YouTube and SoundCloud over https are kept', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://soundcloud.com/artist/jingle',
    'https://m.soundcloud.com/artist/jingle',
    'https://on.soundcloud.com/AbCd1'
  ]) {
    assert.equal(cleanRadio({ jingleUrl: url }, DEFAULT).jingleUrl, url, url);
    assert.ok(isJingleUrl(url), url);
  }
  assert.equal(cleanRadio({ jingleUrl: '  https://youtu.be/abc  ' }, DEFAULT).jingleUrl, 'https://youtu.be/abc');   // trimmed
});

test('cleanRadio: other links are refused and the current one kept', () => {
  const own = 'https://youtu.be/own';
  const current: Radio = { ...DEFAULT, jingleUrl: own };
  const long = `https://www.youtube.com/watch?v=${'a'.repeat(JINGLE_URL_MAX)}`;
  for (const url of [
    'http://www.youtube.com/watch?v=x',            // not https
    'http://youtu.be/x',
    'https://example.com/jingle.mp3',             // other host
    'https://youtube.com.evil.com/watch?v=x',
    'https://evilyoutube.com/watch?v=x',
    'https://youtu.be@evil.com/x',
    'https://user:pass@youtube.com/watch?v=x',
    'https://youtube.com:8443/watch?v=x',
    'ftp://soundcloud.com/a',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'youtube.com/watch?v=x',                      // no scheme
    'https://youtu.be/a b',
    'https://youtu.be/a\nb',
    long,                                         // too long
    'default', 42, true, {}, []
  ]) {
    assert.equal(cleanRadio({ jingleUrl: url } as never, current).jingleUrl, own, String(url));
  }
  assert.ok(long.length > JINGLE_URL_MAX);
  assert.equal(isJingleUrl(long), false);
  const exact = `https://youtu.be/${'a'.repeat(JINGLE_URL_MAX - 'https://youtu.be/'.length)}`;
  assert.equal(exact.length, JINGLE_URL_MAX);
  assert.ok(isJingleUrl(exact));
});

test('cleanRadio: null or empty goes back to the stock jingles', () => {
  const current: Radio = { ...DEFAULT, jingleUrl: 'https://youtu.be/own' };
  assert.equal(cleanRadio({ jingleUrl: null }, current).jingleUrl, null);
  assert.equal(cleanRadio({ jingleUrl: '' }, current).jingleUrl, null);
  assert.equal(cleanRadio({ jingleUrl: '   ' }, current).jingleUrl, null);
  assert.equal(cleanRadio({}, current).jingleUrl, 'https://youtu.be/own');                // left out = unchanged
});

test('access: radio is a permission key and DJ-only in Normal mode', () => {
  const keys = PERM_KEYS as readonly string[];
  assert.ok(keys.includes('radio'));
  assert.equal(keys.indexOf('radio'), keys.indexOf('transitions') + 1);
  assert.ok((NORMAL_DJ_KEYS as readonly string[]).includes('radio'));
});
