/************************************************************
 * DJ DIKKAT - Music Bot
 * DJ transitions
 * Crossfade between songs, short fades on pause / resume /
 * skip / stop / seek, and loudness leveling. NodeLink does
 * all of it per player (PATCH fading / crossfade /
 * loudnessNormalizer); a crossfade also needs the next song
 * preloaded (PATCH nextTrack), and NodeLink then switches to
 * it by itself — player.ts only follows along.
 * Author: Yanoee
 ************************************************************/
import type { Player, UpdatePlayerOptions } from 'shoukaku';
import { peekState } from './state.ts';
import type { GuildState } from './state.ts';
import { originalAudioTrackId } from './audio-track.ts';
import { upsertController } from '../ui/player-card.ts';
import { getTransitions, setTransitionsFeature } from '../services/features.ts';
import { musicVolume } from './radio.ts';
import type { Transitions } from '../services/features.ts';
import { errMsg } from '../lib/errors.ts';
import type { QueueTrack } from '../lib/types.ts';

// Short enough to never feel like lag on a button, long enough to take the click out.
const FADE_EDGE_MS = 400;   // song start, skip, stop
const FADE_SOFT_MS = 250;   // pause, resume, seek

/** One NodeLink fading section (a plain volume ramp). */
const fade = (duration: number) => ({ duration, curve: 'sine', type: 'volume' });

/**
 * Pure: what NodeLink gets for these settings (PATCH /sessions/:id/players/:guild body fields).
 * Each PATCH replaces the player's whole fading / crossfade config, and these
 * per-player values win over NodeLink's global config (which has both off).
 * `volume`: the music volume to (re)send (NodeLink keeps a player's volume,
 * so a reused player that a cut host line left turned down gets it back to
 * normal here). Left out = not sent (radio.ts owns it while the host talks).
 */
export function transitionsPayload(t: Transitions, volume?: number): { fading: object; crossfade: object; loudnessNormalizer: boolean; volume?: number } {
  const crossfadeMs = Math.max(0, Math.round(t.crossfadeS)) * 1000;
  return {
    ...(volume === undefined ? {} : { volume }),
    fading: {
      enabled: t.enabled,
      trackStart: fade(FADE_EDGE_MS),
      // A song's own ending: the crossfade covers it, and without one songs
      // already end on their outro. NodeLink also arms this one even with
      // fading off and doesn't re-arm it on pause, so it stays 0.
      trackEnd: fade(0),
      trackStop: fade(FADE_EDGE_MS),
      seek: fade(FADE_SOFT_MS),
      pause: fade(FADE_SOFT_MS),
      resume: fade(FADE_SOFT_MS)
    },
    // 'preload' = NodeLink buffers the next song ahead and mixes it in.
    crossfade: { enabled: t.enabled && crossfadeMs > 0, duration: crossfadeMs, curve: 'sinusoidal', mode: 'preload' },
    loudnessNormalizer: t.enabled && t.leveling
  };
}

/** NodeLink's extra PATCH fields aren't in Shoukaku's type; Shoukaku sends the body as-is. */
const patch = (player: Player, guildId: string, body: Record<string, unknown>) =>
  player.node.rest.updatePlayer({ guildId, playerOptions: body as unknown as UpdatePlayerOptions });

/**
 * Sends the payload to the guild's current player (no-op without one). Never throws.
 * Call it on every new player before its first song: NodeLink builds a song's
 * stream crossfade-capable only if crossfade was on when the song started.
 */
export async function applyTransitions(guildId: string): Promise<void> {
  const player = peekState(guildId)?.player;
  if (!player) return;
  const t = getTransitions(guildId);
  const volume = musicVolume(guildId);
  try {
    await patch(player, guildId, transitionsPayload(t, volume));
    if (volume !== undefined) player.volume = volume; // Shoukaku resends its own copy when it resumes a player
  } catch (err) {
    console.warn(`[TRANSITIONS] guild=${guildId} not applied: ${errMsg(err)}`);
  }
  // Crossfade off makes NodeLink drop a crossfade preload on its own (a
  // crossfade that stays on keeps it, so what we know stays true then).
  if (!t.enabled || t.crossfadeS <= 0) forgetPreload(guildId);
}

/** Save + apply + redraw the player card. Used by /transitions and the web panel. */
export async function setTransitions(guildId: string, next: Partial<Transitions>): Promise<Transitions> {
  const saved = setTransitionsFeature(guildId, next);
  await applyTransitions(guildId);
  await syncNextTrack(guildId);
  const state = peekState(guildId);
  if (state?.client) await upsertController(guildId, state);
  return saved;
}

// ── Next-song preload ───────────────────────────────────────
// What NodeLink was last told comes next, per guild. Missing = unknown (a
// playTrack, a new player or NodeLink's own switch reset it), so the next
// sync sends again; a match with what we'd send now skips the PATCH.
interface Preload { player: Player; encoded: string | null }
const preloads = new Map<string, Preload>();
const syncing = new Map<string, Promise<void>>();
const resync = new Set<string>();
const forgets = new Map<string, number>(); // per guild: a send that raced a forget isn't recorded

// NodeLink answers playTrack before the song's stream exists, and a preload
// that arrives before it can't crossfade (NodeLink quietly makes it a plain
// gapless hand-over). So after a playTrack we wait for the TrackStartEvent;
// a song that never sends one (started paused, slow load) is preloaded anyway
// after START_WAIT_MS by the next player update.
const START_WAIT_MS = 5000;
const awaitingStart = new Map<string, number>(); // guildId -> when playTrack went out

/** The song that plays after the current one, by the same rules as player.ts (loop track / queue head / loop-queue wrap). */
export function upNext(state: GuildState): QueueTrack | null {
  if (!state.current) return null;
  if (state.loopCurrent) return state.current;
  return state.queue[0] ?? (state.loopQueue ? state.current : null);
}

/** What NodeLink should hold as nextTrack right now: nothing without a crossfade, and never a live stream. */
function wantedPreload(guildId: string, state: GuildState): QueueTrack | null {
  const t = getTransitions(guildId);
  if (!t.enabled || t.crossfadeS <= 0 || !state.current || state.current.info.isStream) return null;
  const next = upNext(state);
  return next && !next.info.isStream ? next : null;
}

/** Forget what NodeLink holds (a lost player, a disconnect …). */
export function forgetPreload(guildId: string): void {
  preloads.delete(guildId);
  awaitingStart.delete(guildId);
  forgets.set(guildId, (forgets.get(guildId) ?? 0) + 1);
}

/** player.ts sent a playTrack: NodeLink's preload is unknown now, and the next one waits for songStarted. */
export function songStarting(guildId: string): void {
  forgetPreload(guildId);
  awaitingStart.set(guildId, Date.now());
}

/** NodeLink's TrackStartEvent: the song's stream is up, preload what follows. */
export function songStarted(guildId: string): Promise<void> {
  awaitingStart.delete(guildId);
  return syncNextTrack(guildId);
}

/**
 * NodeLink just switched to its preloaded song by itself: returns that song's
 * encoded track if it was ours and sent to this player (null otherwise), and
 * forgets it (NodeLink's nextTrack is empty again now).
 */
export function consumePreload(guildId: string, player: Player | null): string | null {
  const known = preloads.get(guildId);
  forgetPreload(guildId);
  return known && player && known.player === player ? known.encoded : null;
}

async function sendPreload(guildId: string): Promise<void> {
  const state = peekState(guildId);
  const player = state?.player;
  if (!state || !player || state.disconnecting) return;
  const since = awaitingStart.get(guildId);
  if (since !== undefined) {
    if (Date.now() - since < START_WAIT_MS) return; // songStarted syncs
    awaitingStart.delete(guildId);
  }
  const next = wantedPreload(guildId, state);
  const encoded = next?.encoded ?? null;
  const known = preloads.get(guildId);
  if (known && known.player === player && known.encoded === encoded) return;

  const at = forgets.get(guildId) ?? 0;
  const audioTrackId = next ? originalAudioTrackId(next.pluginInfo) : undefined;
  // null clears it; the original-audio pick (see playOrReset) goes along like on play.
  const nextTrack = next ? { encoded, ...(audioTrackId ? { audioTrackId } : {}) } : null;
  try {
    await patch(player, guildId, { nextTrack });
  } catch (err) {
    console.warn(`[TRANSITIONS] guild=${guildId} next song not preloaded: ${errMsg(err)}`);
    return;
  }
  console.debug(`[TRANSITIONS] guild=${guildId} next=${next ? `"${next.info.title}"` : 'none'}`);
  if ((forgets.get(guildId) ?? 0) === at && state.player === player) preloads.set(guildId, { player, encoded });
}

/**
 * Tells NodeLink which song comes next (for the crossfade), or clears it.
 * Safe to call any time and as often as you like: one send at a time per
 * guild, and nothing is sent when NodeLink already has the right one. Never
 * rejects. Call it after anything that changes what plays next — queue
 * add / remove / move / shuffle / clear, loop changes. player.ts also calls it
 * on every TrackStartEvent and player update (~2 s), so a missed call only
 * delays the preload a little.
 */
export function syncNextTrack(guildId: string): Promise<void> {
  const running = syncing.get(guildId);
  if (running) {
    resync.add(guildId); // the running loop sends once more with the newest queue
    return running;
  }
  const run = (async () => {
    try {
      do await sendPreload(guildId); while (resync.delete(guildId));
    } catch (err) {
      console.warn(`[TRANSITIONS] guild=${guildId} preload sync failed: ${errMsg(err)}`);
    } finally {
      syncing.delete(guildId);
    }
  })();
  syncing.set(guildId, run);
  return run;
}

// ── Skip ────────────────────────────────────────────────────

const SKIP_MIN_LEFT_MS = 1500;   // less than crossfade + this left: a plain stop is quicker
const SKIP_BACKSTOP_MS = 4000;   // after the crossfade should be over, stop the plain way

/**
 * A skip that blends into the next song instead of cutting. NodeLink plans
 * its crossfade from the song's end time, so the end moves to "now +
 * crossfade" (NodeLink re-seeks to where the song already is, no jump) and
 * the normal crossfade + 'crossfading' end event follow. Only when NodeLink
 * already holds the song that should come next; otherwise (paused, loop one
 * song, live, queue just changed, almost over) false, and the caller stops
 * the plain way. If NodeLink doesn't switch in time, `stopPlain` runs.
 */
export async function skipWithCrossfade(guildId: string, state: GuildState, stopPlain: () => Promise<void>): Promise<boolean> {
  const { player, current } = state;
  const t = getTransitions(guildId);
  if (!player || !current || !t.enabled || t.crossfadeS <= 0 || state.paused || state.loopCurrent || current.info.isStream) return false;
  const next = upNext(state);
  const known = preloads.get(guildId);
  if (!next || next.info.isStream || !known || known.player !== player || known.encoded !== next.encoded) return false;
  const live = await player.node.rest.getPlayer(guildId).catch(() => null) as (Awaited<ReturnType<Player['node']['rest']['getPlayer']>> & { state?: { position?: number } }) | null;
  const position = live?.state?.position;
  const fadeMs = t.crossfadeS * 1000;
  if (typeof position !== 'number' || live?.track?.encoded !== current.encoded) return false;
  if (current.info.length - position < fadeMs + SKIP_MIN_LEFT_MS) return false;
  try {
    await patch(player, guildId, { endTime: Math.round(position + fadeMs) });
  } catch (err) {
    console.warn(`[TRANSITIONS] guild=${guildId} crossfade skip refused, stopping instead: ${errMsg(err)}`);
    return false;
  }
  console.debug(`[TRANSITIONS] guild=${guildId} skip: "${current.info.title}" blends into "${next.info.title}" over ${t.crossfadeS}s`);
  const seq = state.trackSeq;
  setTimeout(() => {
    if (state.player !== player || state.trackSeq !== seq || state.current !== current) return; // it switched
    console.warn(`[TRANSITIONS] guild=${guildId} crossfade skip didn't switch, stopping instead`);
    stopPlain().catch(err => console.warn(`[TRANSITIONS] guild=${guildId} backstop stop failed: ${errMsg(err)}`));
  }, fadeMs + SKIP_BACKSTOP_MS).unref?.();
  return true;
}
