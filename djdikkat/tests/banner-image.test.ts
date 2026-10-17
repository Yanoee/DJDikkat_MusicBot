import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLaunch, renderWelcome, loadRemote } from '../src/ui/banner-image.ts';

const isPng = (b: Buffer) => assert.deepEqual([...b.subarray(1, 4)], [0x50, 0x4e, 0x47]);

test('welcome card and launch banner render as PNG without network images', async () => {
  isPng(await renderWelcome({ kicker: 'Welcome', name: 'Yanoee', line: 'Member #153 · OG Labs', avatarUrl: '', accent: '#3b82c4', background: null, locale: 'en' }));
  isPng(await renderLaunch({ kicker: 'Yepyeni · sürüm 6', tagline: 'Yeni görünüm.', chips: ['Web paneli', 'İstatistik'], locale: 'tr' }));
});

test('card images refuse non-https, IP and localhost URLs', async () => {
  for (const url of ['http://example.com/a.png', 'https://127.0.0.1/a.png', 'https://localhost/a.png', 'https://[::1]/a.png', 'nonsense']) {
    assert.equal(await loadRemote(url), null, url);
  }
});
