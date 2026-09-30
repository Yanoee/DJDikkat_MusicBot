/************************************************************
 * DJ DIKKAT - Music Bot
 * Player plug
 * Playback engine and NodeLink control
 * Build 5.0.0
 * Author: Yanoee
 ************************************************************/
const { Constants } = require('shoukaku');
const {
  getState,
  peekState,
  clearInactivity,
  armInactivity,
  clearState
} = require('./state');

const {
  upsertController,
  removeController,
  repostController,
  deleteMessage
} = require('./ui');
const { recordHistory, getStatsMessage, clearStatsMessage } = require('./memory');
const { recordPlay } = require('./stats');
const { UserError, AppError, ErrorCodes, logError } = require('./errors');

// ── Per-guild recovery-attempt tracking ─────────────────────────
// Lives independently of guild state (which gets replaced wholesale on
// disconnect) so a burst of failures is still visible on the Servers page
// even after the guild's own state object has been torn down and recreated.
const RECOVERY_WINDOW_MS = 60 * 60 * 1000;
const recoveryAttempts = new Map(); // guildId -> timestamps[]

function recordRecoveryAttempt(guildId) {
  const cutoff = Date.now() - RECOVERY_WINDOW_MS;
  const list = (recoveryAttempts.get(guildId) || []).filter(t => t > cutoff);
  list.push(Date.now());
  recoveryAttempts.set(guildId, list);
}

function getRecoveryStats() {
  const cutoff = Date.now() - RECOVERY_WINDOW_MS;
  const stats = {};
  for (const [guildId, timestamps] of recoveryAttempts) {
    const recent = timestamps.filter(t => t > cutoff);
    if (recent.length) stats[guildId] = recent.length;
    else recoveryAttempts.delete(guildId); // window passed — don't keep the key forever
  }
  return stats;
}

async function updateVoiceChannelStatus(state, text) {
  if (!state.voiceChannelId || !state.client) return;
  try {
    await state.client.rest.put(`/channels/${state.voiceChannelId}/voice-status`, {
      body: { status: text || '' }
    });
  } catch {}
}

function buildVoiceStatusText(state) {
  if (!state.current?.info?.title) return '';
  const title = state.current.info.title;
  return state.paused ? `⏸️ ${title}` : `🎵 Playing: ${title}`;
}

// Shoukaku sets node.state to CONNECTED (1) on NodeLink's "ready" op and
// drops it on every socket close, so it is the single source of truth.
function pickNode(client) {
  return [...client.shoukaku.nodes.values()].find(n => n.state === Constants.State.CONNECTED) || null;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Shoukaku passes NodeLink's raw TrackEndEvent: { track, reason: 'finished' | 'loadFailed' | ... }
function normalizeEndReason(endEvent) {
  const reason = endEvent?.reason;
  return typeof reason === 'string' ? reason.toUpperCase() : '';
}

function rememberLast(state, track) {
  if (track) state.lastPlayed = { title: track.info?.title, uri: track.info?.uri };
}

const RECONNECT_JITTER_MS = 4000;
const RECONNECT_NODE_WAIT_MS = 5000;
const TRACK_FAILURE_FALLBACK_MS = 3000;

async function waitForNode(client, timeoutMs = 2000, intervalMs = 200) {
  const start = Date.now();
  let node = pickNode(client);
  while (!node && Date.now() - start < timeoutMs) {
    await delay(intervalMs);
    node = pickNode(client);
  }
  if (!node) {
    const nodes = [...client.shoukaku.nodes.values()].map(n => ({
      name: n.name,
      state: n.state
    }));
    logError(new AppError(ErrorCodes.NODELINK_UNAVAILABLE, 'NodeLink node not ready after wait', { nodes }));
  } else {
    console.debug(`[NODE] picked node "${node.name}" after ${Date.now() - start}ms`);
  }
  return node;
}

/**
 * Releases a guild's voice connection WITHOUT ever touching NodeLink over
 * REST. Two separate things need to happen, and Shoukaku's leaveVoiceChannel()
 * bundles a third one we must avoid:
 *   1. Tell Discord's gateway we've actually left (Connection#disconnect()).
 *      Without this, Discord still thinks we're connected to that channel and
 *      won't send a fresh VOICE_SERVER_UPDATE on the next join — Shoukaku's
 *      Connection#connect() then just hangs waiting for an event that's never
 *      coming, until it times out ("voice connection is not established in
 *      15 seconds"). This bit NEVER touches NodeLink.
 *   2. Clear Shoukaku's own client-side `connections`/`players` Maps (public,
 *      mutable — just can't be reassigned wholesale) so the next
 *      joinVoiceChannel() doesn't throw "existing connection".
 * What we deliberately never do: call player.destroy() / leaveVoiceChannel()'s
 * REST DELETE. NodeLink transparently reassigns an existing-but-unassigned
 * player to a fresh worker after a crash ("will be reassigned on next
 * request"), but does NOT recreate one that's been explicitly deleted — every
 * PATCH after that delete 404s with "Player not found" forever.
 */
function softReleaseConnection(client, guildId) {
  const conn = client?.shoukaku?.connections?.get(guildId);
  if (conn?.disconnect) conn.disconnect();
  client?.shoukaku?.connections?.delete(guildId);
  client?.shoukaku?.players?.delete(guildId);
}

/**
 * Joins voice, trying a clean join first. Falls back to softReleaseConnection
 * + retry if Shoukaku's client-side state still blocks the join.
 */
async function joinVoiceChannelSafely(client, guildId, channelId, shardId) {
  const opts = { guildId, channelId, shardId: shardId ?? 0, deaf: true };
  try {
    return await client.shoukaku.joinVoiceChannel(opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('existing connection')) throw err;
    softReleaseConnection(client, guildId);
    return client.shoukaku.joinVoiceChannel(opts);
  }
}

/**
 * Track-failure fallback. An exception / stuck track normally gets a follow-up
 * TrackEndEvent (loadFailed / stopped) and onPlayerEnd advances the queue —
 * the failure handlers themselves never advance, or the queue burns through
 * two tracks per failure. NodeLink doesn't always send that end event though
 * (voice-level exceptions like "Voice reconnection circuit breaker triggered"
 * or "playerStateChange timed out"), so if nothing has moved past the failed
 * track a few seconds later, advance here instead.
 */
function scheduleFailureFallback(guildId, state) {
  const failed = state.current;
  const seq = state.trackSeq;
  if (!failed) return;
  setTimeout(() => {
    // Already advanced (end event, recovery, skip, disconnect…) — nothing to do.
    if (state.current !== failed || state.trackSeq !== seq) return;
    if (state.disconnecting || !state.player || peekState(guildId) !== state) return;
    console.warn(`[NODE] guild=${guildId} no end event after track failure — advancing queue`);
    rememberLast(state, failed);
    state.current = null;
    state.paused = false;
    playNext(guildId, state.client).catch(err => logError(err, { guildId, during: 'track-failure fallback' }));
  }, TRACK_FAILURE_FALLBACK_MS);
}

/**
 * Create (once) and attach the end/closed/exception listeners for a guild's player.
 * closed  = Discord voice websocket dropped (node crash, session invalidated, etc.)
 * exception = track failed to load/play
 */
function ensurePlayerHandlers(guildId, state) {
  if (!state.onPlayerEnd) {
    state.onPlayerEnd = async (endEvent) => {
      if (state.disconnecting) return;
      const previous = state.current;
      const reason = normalizeEndReason(endEvent);
      console.debug(`[NODE] end event guild=${guildId} reason=${reason || '(none)'} track="${previous?.info?.title || '?'}"`);
      // REPLACED = one of our own playTrack() calls swapped the track; whoever
      // made that call already owns the queue, so advancing here would skip.
      if (reason === 'REPLACED') return;
      if (reason === 'CLEANUP') {
        // NodeLink dropped the player on its side — same as losing it; the
        // recovery requeues the current track and rejoins (or releases the guild).
        handlePlayerFailure(guildId, { reconnect: true }).catch(err =>
          logError(new AppError(ErrorCodes.RECOVERY_FAILED, 'Recovery attempt crashed unexpectedly', { guildId }, err)));
        return;
      }
      // Stale end event for a track we've already moved past (e.g. the
      // failure fallback advanced before NodeLink's late loadFailed arrived).
      const endedEncoded = endEvent?.track?.encoded;
      if (endedEncoded && endedEncoded !== state.current?.encoded) return;
      const canLoop = reason === '' || reason === 'FINISHED';
      if (state.loopCurrent && previous && canLoop) {
        state.current = previous;
        state.paused = false;
        const replayed = await replayCurrent(guildId);
        if (replayed) return;
      }
      // loopQueue: finished or skipped tracks go back to the end of the rotation
      if (state.loopQueue && previous && (canLoop || reason === 'STOPPED')) {
        state.queue.push(previous);
      }
      rememberLast(state, previous);
      state.current = null;
      state.paused = false;
      await playNext(guildId, state.client);
    };
  }

  if (!state.onPlayerClosed) {
    state.onPlayerClosed = async (closeEvent) => {
      console.warn(`[VOICE CLOSED] guild=${guildId} code=${closeEvent?.code} reason=${closeEvent?.reason || 'unknown'}`);
      // 4014 = kicked, moved, channel deleted, or voice server changed. Discord
      // says don't blindly reconnect — look where the bot actually is now.
      if (closeEvent?.code === 4014) {
        await delay(1500); // let the gateway's VOICE_STATE_UPDATE land first
        if (state.disconnecting || !state.player || peekState(guildId) !== state) return;
        const botChannelId = state.client?.guilds.cache.get(guildId)?.members.me?.voice?.channelId;
        if (!botChannelId) {
          console.log(`[VOICE] guild=${guildId} — bot was disconnected by a user, not rejoining`);
          await disconnectGuild(guildId);
          return;
        }
        state.voiceChannelId = botChannelId; // moved → recover into the new channel
      }
      handlePlayerFailure(guildId, { reconnect: true }).catch(err =>
        logError(new AppError(ErrorCodes.RECOVERY_FAILED, 'Recovery attempt crashed unexpectedly', { guildId }, err)));
    };
  }

  if (!state.onPlayerException) {
    state.onPlayerException = (exceptionEvent) => {
      logError(new AppError(ErrorCodes.TRACK_EXCEPTION, 'Track failed to load/play', {
        guildId, exception: exceptionEvent?.exception || exceptionEvent
      }));
      if (state.disconnecting || !state.player) return;
      // The follow-up end event (loadFailed) advances the queue.
      scheduleFailureFallback(guildId, state);
    };
  }

  if (!state.onPlayerStuck) {
    state.onPlayerStuck = async (stuckEvent) => {
      logError(new AppError(ErrorCodes.TRACK_STUCK, 'Track playback stuck', {
        guildId, thresholdMs: stuckEvent?.thresholdMs ?? null, track: state.current?.info?.title || null
      }));
      if (state.disconnecting || !state.player) return;
      scheduleFailureFallback(guildId, state);
      // The resulting 'stopped' end event advances the queue.
      await state.player.stopTrack().catch(() => {});
    };
  }
}

// Unhooks our handlers from the current player and forgets them, so the
// next attachPlayerListeners() starts from a clean slate.
function detachPlayerListeners(state) {
  const player = state.player;
  if (player) {
    if (state.onPlayerEnd)       player.removeListener('end', state.onPlayerEnd);
    if (state.onPlayerClosed)    player.removeListener('closed', state.onPlayerClosed);
    if (state.onPlayerException) player.removeListener('exception', state.onPlayerException);
    if (state.onPlayerStuck)     player.removeListener('stuck', state.onPlayerStuck);
  }
  state.onPlayerEnd = null;
  state.onPlayerClosed = null;
  state.onPlayerException = null;
  state.onPlayerStuck = null;
  state.playerListenerTarget = null;
}

function attachPlayerListeners(guildId, state) {
  ensurePlayerHandlers(guildId, state);
  if (state.playerListenerTarget === state.player) return;
  state.player.on('end', state.onPlayerEnd);
  state.player.on('closed', state.onPlayerClosed);
  state.player.on('exception', state.onPlayerException);
  state.player.on('stuck', state.onPlayerStuck);
  state.playerListenerTarget = state.player;
}

/**
 * Called when a player is lost from under us (voice websocket closed, or the
 * NodeLink node itself dropped). Resets local state so the next command/UI
 * interaction works instead of hitting "Player not found", and optionally
 * attempts a single jittered auto-rejoin so playback resumes on its own.
 */
async function handlePlayerFailure(guildId, { reconnect = false } = {}) {
  const state = peekState(guildId);
  if (!state || state.disconnecting || !state.player) return;

  console.warn(`[VOICE LOST] guild=${guildId} — resetting player${reconnect ? ' and attempting recovery' : ''}`);
  recordRecoveryAttempt(guildId);

  clearInactivity(state);

  const previous = state.current;
  if (previous) state.queue.unshift(previous);
  rememberLast(state, previous);

  detachPlayerListeners(state);
  state.player = null;
  state.current = null;
  state.paused = false;

  // Release the connection Discord's-gateway-side + locally, but never touch
  // NodeLink over REST — see softReleaseConnection for why both halves matter.
  if (state.client) softReleaseConnection(state.client, guildId);

  if (!reconnect || !state.voiceChannelId || !state.client || !state.queue.length) {
    console.debug(`[RECOVERY] guild=${guildId} — no auto-reconnect (reconnect=${reconnect}, queue=${state.queue.length})`);
    await releaseFailedGuild(guildId, state);
    return;
  }

  // Base delays before each attempt (jitter added on top of each so a node-wide
  // crash doesn't send every guild's rejoin at once). NodeLink itself can take up
  // to ~30s to respawn a crashed playback worker under repeated-crash backoff, so
  // a single fast attempt gives up before NodeLink has even finished recovering.
  const RECONNECT_ATTEMPT_DELAYS_MS = [500, 4000, 12000];

  for (let attempt = 1; attempt <= RECONNECT_ATTEMPT_DELAYS_MS.length; attempt++) {
    await delay(RECONNECT_ATTEMPT_DELAYS_MS[attempt - 1] + Math.random() * RECONNECT_JITTER_MS);

    // Something else (manual /disconnect, the idle card's disconnect button, a
    // fresh /play) may have torn this guild's state down or already reconnected
    // it while we were waiting — bail out instead of touching a stale/orphaned
    // state object. peekState(guildId) !== state catches disconnectGuild() having
    // deleted and re-created this guild's state entry out from under us.
    if (state.player || state.disconnecting || !state.client || peekState(guildId) !== state) {
      console.debug(`[RECOVERY] guild=${guildId} — state changed underneath us, aborting recovery`);
      return;
    }

    const guild   = state.client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(state.voiceChannelId);
    const humans  = channel?.members?.filter(m => !m.user.bot);
    if (!channel || !humans || humans.size === 0) {
      console.debug(`[RECOVERY] guild=${guildId} — no humans left in channel, skipping rejoin`);
      await releaseFailedGuild(guildId, state);
      return;
    }

    try {
      const client = state.client;
      const node = await waitForNode(client, RECONNECT_NODE_WAIT_MS);
      if (state.player) return;
      if (!node) continue; // NodeLink still restarting — try again after the next delay

      state.player = await joinVoiceChannelSafely(client, guildId, state.voiceChannelId, guild.shardId);
      attachPlayerListeners(guildId, state);
      console.log(`[RECOVERY] Rejoined voice for guild ${guildId} on attempt ${attempt}/${RECONNECT_ATTEMPT_DELAYS_MS.length}, resuming queue`);
      await playNext(guildId, client);
      return;
    } catch (err) {
      console.warn(`[RECOVERY] Attempt ${attempt}/${RECONNECT_ATTEMPT_DELAYS_MS.length} failed for guild ${guildId}: ${err.message}`);
    }
  }

  // Last resort. NodeLink's own "unassigned, will be reassigned on next
  // request" mechanism has been observed in production to NOT reliably
  // reassign — PATCH kept 404ing with "Player not found" across all 3 gentle
  // attempts above even when we never sent it a delete. A full teardown +
  // fresh player creation is a different NodeLink code path — the one every
  // normal /play already uses successfully — so it's worth one real attempt
  // before conceding, even though it's the destructive path we otherwise avoid.
  if (state.player || state.disconnecting || !state.client || peekState(guildId) !== state) return;
  const lastGuild   = state.client.guilds.cache.get(guildId);
  const lastChannel = lastGuild?.channels.cache.get(state.voiceChannelId);
  const lastHumans  = lastChannel?.members?.filter(m => !m.user.bot);
  if (lastChannel && lastHumans && lastHumans.size > 0) {
    try {
      const client = state.client;
      const node = await waitForNode(client, RECONNECT_NODE_WAIT_MS);
      if (node && !state.player) {
        await client.shoukaku.leaveVoiceChannel(guildId).catch(() => {});
        state.player = await client.shoukaku.joinVoiceChannel({
          guildId, channelId: state.voiceChannelId, shardId: lastGuild.shardId ?? 0, deaf: true
        });
        attachPlayerListeners(guildId, state);
        console.log(`[RECOVERY] Rejoined guild ${guildId} via full recreate (last resort), resuming queue`);
        await playNext(guildId, client);
        return;
      }
    } catch (err) {
      console.warn(`[RECOVERY] Last-resort full recreate also failed for guild ${guildId}: ${err.message}`);
    }
  }

  logError(new AppError(
    ErrorCodes.RECOVERY_FAILED,
    `Gave up reconnecting after ${RECONNECT_ATTEMPT_DELAYS_MS.length} gentle attempts + one full recreate — likely a NodeLink-side bug in its worker-crash player reassignment (check journalctl -u nodelink around this time)`,
    { guildId }
  ));
  await releaseFailedGuild(guildId, state);
}

/**
 * Recovery ended without resuming playback. Fully disconnect the guild so it
 * isn't left soft-released with a queue, no inactivity timer and a stale
 * "Now Playing" card — unless someone else (a fresh /play, a manual
 * disconnect) has taken over this guild in the meantime.
 */
async function releaseFailedGuild(guildId, state) {
  if (peekState(guildId) !== state || state.player || state.disconnecting) return;
  await disconnectGuild(guildId);
}

/**
 * Ensure player exists and is connected
 */
async function ensurePlayer(interaction) {
  const guildId = interaction.guildId;
  const state = getState(guildId);
  if (state.player) {
    attachPlayerListeners(guildId, state);
    // Block users in a different voice channel
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const memberChannelId = member.voice?.channel?.id || null;
    if (state.voiceChannelId && memberChannelId && state.voiceChannelId !== memberChannelId) {
      throw new UserError('Bot is already active in another voice channel.');
    }
    if (!memberChannelId) {
      throw new UserError('Join the bot voice channel first.');
    }
    return state.player;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!member.voice.channel) {
    throw new UserError('Join a voice channel first.');
  }

  state.voiceChannelId = member.voice.channel.id;
  state.client = interaction.client;

  const node = await waitForNode(interaction.client);
  if (!node) {
    throw new AppError(ErrorCodes.NODELINK_UNAVAILABLE, 'NodeLink is not available right now — please try again in a moment.', { guildId });
  }

  state.player = await joinVoiceChannelSafely(interaction.client, guildId, state.voiceChannelId, interaction.guild.shardId);

  console.debug(`[VOICE] guild=${guildId} joined channel=${state.voiceChannelId}`);
  attachPlayerListeners(guildId, state);
  // If the command fails after this (no results, queue full, Spotify error),
  // don't sit in voice forever — playNext() clears this once a track starts.
  armInactivity(state, () => disconnectGuild(guildId));

  return state.player;
}

/**
 * Play next track in queue
 */
async function playNext(guildId, client) {
  const state = peekState(guildId);
  if (!state?.player) return;
  if (state.disconnecting) return;

  clearInactivity(state);
  const next = state.queue.shift();
  if (!next) {
    state.current = null;
    await updateVoiceChannelStatus(state, '');
    armInactivity(state, () => disconnectGuild(guildId));
    await upsertController(guildId, state);
    return;
  }

  state.current = next;
  state.paused = false;
  state.trackSeq += 1;

  await recordPlay(guildId, {
    title: next.info?.title,
    uri: next.info?.uri,
    userId: next.requesterId,
    userTag: next.requesterTag
  });
  await recordHistory(guildId, {
    title: next.info?.title,
    url: next.info?.uri,
    userId: next.requesterId,
    userTag: next.requesterTag
  });

  if (!state.player) return;
  if (!await playOrReset(guildId, state, next.encoded)) return;

  await updateVoiceChannelStatus(state, buildVoiceStatusText(state));
  await repostController(guildId, state);
}

// A failed playTrack means the player is dead (e.g. NodeLink "Player not found").
// Reset and release the guild so the next /play builds a fresh one, instead of
// the guild sitting on a phantom "now playing" track forever.
async function playOrReset(guildId, state, encoded) {
  try {
    // paused: false — NodeLink keeps the pause flag across tracks, so skipping
    // while paused would otherwise start the next track silent.
    await state.player.playTrack({ track: { encoded }, paused: false });
    return true;
  } catch (err) {
    logError(new AppError(ErrorCodes.TRACK_EXCEPTION, 'playTrack failed — resetting player', { guildId }, err));
    await handlePlayerFailure(guildId);
    return false;
  }
}

async function replayCurrent(guildId) {
  const state = getState(guildId);
  if (!state.player || !state.current) return false;
  if (state.disconnecting) return false;

  clearInactivity(state);
  state.paused = false;
  state.trackSeq += 1;

  // true either way: on failure the reset already took care of the guild.
  if (!await playOrReset(guildId, state, state.current.encoded)) return true;

  await updateVoiceChannelStatus(state, buildVoiceStatusText(state));
  await upsertController(guildId, state);
  return true;
}

/**
 * Toggle pause / resume
 */
async function togglePause(guildId) {
  const state = getState(guildId);
  if (!state.player || !state.current) return null;

  const paused = !state.paused;
  await state.player.setPaused(paused);
  state.paused = paused; // only once NodeLink accepted it
  await updateVoiceChannelStatus(state, buildVoiceStatusText(state));
  await upsertController(guildId, state);
  return state.paused;
}

// Cycles: Off → Track → Queue → Off
async function toggleLoopMode(guildId) {
  const state = getState(guildId);
  if (!state.loopCurrent && !state.loopQueue) {
    state.loopCurrent = true;
  } else if (state.loopCurrent) {
    state.loopCurrent = false;
    state.loopQueue = true;
  } else {
    state.loopQueue = false;
  }
  if (state.client) {
    await upsertController(guildId, state);
  }
  return state.loopCurrent ? 'track' : state.loopQueue ? 'queue' : 'off';
}

/**
 * Stop current track
 */
async function stopTrack(guildId) {
  const state = getState(guildId);
  if (!state.player || !state.current) return;
  await state.player.stopTrack();
}

/**
 * Stop playback and clear queue (stay connected)
 */
async function stopPlayback(guildId) {
  const state = getState(guildId);
  state.queue = [];
  state.loopCurrent = false;
  state.loopQueue = false;
  if (state.player && state.current) {
    await state.player.stopTrack().catch(() => {});
    // UI is handled by onPlayerEnd → playNext (which updates to idle then deletes card)
  }
}

/**
 * Clear queued tracks (keep current)
 */
async function clearQueue(guildId) {
  const state = getState(guildId);
  state.queue = [];
  if (state.client) {
    await upsertController(guildId, state);
  }
}

/**
 * Disconnect and cleanup
 */
async function disconnectGuild(guildId) {
  const state = getState(guildId);
  // The bot leaving fires VoiceStateUpdate → auto-leave → here again mid-teardown.
  if (state.disconnecting) return;

  clearInactivity(state);
  state.disconnecting = true;
  const savedClient = state.client;

  // finally: a throw mid-teardown must never leave disconnecting=true, which
  // would silently brick playback for this guild until the next restart.
  try {
    const { messageId, channelId } = getStatsMessage(guildId);
    if (messageId && channelId) {
      await deleteMessage(state.client, channelId, messageId);
    }
    if (messageId || channelId) {
      await clearStatsMessage(guildId);
    }

    if (state.player) {
      await updateVoiceChannelStatus(state, '');
      detachPlayerListeners(state);
      await state.player.stopTrack().catch(() => {});
    }

    // Shoukaku's Player has no disconnect(); leaveVoiceChannel() leaves voice
    // on Discord's side and destroys the NodeLink player.
    if (state.client?.shoukaku) {
      await state.client.shoukaku.leaveVoiceChannel(guildId).catch(() => {});
    }
  } catch (err) {
    logError(err, { guildId, during: 'disconnect' });
  } finally {
    detachPlayerListeners(state);
    state.player = null;
    state.queue = [];
    state.current = null;
    state.paused = false;
    state.loopCurrent = false;
    state.loopQueue = false;
    state.voiceChannelId = null;
    state.client = null;
    state.textChannelId = null;
    state.disconnecting = false;
    // Drop the entry right here (no await in between) so a /play arriving
    // during the card cleanup below builds a fresh state instead of
    // attaching to this one just before it's deleted.
    clearState(guildId);
  }

  await removeController(guildId, savedClient);
}

/**
 * NodeLink track loader
 */
function loadTracks(node, identifier) {
  return node.rest.resolve(identifier);
}

module.exports = {
  loadTracks,
  pickNode,
  ensurePlayer,
  playNext,
  togglePause,
  toggleLoopMode,
  stopTrack,
  stopPlayback,
  clearQueue,
  disconnectGuild,
  handlePlayerFailure,
  getRecoveryStats
};




