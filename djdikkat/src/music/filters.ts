/************************************************************
 * DJ DIKKAT - Music Bot
 * Sound effects
 * One preset at a time (bass boost, nightcore, 8D …), sent to
 * NodeLink as a whole filter set; "off" clears them all.
 * Echo and reverb are NodeLink's own filters (not in
 * Lavalink's list), so the set goes out as plain JSON.
 * Author: Yanoee
 ************************************************************/
import type { FilterOptions } from 'shoukaku';

export const FILTERS = ['bass', 'nightcore', 'vaporwave', 'slowed', '8d', 'karaoke', 'soft', 'treble', 'echo'] as const;
export type FilterName = typeof FILTERS[number];

export const isFilter = (v: unknown): v is FilterName => FILTERS.includes(v as FilterName);

/** Equalizer gains for bands 0, 1, 2 … (25.6 Hz upwards). */
const eq = (...gains: number[]) => gains.map((gain, band) => ({ band, gain }));
const HIGH_BANDS = [8, 9, 10, 11, 12, 13, 14];

/** What each preset sends, and how fast songs run with it on (the website's clock needs that). */
export const PRESETS: Record<FilterName, { filters: Record<string, unknown>; speed: number }> = {
  bass:      { speed: 1, filters: { equalizer: eq(0.3, 0.25, 0.2, 0.12, 0.05, 0) } },
  nightcore: { speed: 1.2, filters: { timescale: { speed: 1.2, pitch: 1.2, rate: 1 } } },
  vaporwave: { speed: 0.85, filters: { timescale: { speed: 0.85, pitch: 0.85, rate: 1 }, equalizer: eq(0.15, 0.1, 0.05) } },
  slowed:    { speed: 0.85, filters: { timescale: { speed: 0.85, pitch: 0.9, rate: 1 }, reverb: { mix: 0.3, roomSize: 0.7, damping: 0.4, width: 1 } } },
  '8d':      { speed: 1, filters: { rotation: { rotationHz: 0.2 } } },
  karaoke:   { speed: 1, filters: { karaoke: { level: 1, monoLevel: 1, filterBand: 220, filterWidth: 100 } } },
  soft:      { speed: 1, filters: { lowPass: { smoothing: 20 } } },
  treble:    { speed: 1, filters: { equalizer: HIGH_BANDS.map(band => ({ band, gain: 0.2 })) } },
  echo:      { speed: 1, filters: { echo: { delay: 280, feedback: 0.35, mix: 0.4 } } }
};

/** The filter set for a preset, or the empty set that clears everything. */
export const filterSet = (name: FilterName | null) => (name ? PRESETS[name].filters : {}) as FilterOptions;
export const filterSpeed = (name: FilterName | null) => (name ? PRESETS[name].speed : 1);
