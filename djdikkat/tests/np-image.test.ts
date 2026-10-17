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
