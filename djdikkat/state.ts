/************************************************************
 * DJ DIKKAT - Music Bot
 * State manager
 * Guild state and timers
 * Build 5.3.0
 * Author: Yanoee
 ************************************************************/
import type { Client } from 'discord.js';
import type { Player } from 'shoukaku';
import type { LastPlayed, QueueTrack } from './types.ts';

export interface GuildState {
  player: Player | null;
  queue: QueueTrack[];
  current: QueueTrack | null;
  paused: boolean;
  loopCurrent: boolean;
  loopQueue: boolean;

  // UI / VC
  voiceChannelId: string | null;
  client: Client | null;
  textChannelId: string | null;

  cooldownUntil: number;

  inactivityTimer: NodeJS.Timeout | null;
  inactivityUntil: number | null;

  // lifecycle
  disconnecting: boolean;
  listenedPlayer: Player | null;          // player our end/closed/exception/stuck handlers are on
  unlistenPlayer: (() => void) | null;     // removes those handlers
  trackSeq: number; // bumped every time a track starts (failure fallback uses it)

  buttonCooldowns: Map<string, number>; // userId -> until
  idleUiTimer: NodeJS.Timeout | null;
  lastPlayed: LastPlayed | null; // for the idle card's "Play Again"
}

const guildState = new Map<string, GuildState>();

// Command cooldown is adjustable from the admin panel
let COOLDOWN_MS = 5000;
const INACTIVITY_MS = 5 * 60 * 1000;

/** An admin-panel cooldown value clamped to 0–60s, or `current` if it isn't a valid number. */
export function clampCooldownMs(ms: unknown, current: number): number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 60000) : current;
}

export function getCommandCooldownMs(): number { return COOLDOWN_MS; }
export function setCommandCooldownMs(ms: unknown): number {
  return COOLDOWN_MS = clampCooldownMs(ms, COOLDOWN_MS);
}

/** Get or create guild state */
export function getState(guildId: string): GuildState {
  let state = guildState.get(guildId);
  if (!state) {
    state = {
      player: null,
      queue: [],
      current: null,
      paused: false,
      loopCurrent: false,
      loopQueue: false,
      voiceChannelId: null,
      client: null,
      textChannelId: null,
      cooldownUntil: 0,
      inactivityTimer: null,
      inactivityUntil: null,
      disconnecting: false,
      listenedPlayer: null,
      unlistenPlayer: null,
      trackSeq: 0,
      buttonCooldowns: new Map(),
      idleUiTimer: null,
      lastPlayed: null
    };
    guildState.set(guildId, state);
  }
  return state;
}

/**
 * Existing guild state or undefined — for read-only callers that must not
 * create an entry (voice updates, admin polling, timers).
 */
export function peekState(guildId: string): GuildState | undefined {
  return guildState.get(guildId);
}

/** Per-guild command cooldown. Returns seconds left, or 0 (and starts a new window). */
export function checkCooldown(guildId: string): number {
  const state = getState(guildId);
  const now = Date.now();
  if (state.cooldownUntil > now) return Math.ceil((state.cooldownUntil - now) / 1000);
  state.cooldownUntil = now + COOLDOWN_MS;
  return 0;
}

export function clearInactivity(state: GuildState): void {
  if (state.inactivityTimer) clearTimeout(state.inactivityTimer);
  state.inactivityTimer = null;
  state.inactivityUntil = null;
}

/** Arm the idle auto-disconnect. */
export function armInactivity(state: GuildState, onTimeout: () => void): void {
  clearInactivity(state);
  state.inactivityUntil = Date.now() + INACTIVITY_MS;
  state.inactivityTimer = setTimeout(() => {
    state.inactivityTimer = null;
    state.inactivityUntil = null;
    onTimeout();
  }, INACTIVITY_MS);
}

/** Remaining idle time in ms (for the idle card), or null. */
export function getInactivityRemaining(state: GuildState): number | null {
  if (!state.inactivityUntil) return null;
  const ms = state.inactivityUntil - Date.now();
  return ms > 0 ? ms : null;
}

/** Guild IDs with a live player in a voice channel. */
export function getActiveGuildIds(): string[] {
  const ids: string[] = [];
  for (const [guildId, state] of guildState) {
    if (state.player && state.voiceChannelId) ids.push(guildId);
  }
  return ids;
}

export function getActiveVoiceCount(): number {
  return getActiveGuildIds().length;
}

export function clearIdleUiTimer(state: GuildState): void {
  if (state.idleUiTimer) clearInterval(state.idleUiTimer);
  state.idleUiTimer = null;
}

/** Clear timers and drop the guild's state. */
export function clearState(guildId: string): void {
  const state = guildState.get(guildId);
  if (!state) return;
  clearInactivity(state);
  clearIdleUiTimer(state);
  guildState.delete(guildId);
}
