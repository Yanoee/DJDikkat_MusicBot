/************************************************************
 * DJ DIKKAT - Music Bot
 * Player plug
 * Playback engine and Lavalink control
 * Build 2.0.7
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
  removeController
} = require('./ui');
const { recordHistory, getStatsMessage, clearStatsMessage } = require('./memory');
const { recordPlay } = require('./stats');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const DISCORD_API_BASE = 'https://discord.com/api/v10';

async function updateVoiceChannelStatus(state, text) {
  if (!DISCORD_TOKEN) return;
  if (!state.voiceChannelId) return;

  const status = text == null ? '' : String(text);
  const body = {
    status: status.length > 500 ? `${status.slice(0, 497)}...` : status
  };

  await fetch(`${DISCORD_API_BASE}/channels/${state.voiceChannelId}/voice-status`, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  }).catch(() => {});
}

function buildVoiceStatusText(state) {
  if (!state.current?.info?.title) return '';
  const title = state.current.info.title;
  return state.paused ? `⏸️ ${title}` : `🎵 Playing: ${title}`;
}

/**
 * Pick first available Lavalink node
 * (same behavior as old code)
 */
function isNodeConnected(node) {
  const state = node?.state;
  if (state === 2) return true;
  if (typeof state === 'string' && state.toUpperCase() === 'CONNECTED') return true;
  return false;
}

function pickNode(client) {
  const nodes = [...client.shoukaku.nodes.values()];
  if (client.lavalinkReadyNodes && client.lavalinkReadyNodes.size > 0) {
    const byReady = nodes.find(n => client.lavalinkReadyNodes.has(n.name));
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
  const reason = normalizeEndReason(endEvent);
  if (reason === 'CLEANUP') return true;
  const type = typeof endEvent?.type === 'string' ? endEvent.type.toUpperCase() : '';
  return type === 'WEBSOCKETCLOSEDEVENT';
}

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
    console.error('Lavalink node not ready after wait.', nodes);
  }
  return node;
}

/**
 * Ensure player exists and is connected
 */
async function ensurePlayer(interaction) {
  const state = getState(interaction.guildId);
  const t0 = Date.now();
  if (state.player) {
    if (state.playerListenerTarget !== state.player && state.onPlayerEnd) {
      state.player.on('end', state.onPlayerEnd);
      state.playerListenerTarget = state.player;
    }
    // Block users in a different voice channel
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const memberChannelId = member.voice?.channel?.id || null;
    if (state.voiceChannelId && memberChannelId && state.voiceChannelId !== memberChannelId) {
      throw new Error('Bot is already active in another voice channel.');
    }
    if (!memberChannelId) {
      throw new Error('Join the bot voice channel first.');
    }
    return state.player;
  }

  const tFetchStart = Date.now();
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const tFetchMs = Date.now() - tFetchStart;
  if (!member.voice.channel) {
    throw new Error('Join a voice channel first.');
  }

  state.voiceChannelId = member.voice.channel.id;
  state.client = interaction.client;

  const tNodeStart = Date.now();
  const node = await waitForNode(interaction.client);
  const tNodeMs = Date.now() - tNodeStart;
  if (!node) throw new Error('Lavalink not ready.');

  const tJoinStart = Date.now();
  try {
    state.player = await interaction.client.shoukaku.joinVoiceChannel({
      guildId: interaction.guildId,
      channelId: state.voiceChannelId,
      shardId: interaction.guild.shardId ?? 0,
      deaf: true
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('existing connection') && interaction.client?.shoukaku?.leaveVoiceChannel) {
      await interaction.client.shoukaku.leaveVoiceChannel(interaction.guildId).catch(() => {});
      state.player = await interaction.client.shoukaku.joinVoiceChannel({
        guildId: interaction.guildId,
        channelId: state.voiceChannelId,
        shardId: interaction.guild.shardId ?? 0,
        deaf: true
      });
    } else {
      throw err;
    }
  }
  const tJoinMs = Date.now() - tJoinStart;

  if (!state.onPlayerEnd) {
    state.onPlayerEnd = async (endEvent) => {
      if (state.disconnecting) return;
      const previous = state.current;
      const reason = normalizeEndReason(endEvent);
      if (reason) {
        console.log(`Track ended in guild ${interaction.guildId} with reason: ${reason}`);
      }
      state.current = null;
      state.paused = false;
      if (isCleanupLikeEnd(endEvent)) {
        // Keep queue intact on websocket/voice cleanup so tracks are not drained.
        if (previous) state.queue.unshift(previous);
        await upsertController(interaction.guildId, state);
        return;
      }
      await playNext(interaction.guildId, interaction.client);
    };
  }

  state.player.on('end', state.onPlayerEnd);
  state.playerListenerTarget = state.player;

  const tTotal = Date.now() - t0;
  console.log(`Voice join timing: memberFetch=${tFetchMs}ms nodeWait=${tNodeMs}ms join=${tJoinMs}ms total=${tTotal}ms`);
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
    await upsertController(guildId, state);
    armInactivity(state, () => disconnectGuild(guildId));
    return;
  }

  state.current = next;
  state.paused = false;

  await recordPlay({
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

  await state.player.playTrack({
    track: { encoded: next.encoded }
  });

  await updateVoiceChannelStatus(state, buildVoiceStatusText(state));
  await upsertController(guildId, state);
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
  if (state.player && state.current) {
    await state.player.stopTrack().catch(() => {});
  }
  if (state.client) {
    await upsertController(guildId, state);
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
      if (state.onPlayerEnd) {
        state.player.removeListener('end', state.onPlayerEnd);
      }
      await state.player.stopTrack().catch(() => {});
      await state.player.disconnect().catch(() => {});
    }
  } catch {}

  if (state.client?.shoukaku?.leaveVoiceChannel) {
    await state.client.shoukaku.leaveVoiceChannel(guildId).catch(() => {});
  }

  state.player = null;
  state.playerListenerTarget = null;
  state.onPlayerEnd = null;
  state.queue = [];
  state.current = null;
  state.paused = false;
  state.voiceChannelId = null;
  state.client = null;
  state.textChannelId = null;
  state.disconnecting = false;

  await removeController(guildId);
  clearState(guildId);
}

/**
 * Lavalink track loader
 */
async function loadTracks(node, identifier) {
  if (node?.rest?.resolve) {
    return node.rest.resolve(identifier);
  }
  const restKeys = node?.rest
    ? Object.getOwnPropertyNames(Object.getPrototypeOf(node.rest)).join(', ')
    : 'none';
  throw new Error(`Unsupported Lavalink REST client. rest proto: ${restKeys}`);
}

module.exports = {
  loadTracks,
  pickNode,
  ensurePlayer,
  playNext,
  togglePause,
  stopTrack,
  stopPlayback,
  clearQueue,
  disconnectGuild
};




