// Catalog checks — `npm test`. Every language must have exactly en.json's
// keys, with the same {placeholders}, and t() must pick plural forms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import en from '../src/i18n/en.json' with { type: 'json' };
import tr from '../src/i18n/tr.json' with { type: 'json' };
import { t, toLocale } from '../src/i18n/index.ts';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('tr.json has the same keys as en.json', () => {
  assert.deepEqual(Object.keys(tr).sort(), Object.keys(en).sort());
});

test('placeholders match in every translation', () => {
  for (const [key, text] of Object.entries(en)) {
    assert.deepEqual(placeholders((tr as Record<string, string>)[key]!), placeholders(text), key);
  }
});

test('t() fills placeholders and picks plural forms', () => {
  assert.equal(t('en', 'play.added', { count: 1 }), '✅ Added **1** track');
  assert.equal(t('en', 'play.added', { count: 3 }), '✅ Added **3** tracks');
  assert.equal(t('tr', 'common.slow_down', { seconds: 4 }), '⏳ Biraz yavaş; **4 sn** bekle');
});

test('Discord locales map to ours, English otherwise', () => {
  assert.equal(toLocale('tr'), 'tr');
  assert.equal(toLocale('en-GB'), 'en');
  assert.equal(toLocale('de'), 'en');
  assert.equal(toLocale(undefined), 'en');
});
