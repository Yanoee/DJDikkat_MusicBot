import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderNowPlaying } from '../src/ui/np-image.ts';

test('renders a PNG without artwork, live and paused', async () => {
  for (const lengthMs of [0, 385000]) {
    const png = await renderNowPlaying({
      title: 'Heal the World', artist: 'Michael Jackson', artworkUrl: null,
      positionMs: 99000, lengthMs, paused: lengthMs === 0, label: 'Now playing',
      liveLabel: 'Live', source: 'YouTube', locale: 'en'
    });
    assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]); // "PNG"
  }
});

test('status chips: drawn when on, the image changes, too many still render', async () => {
  const base = {
    title: 'Bobiturma', artist: 'Macroblack', artworkUrl: null, positionMs: 61000, lengthMs: 200000,
    paused: false, label: 'Now playing', liveLabel: 'Live', source: 'YouTube', locale: 'tr'
  };
  const plain = await renderNowPlaying(base);
  const many = await renderNowPlaying({ ...base, chips: ['Nightcore', '♾ Otomatik', '🔂 Şarkı tekrarı', 'Slowed + reverb', 'Extra', 'More'] });
  assert.deepEqual([...many.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  assert.ok(many.length > plain.length * 0.5 && !many.equals(plain));
});
