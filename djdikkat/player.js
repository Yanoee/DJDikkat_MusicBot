/************************************************************
 * DJ DIKKAT - Music Bot
 * Player plug
 * Playback engine and NodeLink control
 * Build 4.0.0
 * Author: Yanoee
 ************************************************************/
const {
  getState,
  clearInactivity,
  armInactivity,
  clearState
} = require('./state');

const {
  upsertController,
  removeController,
  repostController
} = require('./ui');
const { recordHistory, getStatsMessage, clearStatsMessage } = require('./memory');
const { recordPlay } = require('./stats');
const { UserError, AppError, ErrorCodes, logError } = require('./errors');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const DISCORD_API_BASE = 'https://discord.com/api/v10';

async function updateVoiceChannelStatus(state, text) {
  if (!state.voiceChannelId || !DISCORD_TOKEN) return;
  try {
    await fetch(`${DISCORD_API_BASE}/channels/${state.voiceChannelId}/voice-status`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bot ${DISCORD_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: text || '' })
    });
  } catch {}
}

function buildVoiceStatusText(state) {
  if (!state.current?.info?.title) return '';
  const title = state.current.info.title;
  return state.paused ? `⏸️ ${title}` : `🎵 Playing: ${title}`;
}

function isNodeConnected(node) {
  const state = node?.state;
  if (state === 2) return true;
  if (typeof state === 'string' && state.toUpperCase() === 'CONNECTED') return true;
  return false;
}

function pickNode(client) {
  const nodes = [...client.shoukaku.nodes.values()];
  if (client.nodelinkReadyNodes && client.nodelinkReadyNodes.size > 0) {
    const byReady = nodes.find(n => client.nodelinkReadyNodes.has(n.name));
    if (byReady) return byReady;
  }
  return nodes.find(isNodeConnected) || null;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeEndReason(endEvent) {
  const direct = endEvent?.reason;
  if (typeof direct === 'string' && direct) return direct.toUpperCase();
  const nested = endEvent?.data?.reason;
  if (typeof nested === 'string' && nested) return nested.toUpperCase();
  return '';
}

function isCleanupLikeEnd(endEvent) {
  return normalizeEndReason(endEvent) === 'CLEANUP';
}

const RECONNECT_JITTER_MS = 4000;
const RECONNECT_NODE_WAIT_MS = 5000;

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
      if (isCleanupLikeEnd(endEvent)) {
        state.current = null;
        state.paused = false;
        // Keep queue intact on node-side cleanup so tracks are not drained.
        if (previous) state.queue.unshift(previous);
        await upsertController(guildId, state);
        return;
      }
      const canLoop = reason === '' || reason === 'FINISHED';
      if (state.loopCurrent && previous && canLoop) {
        state.current = previous;
        state.paused = false;
        const replayed = await replayCurrent(guildId);
        if (replayed) return;
      }
      // loopQueue: push finished track back to end of queue
      if (state.loopQueue && previous && canLoop) {
        state.queue.push(previous);
      }
      if (previous) {
        state.lastPlayed = { title: previous.info?.title, uri: previous.info?.uri };
      }
      state.current = null;
      state.paused = false;
      await playNext(guildId, state.client);
    };
  }

  if (!state.onPlayerClosed) {
    state.onPlayerClosed = (closeEvent) => {
      console.warn(`[VOICE CLOSED] guild=${guildId} code=${closeEvent?.code} reason=${closeEvent?.reason || 'unknown'}`);
      handlePlayerFailure(guildId, { reconnect: true }).catch(err =>
        logError(new AppError(ErrorCodes.RECOVERY_FAILED, 'Recovery attempt crashed unexpectedly', { guildId }, err)));
    };
  }

  if (!state.onPlayerException) {
    state.onPlayerException = async (exceptionEvent) => {
      logError(new AppError(ErrorCodes.TRACK_EXCEPTION, 'Track failed to load/play', {
        guildId, exception: exceptionEvent?.exception || exceptionEvent
      }));
      if (state.disconnecting || !state.player) return;
      const previous = state.current;
      if (previous) state.lastPlayed = { title: previous.info?.title, uri: previous.info?.uri };
      state.current = null;
      state.paused = false;
      await playNext(guildId, state.client);
    };
  }

  if (!state.onPlayerStuck) {
    state.onPlayerStuck = async (stuckEvent) => {
      logError(new AppError(ErrorCodes.TRACK_STUCK, 'Track playback stuck', {
        guildId, thresholdMs: stuckEvent?.thresholdMs ?? null, track: state.current?.info?.title || null
      }));
      if (state.disconnecting || !state.player) return;
      const previous = state.current;
      if (previous) state.lastPlayed = { title: previous.info?.title, uri: previous.info?.uri };
      state.current = null;
      state.paused = false;
      await state.player.stopTrack().catch(() => {});
      await playNext(guildId, state.client);
    };
  }
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
  const state = getState(guildId);
  if (state.disconnecting || !state.player) return;

  console.warn(`[VOICE LOST] guild=${guildId} — resetting player${reconnect ? ' and attempting recovery' : ''}`);

  clearInactivity(state);

  const previous = state.current;
  if (previous) {
    state.queue.unshift(previous);
    state.lastPlayed = { title: previous.info?.title, uri: previous.info?.uri };
  }

  const deadPlayer = state.player;
  if (state.onPlayerEnd)       deadPlayer.removeListener('end', state.onPlayerEnd);
  if (state.onPlayerClosed)    deadPlayer.removeListener('closed', state.onPlayerClosed);
  if (state.onPlayerException) deadPlayer.removeListener('exception', state.onPlayerException);
  if (state.onPlayerStuck)     deadPlayer.removeListener('stuck', state.onPlayerStuck);

  state.player = null;
  state.playerListenerTarget = null;
  state.current = null;
  state.paused = false;

  // Release the connection Discord's-gateway-side + locally, but never touch
  // NodeLink over REST — see softReleaseConnection for why both halves matter.
  if (state.client) softReleaseConnection(state.client, guildId);

  await upsertController(guildId, state);

  if (!reconnect || !state.voiceChannelId || !state.client || !state.queue.length) {
    console.debug(`[RECOVERY] guild=${guildId} — no auto-reconnect (reconnect=${reconnect}, queue=${state.queue.length})`);
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
    // state object. getState(guildId) !== state catches disconnectGuild() having
    // deleted and re-created this guild's state entry out from under us.
    if (state.player || state.disconnecting || !state.client || getState(guildId) !== state) {
      console.debug(`[RECOVERY] guild=${guildId} — state changed underneath us, aborting recovery`);
      return;
    }

    const guild   = state.client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(state.voiceChannelId);
    const humans  = channel?.members?.filter(m => !m.user.bot);
    if (!channel || !humans || humans.size === 0) {
      console.debug(`[RECOVERY] guild=${guildId} — no humans left in channel, skipping rejoin`);
      return;
    }

    try {
      const client = state.client;
      const node = await waitForNode(client, RECONNECT_NODE_WAIT_MS);
      if (!node || state.player) return;

      state.player = await joinVoiceChannelSafely(client, guildId, state.voiceChannelId, guild.shardId);
      attachPlayerListeners(guildId, state);
      console.log(`[RECOVERY] Rejoined voice for guild ${guildId} on attempt ${attempt}/${RECONNECT_ATTEMPT_DELAYS_MS.length}, resuming queue`);
      await playNext(guildId, client);
      return;
    } catch (err) {
      console.warn(`[RECOVERY] Attempt ${attempt}/${RECONNECT_ATTEMPT_DELAYS_MS.length} failed for guild ${guildId}: ${err.message}`);
    }
  }

  logError(new AppError(
    ErrorCodes.RECOVERY_FAILED,
    `Gave up reconnecting after ${RECONNECT_ATTEMPT_DELAYS_MS.length} attempts — likely a NodeLink-side crash loop (check journalctl -u nodelink around this time)`,
    { guildId }
  ));
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

  return state.player;
}

/**
 * Play next track in queue
 */
async function playNext(guildId, client) {
  const state = getState(guildId);
  if (!state.player) return;
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
  await state.player.playTrack({
    track: { encoded: next.encoded }
  });

  await updateVoiceChannelStatus(state, buildVoiceStatusText(state));
  await repostController(guildId, state);
}

async function replayCurrent(guildId) {
  const state = getState(guildId);
  if (!state.player || !state.current) return false;
  if (state.disconnecting) return false;

  clearInactivity(state);
  state.paused = false;

  await state.player.playTrack({
    track: { encoded: state.current.encoded }
  });

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

  state.paused = !state.paused;
  await state.player.setPaused(state.paused);
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

  clearInactivity(state);
  state.disconnecting = true;

  const { messageId, channelId } = getStatsMessage(guildId);
  if (messageId && channelId && state.client) {
    const channel = await state.client.channels.fetch(channelId).catch(() => null);
    if (channel?.messages) {
      const msg = await channel.messages.fetch(messageId).catch(() => null);
      if (msg) await msg.delete().catch(() => {});
    }
  }
  if (messageId || channelId) {
    await clearStatsMessage(guildId);
  }

  try {
    if (state.player) {
      await updateVoiceChannelStatus(state, '');
      if (state.onPlayerEnd)       state.player.removeListener('end', state.onPlayerEnd);
      if (state.onPlayerClosed)    state.player.removeListener('closed', state.onPlayerClosed);
      if (state.onPlayerException) state.player.removeListener('exception', state.onPlayerException);
      if (state.onPlayerStuck)     state.player.removeListener('stuck', state.onPlayerStuck);
      await state.player.stopTrack().catch(() => {});
      await state.player.disconnect().catch(() => {});
    }
  } catch {}

  if (state.client?.shoukaku?.leaveVoiceChannel) {
    await state.client.shoukaku.leaveVoiceChannel(guildId).catch(() => {});
  }

  const savedClient = state.client;

  state.player = null;
  state.playerListenerTarget = null;
  state.onPlayerEnd = null;
  state.queue = [];
  state.current = null;
  state.paused = false;
  state.loopCurrent = false;
  state.loopQueue = false;
  state.voiceChannelId = null;
  state.client = null;
  state.textChannelId = null;
  state.disconnecting = false;

  await removeController(guildId, savedClient);
  clearState(guildId);
}

/**
 * NodeLink track loader
 */
async function loadTracks(node, identifier) {
  if (node?.rest?.resolve) {
    return node.rest.resolve(identifier);
  }
  const restKeys = node?.rest
    ? Object.getOwnPropertyNames(Object.getPrototypeOf(node.rest)).join(', ')
    : 'none';
  throw new Error(`Unsupported NodeLink REST client. rest proto: ${restKeys}`);
}

module.exports = {
  loadTracks,
  pickNode,
  ensurePlayer,
  playNext,
  replayCurrent,
  togglePause,
  toggleLoopMode,
  stopTrack,
  stopPlayback,
  clearQueue,
  disconnectGuild,
  handlePlayerFailure
};




