// DJ transitions — `npm test`. The setting's validation, what NodeLink gets, and the permission key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CROSSFADE_MAX_S, cleanTransitions } from '../src/services/features.ts';
import type { Transitions } from '../src/services/features.ts';
import { transitionsPayload } from '../src/music/transitions.ts';
import { NORMAL_DJ_KEYS, PERM_KEYS } from '../src/services/access.ts';

const DEFAULT: Transitions = { enabled: true, crossfadeS: 4, leveling: true };

test('cleanTransitions: crossfade is a whole number of seconds, 0..12', () => {
  assert.equal(CROSSFADE_MAX_S, 12);
  assert.equal(cleanTransitions({ crossfadeS: -3 }, DEFAULT).crossfadeS, 0);
  assert.equal(cleanTransitions({ crossfadeS: 13 }, DEFAULT).crossfadeS, 12);
  assert.equal(cleanTransitions({ crossfadeS: 999 }, DEFAULT).crossfadeS, 12);
  assert.equal(cleanTransitions({ crossfadeS: 0 }, DEFAULT).crossfadeS, 0);
  assert.equal(cleanTransitions({ crossfadeS: 12 }, DEFAULT).crossfadeS, 12);
  assert.equal(cleanTransitions({ crossfadeS: 7 }, DEFAULT).crossfadeS, 7);
  assert.ok(Number.isInteger(cleanTransitions({ crossfadeS: 4.6 }, DEFAULT).crossfadeS));
  assert.equal(cleanTransitions({ crossfadeS: 4.6 }, DEFAULT).crossfadeS, 5);   // rounded, not floored
  assert.equal(cleanTransitions({ crossfadeS: 4.4 }, DEFAULT).crossfadeS, 4);
});

test('cleanTransitions: wrong types are ignored and the current value kept', () => {
  const current: Transitions = { enabled: false, crossfadeS: 9, leveling: false };
  for (const crossfadeS of ['6', null, undefined, NaN, Infinity, -Infinity, true, {}, [3]]) {
    assert.equal(cleanTransitions({ crossfadeS } as never, current).crossfadeS, 9, String(crossfadeS));
  }
  for (const bad of ['true', 1, 0, null, 'yes', {}]) {
    const out = cleanTransitions({ enabled: bad, leveling: bad } as never, current);
    assert.equal(out.enabled, false, String(bad));
    assert.equal(out.leveling, false, String(bad));
  }
  assert.deepEqual(cleanTransitions({ enabled: true, leveling: true }, current), { enabled: true, crossfadeS: 9, leveling: true });
});

test('cleanTransitions: partial input keeps the rest, unknown fields dropped', () => {
  assert.deepEqual(cleanTransitions({ enabled: false }, DEFAULT), { enabled: false, crossfadeS: 4, leveling: true });
  assert.deepEqual(cleanTransitions({ leveling: false }, DEFAULT), { enabled: true, crossfadeS: 4, leveling: false });
  assert.deepEqual(cleanTransitions({ crossfadeS: 8 }, DEFAULT), { enabled: true, crossfadeS: 8, leveling: true });
  const out = cleanTransitions({ crossfadeS: 2, evil: 'x', __proto__: { polluted: true } } as never, DEFAULT);
  assert.deepEqual(Object.keys(out).sort(), ['crossfadeS', 'enabled', 'leveling']);
  assert.deepEqual(out, { enabled: true, crossfadeS: 2, leveling: true });
});

test('cleanTransitions: garbage input returns the current settings unchanged', () => {
  const current: Transitions = { enabled: true, crossfadeS: 6, leveling: false };
  for (const input of [null, undefined, 'on', 42, true, [], [1, 2, 3], {}]) {
    assert.deepEqual(cleanTransitions(input as never, current), current, JSON.stringify(input) ?? 'undefined');
  }
  const before = { ...current };
  cleanTransitions({ crossfadeS: 1, enabled: false }, current);
  assert.deepEqual(current, before);                                                    // never mutates current
});

test('transitionsPayload: off sends nothing on', () => {
  const p = transitionsPayload({ enabled: false, crossfadeS: 4, leveling: true }) as {
    fading: { enabled?: boolean }; crossfade: { enabled?: boolean }; loudnessNormalizer: boolean };
  assert.equal(p.fading.enabled, false);
  assert.equal(p.crossfade.enabled, false);
  assert.equal(p.loudnessNormalizer, false);
});

test('transitionsPayload: on with 4 s crossfade, fades and leveling', () => {
  const p = transitionsPayload({ enabled: true, crossfadeS: 4, leveling: true }) as {
    fading: { enabled?: boolean }; crossfade: { enabled?: boolean; duration?: number }; loudnessNormalizer: boolean };
  assert.equal(p.fading.enabled, true);
  assert.equal(p.crossfade.enabled, true);
  assert.equal(p.crossfade.duration, 4000);                                             // milliseconds
  assert.equal(p.loudnessNormalizer, true);
  const twelve = transitionsPayload({ enabled: true, crossfadeS: 12, leveling: true }) as { crossfade: { duration?: number } };
  assert.equal(twelve.crossfade.duration, 12000);
});

test('transitionsPayload: crossfade 0 keeps fades and leveling, no crossfade', () => {
  const p = transitionsPayload({ enabled: true, crossfadeS: 0, leveling: true }) as {
    fading: { enabled?: boolean }; crossfade: { enabled?: boolean }; loudnessNormalizer: boolean };
  assert.equal(p.crossfade.enabled, false);
  assert.equal(p.fading.enabled, true);
  assert.equal(p.loudnessNormalizer, true);
});

test('transitionsPayload: leveling off turns only the normalizer off', () => {
  const p = transitionsPayload({ enabled: true, crossfadeS: 4, leveling: false }) as {
    fading: { enabled?: boolean }; crossfade: { enabled?: boolean }; loudnessNormalizer: boolean };
  assert.equal(p.loudnessNormalizer, false);
  assert.equal(p.fading.enabled, true);
  assert.equal(p.crossfade.enabled, true);
});

test('access: transitions is a permission key and DJ-only in Normal mode', () => {
  assert.ok((PERM_KEYS as readonly string[]).includes('transitions'));
  assert.ok((NORMAL_DJ_KEYS as readonly string[]).includes('transitions'));
});
