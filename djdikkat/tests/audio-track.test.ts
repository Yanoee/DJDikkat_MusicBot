// Original-audio pick (skips YouTube AI auto-dubs) — `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originalAudioTrackId } from '../src/music/audio-track.ts';

const DUBBED = '[{"id":"en-US.10","name":"English (US)","isDefault":true,"isAutoDubbed":true},{"id":"ru.4","name":"Russian original","isDefault":false,"isAutoDubbed":false}]';

test('auto-dubbed default → the original track', () => {
  assert.equal(originalAudioTrackId({ audioTracks: DUBBED }), 'ru.4');
  assert.equal(originalAudioTrackId({ audioTracks: JSON.parse(DUBBED) }), 'ru.4');
});

test('prefers a track named "original", else the first non-dubbed one', () => {
  const tracks = [
    { id: 'en.1', name: 'English (US)', isDefault: true, isAutoDubbed: true },
    { id: 'de.2', name: 'German', isDefault: false, isAutoDubbed: false },
    { id: 'ja.3', name: 'Japanese original', isDefault: false, isAutoDubbed: false }
  ];
  assert.equal(originalAudioTrackId({ audioTracks: JSON.stringify(tracks) }), 'ja.3');
  assert.equal(originalAudioTrackId({ audioTracks: JSON.stringify(tracks.slice(0, 2)) }), 'de.2');
});

test('no dub → undefined', () => {
  const tracks = [
    { id: 'ru.4', name: 'Russian original', isDefault: true, isAutoDubbed: false },
    { id: 'en.10', name: 'English (US)', isDefault: false, isAutoDubbed: true }
  ];
  assert.equal(originalAudioTrackId({ audioTracks: JSON.stringify(tracks) }), undefined);
  // only a dub available → nothing better to ask for
  assert.equal(originalAudioTrackId({ audioTracks: '[{"id":"en.1","name":"English","isDefault":true,"isAutoDubbed":true}]' }), undefined);
});

test('missing or malformed data → undefined', () => {
  for (const info of [undefined, null, {}, 'x', { audioTracks: '' }, { audioTracks: '{not json' }, { audioTracks: '{"id":"x"}' }, { audioTracks: '[null,1,"a"]' }, { audioTracks: 42 }]) {
    assert.equal(originalAudioTrackId(info), undefined);
  }
});
