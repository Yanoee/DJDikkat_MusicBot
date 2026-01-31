/************************************************************
 * DJ DIKKAT - Music Bot
 * State manager
 * Guild state and timers
 * Build 2.0.6
 * Author: Yanoee
 ************************************************************/
const guildState = new Map();

// timings (same as old code)
const COOLDOWN_MS = 5000;
const INACTIVITY_MS = 10 * 60 * 1000;

/**
 * Get or create guild state
 */
function getState(guildId) {
  if (!guildState.has(guildId)) {
    guildState.set(guildId, {
      player: null,
      queue: [],
      current: null,
      paused: false,

      // UI / VC
      voiceChannelId: null,
      client: null,
      textChannelId: null,

      // cooldown
      cooldownUntil: 0,

      // inactivity
      inactivityTimer: null,
      inactivityUntil: null,

      // lifecycle
      disconnecting: false,
      onPlayerEnd: null,
      playerListenerTarget: null,

      // per-user button cooldowns
      buttonCooldowns: new Map(),

      // idle UI refresh
      idleUiTimer: null
    });
  }
  return guildState.get(guildId);
}

/**
 * Cooldown check (PER GUILD — exactly like old code)
 */
function checkCooldown(guildId) {
  const state = getState(guildId);
  const now = Date.now();

  if (state.cooldownUntil > now) {
    return Math.ceil((state.cooldownUntil - now) / 1000);
  }

  state.cooldownUntil = now + COOLDOWN_MS;
  return 0;
}

/**
 * Clear inactivity timer
 */
function clearInactivity(state) {
  if (state.inactivityTimer) {
    clearTimeout(state.inactivityTimer);
    state.inactivityTimer = null;
    state.inactivityUntil = null;
  }
}

/**
 * Arm inactivity auto-disconnect
 */
function armInactivity(state, onTimeout) {
  clearInactivity(state);

  state.inactivityUntil = Date.now() + INACTIVITY_MS;
  state.inactivityTimer = setTimeout(() => {
    state.inactivityTimer = null;
    state.inactivityUntil = null;
    onTimeout();
  }, INACTIVITY_MS);
}

/**
 * Remaining inactivity time (for UI)
 */
function getInactivityRemaining(state) {
  if (!state.inactivityUntil) return null;
  const ms = state.inactivityUntil - Date.now();
  return ms > 0 ? ms : null;
}

/**
 * Count active voice connections
 */
function getActiveVoiceCount() {
  let count = 0;
  for (const state of guildState.values()) {
    if (state.player && state.voiceChannelId) count += 1;
  }
  return count;
}

/**
 * Clear idle UI refresh timer
 */
function clearIdleUiTimer(state) {
  if (state.idleUiTimer) {
    clearInterval(state.idleUiTimer);
    state.idleUiTimer = null;
  }
}

/**
 * Clear and remove guild state
 */
function clearState(guildId) {
  const state = guildState.get(guildId);
  if (!state) return;
  clearInactivity(state);
  clearIdleUiTimer(state);
  guildState.delete(guildId);
}

module.exports = {
  getState,
  checkCooldown,
  clearInactivity,
  armInactivity,
  getInactivityRemaining,
  getActiveVoiceCount,
  clearIdleUiTimer,
  clearState
};


