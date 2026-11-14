// Sound effect checks — `npm test`. (Autoplay has its own file: autoplay.test.ts.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILTERS, PRESETS, filterSet, filterSpeed, isFilter } from '../src/music/filters.ts';

test('every preset is a filter set with a sane speed; off clears', () => {
  for (const name of FILTERS) {
    assert.ok(Object.keys(PRESETS[name].filters).length > 0, name);
    assert.ok(filterSpeed(name) >= 0.8 && filterSpeed(name) <= 1.25, name);
  }
  assert.deepEqual(filterSet(null), {});
  assert.equal(filterSpeed(null), 1);
  assert.ok(isFilter('nightcore') && !isFilter('off') && !isFilter('loud'));
});
