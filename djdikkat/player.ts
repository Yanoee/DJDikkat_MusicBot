/************************************************************
 * DJ DIKKAT - Music Bot
 * Player plug
 * Playback engine and NodeLink control
 * Build 5.2.0
 * Author: Yanoee
 ************************************************************/
import { Constants } from 'shoukaku';
import type { Node, Player, TrackEndEvent, WebSocketClosedEvent } from 'shoukaku';
import type { Client, Guild, User } from 'discord.js';
import { getState, peekState, clearInactivity, armInactivity, clearState } from './state.ts';
import type { GuildState } from './state.ts';
import { upsertController, removeController, repostController, deleteMessage } from './ui.ts';
import { recordHistory, getStatsMessage, clearStatsMessage } from './memory.ts';
import { recordPlay } from './stats.ts';
import { UserError, AppError, ErrorCodes, logError, errMsg } from './errors.ts';
import type { QueueTrack } from './types.ts';

/** What ensurePlayer needs from a slash-command or button interaction. */
interface GuildInteraction { guildId: string; guild: Guild; user: User; client: Client }

// ── Per-guild recovery-attempt tracking ─────────────────────────
// Lives independently of guild state (which gets replaced wholesale on
// disconnect) so a burst of failures is still visible on the Servers page
// even after the guild's own state object has been torn down and recreated.
const RECOVERY_WINDOW_MS = 60 * 60 * 1000;
const recoveryAttempts = new Map<string, number[]>(); // guildId -> timestamps

function recordRecoveryAttempt(guildId: string): void {
  const cutoff = Date.now() - RECOVERY_WINDOW_MS;
  const list = (recoveryAttempts.get(guildId) ?? []).filter(t => t > cutoff);
  list.push(Date.now());
  recoveryAttempts.set(guildId, list);
}

export function getRecoveryStats(): Record<string, number> {
  const cutoff = Date.now() - RECOVERY_WINDOW_MS;
  const stats: Record<string, number> = {};
  for (const [guildId, timestamps] of recoveryAttempts) {
    const recent = timestamps.filter(t => t > cutoff);
    if (recent.length) stats[guildId] = recent.length;
    else recoveryAttempts.delete(guildId); // window passed — don't keep the key forever
  }
  return stats;
}

async function updateVoiceChannelStatus(state: GuildState, text: string): Promise<void> {
  if (!state.voiceChannelId || !state.client) return;
  await state.client.rest.put(`/channels/${state.voiceChannelId}/voice-status`, { body: { status: text } }).catch(() => {});
}

function buildVoiceStatusText(state: GuildState): string {
  const title = state.current?.info.title;
  if (!title) return '';
  return state.paused ? `⏸️ ${title}` : `🎵 Playing: ${title}`;
}

// Shoukaku sets node.state to CONNECTED on NodeLink's "ready" op and
// drops it on every socket close, so it is the single source of truth.
export function pickNode(client: Client): Node | null {
  return [...client.shoukaku.nodes.values()].find(n => n.state === Constants.State.CONNECTED) ?? null;
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function rememberLast(state: GuildState, track: QueueTrack | null): void {
  if (track) state.lastPlayed = { title: track.info.title, uri: track.info.uri ?? null };
}

/** Humans in the guild's remembered voice channel (0 if it's gone). */
function humansInVoice(state: GuildState, guildId: string): number {
  const channel = state.voiceChannelId ? state.client?.guilds.cache.get(guildId)?.channels.cache.get(state.voiceChannelId) : undefined;
  return channel?.isVoiceBased() ? channel.members.filter(m => !m.user.bot).size : 0;
}

const RECONNECT_JITTER_MS = 4000;
const RECONNECT_NODE_WAIT_MS = 5000;
const TRACK_FAILURE_FALLBACK_MS = 3000;
// Base delays before each recovery attempt (jitter added on top so a node-wide
// crash doesn't send every guild's rejoin at once). NodeLink can take up to
// ~30s to respawn a crashed playback worker under repeated-crash backoff.
const RECONNECT_ATTEMPT_DELAYS_MS = [500, 4000, 12000];

async function waitForNode(client: Client, timeoutMs = 2000, intervalMs = 200): Promise<Node | null> {
  const start = Date.now();
  let node = pickNode(client);
  while (!node && Date.now() - start < timeoutMs) {
    await delay(intervalMs);
    node = pickNode(client);
  }
  if (!node) {
    const nodes = [...client.shoukaku.nodes.values()].map(n => ({ name: n.name, state: n.state }));
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
 *      Connection#connect() then just hangs until it times out ("voice
 *      connection is not established in 15 seconds").
 *   2. Clear Shoukaku's client-side `connections`/`players` Maps so the next
 *      joinVoiceChannel() doesn't throw "existing connection".
 * What we deliberately never do: player.destroy() / leaveVoiceChannel()'s
 * REST DELETE. NodeLink transparently reassigns an existing-but-unassigned
 * player to a fresh worker after a crash, but does NOT recreate one that's
 * been explicitly deleted — every PATCH after that 404s with "Player not found".
 */
function softReleaseConnection(client: Client, guildId: string): void {
  client.shoukaku.connections.get(guildId)?.disconnect();
  client.shoukaku.connections.delete(guildId);
  client.shoukaku.players.delete(guildId);
}

/** Joins voice; if Shoukaku's client-side state blocks it, soft-release and retry once. */
async function joinVoiceChannelSafely(client: Client, guildId: string, channelId: string, shardId: number): Promise<Player> {
  const opts = { guildId, channelId, shardId, deaf: true };
  try {
    return await client.shoukaku.joinVoiceChannel(opts);
  } catch (err) {
    if (!errMsg(err).includes('existing connection')) throw err;
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
function scheduleFailureFallback(guildId: string, state: GuildState): void {
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
    playNext(guildId).catch(err => logError(err, { guildId, during: 'track-failure fallback' }));
  }, TRACK_FAILURE_FALLBACK_MS);
}

function startRecovery(guildId: string): void {
  handlePlayerFailure(guildId, { reconnect: true }).catch(err =>
    logError(new AppError(ErrorCodes.RECOVERY_FAILED, 'Recovery attempt crashed unexpectedly', { guildId }, err)));
}

/**
 * Create (once) the end/closed/exception/stuck listeners for a guild's player.
 * closed    = Discord voice websocket dropped (node crash, session invalidated, etc.)
 * exception = track failed to load/play
 */
function ensurePlayerHandlers(guildId: string, state: GuildState): void {
  state.onPlayerEnd ??= async (endEvent: TrackEndEvent) => {
    if (state.disconnecting) return;
    const previous = state.current;
    const reason = String(endEvent.reason ?? '').toUpperCase();
    console.debug(`[NODE] end event guild=${guildId} reason=${reason || '(none)'} track="${previous?.info.title ?? '?'}"`);
    // REPLACED = one of our own playTrack() calls swapped the track; whoever
    // made that call already owns the queue, so advancing here would skip.
    if (reason === 'REPLACED') return;
    // CLEANUP = NodeLink dropped the player on its side — same as losing it.
    if (reason === 'CLEANUP') return startRecovery(guildId);
    // Stale end event for a track we've already moved past (e.g. the
    // failure fallback advanced before NodeLink's late loadFailed arrived).
    const endedEncoded = endEvent.track?.encoded;
    if (endedEncoded && endedEncoded !== state.current?.encoded) return;
    const canLoop = reason === '' || reason === 'FINISHED';
    if (state.loopCurrent && previous && canLoop) {
      state.current = previous;
      state.paused = false;
      if (await replayCurrent(guildId)) return;
    }
    // loopQueue: finished or skipped tracks go back to the end of the rotation
    if (state.loopQueue && previous && (canLoop || reason === 'STOPPED')) state.queue.push(previous);
    rememberLast(state, previous);
    state.current = null;
    state.paused = false;
    await playNext(guildId);
  };

  state.onPlayerClosed ??= async (closeEvent: WebSocketClosedEvent) => {
    console.warn(`[VOICE CLOSED] guild=${guildId} code=${closeEvent.code} reason=${closeEvent.reason || 'unknown'}`);
    // 4014 = kicked, moved, channel deleted, or voice server changed. Discord
    // says don't blindly reconnect — look where the bot actually is now.
    if (closeEvent.code === 4014) {
      await delay(1500); // let the gateway's VOICE_STATE_UPDATE land first
      if (state.disconnecting || !state.player || peekState(guildId) !== state) return;
      const botChannelId = state.client?.guilds.cache.get(guildId)?.members.me?.voice.channelId;
      if (!botChannelId) {
        console.log(`[VOICE] guild=${guildId} — bot was disconnected by a user, not rejoining`);
        await disconnectGuild(guildId);
        return;
      }
      state.voiceChannelId = botChannelId; // moved → recover into the new channel
    }
    startRecovery(guildId);
  };

  state.onPlayerException ??= (exceptionEvent) => {
    logError(new AppError(ErrorCodes.TRACK_EXCEPTION, 'Track failed to load/play', { guildId, exception: exceptionEvent.exception }));
    // The follow-up end event (loadFailed) advances the queue.
    if (!state.disconnecting && state.player) scheduleFailureFallback(guildId, state);
  };

  state.onPlayerStuck ??= async (stuckEvent) => {
    logError(new AppError(ErrorCodes.TRACK_STUCK, 'Track playback stuck', {
      guildId, thresholdMs: stuckEvent.thresholdMs, track: state.current?.info.title ?? null
    }));
    if (state.disconnecting || !state.player) return;
    scheduleFailureFallback(guildId, state);
    // The resulting 'stopped' end event advances the queue.
    await state.player.stopTrack().catch(() => {});
  };
}

// Unhooks our handlers from the current player and forgets them, so the
// next attachPlayerListeners() starts from a clean slate.
function detachPlayerListeners(state: GuildState): void {
  const player = state.player;
  if (player) {
    if (state.onPlayerEnd)       player.off('end', state.onPlayerEnd);
    if (state.onPlayerClosed)    player.off('closed', state.onPlayerClosed);
    if (state.onPlayerException) player.off('exception', state.onPlayerException);
    if (state.onPlayerStuck)     player.off('stuck', state.onPlayerStuck);
  }
  state.onPlayerEnd = null;
  state.onPlayerClosed = null;
  state.onPlayerException = null;
  state.onPlayerStuck = null;
  state.playerListenerTarget = null;
}

function attachPlayerListeners(guildId: string, state: GuildState, player: Player): void {
  ensurePlayerHandlers(guildId, state);
  if (state.playerListenerTarget === player) return;
  player.on('end', state.onPlayerEnd!);
  player.on('closed', state.onPlayerClosed!);
  player.on('exception', state.onPlayerException!);
  player.on('stuck', state.onPlayerStuck!);
  state.playerListenerTarget = player;
}

/** Aborted if something else (/disconnect, a fresh /play, …) took over the guild meanwhile. */
const recoveryStale = (guildId: string, state: GuildState) =>
  !!state.player || state.disconnecting || !state.client || peekState(guildId) !== state;

/**
 * Called when a player is lost from under us (voice websocket closed, or the
 * NodeLink node itself dropped). Resets local state so the next command/UI
 * interaction works instead of hitting "Player not found", and optionally
 * attempts jittered auto-rejoins so playback resumes on its own.
 */
export async function handlePlayerFailure(guildId: string, { reconnect = false } = {}): Promise<void> {
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

  // Release the connection gateway-side + locally, never over NodeLink REST.
  if (state.client) softReleaseConnection(state.client, guildId);

  if (!reconnect || !state.voiceChannelId || !state.client || !state.queue.length) {
    console.debug(`[RECOVERY] guild=${guildId} — no auto-reconnect (reconnect=${reconnect}, queue=${state.queue.length})`);
    await releaseFailedGuild(guildId, state);
    return;
  }

  const attempts = RECONNECT_ATTEMPT_DELAYS_MS.length;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await delay(RECONNECT_ATTEMPT_DELAYS_MS[attempt - 1]! + Math.random() * RECONNECT_JITTER_MS);
    if (recoveryStale(guildId, state)) {
      console.debug(`[RECOVERY] guild=${guildId} — state changed underneath us, aborting recovery`);
      return;
    }
    if (!humansInVoice(state, guildId)) {
      console.debug(`[RECOVERY] guild=${guildId} — no humans left in channel, skipping rejoin`);
      await releaseFailedGuild(guildId, state);
      return;
    }
    try {
      const client = state.client!;
      const node = await waitForNode(client, RECONNECT_NODE_WAIT_MS);
      if (state.player) return;
      if (!node) continue; // NodeLink still restarting — try again after the next delay
      const player = await joinVoiceChannelSafely(client, guildId, state.voiceChannelId!, client.guilds.cache.get(guildId)?.shardId ?? 0);
      state.player = player;
      attachPlayerListeners(guildId, state, player);
      console.log(`[RECOVERY] Rejoined voice for guild ${guildId} on attempt ${attempt}/${attempts}, resuming queue`);
      await playNext(guildId);
      return;
    } catch (err) {
      console.warn(`[RECOVERY] Attempt ${attempt}/${attempts} failed for guild ${guildId}: ${errMsg(err)}`);
    }
  }

  // Last resort. NodeLink's "unassigned, will be reassigned on next request"
  // has been observed NOT to reliably reassign — PATCH kept 404ing across all
  // gentle attempts. A full teardown + fresh player is the code path every
  // normal /play uses, so it's worth one real attempt before conceding.
  if (recoveryStale(guildId, state)) return;
  if (humansInVoice(state, guildId)) {
    try {
      const client = state.client!;
      const node = await waitForNode(client, RECONNECT_NODE_WAIT_MS);
      if (node && !state.player) {
        await client.shoukaku.leaveVoiceChannel(guildId).catch(() => {});
        const player = await client.shoukaku.joinVoiceChannel({
          guildId, channelId: state.voiceChannelId!, shardId: client.guilds.cache.get(guildId)?.shardId ?? 0, deaf: true
        });
        state.player = player;
        attachPlayerListeners(guildId, state, player);
        console.log(`[RECOVERY] Rejoined guild ${guildId} via full recreate (last resort), resuming queue`);
        await playNext(guildId);
        return;
      }
    } catch (err) {
      console.warn(`[RECOVERY] Last-resort full recreate also failed for guild ${guildId}: ${errMsg(err)}`);
    }
  }

  logError(new AppError(
    ErrorCodes.RECOVERY_FAILED,
    `Gave up reconnecting after ${attempts} gentle attempts + one full recreate — likely a NodeLink-side bug in its worker-crash player reassignment (check journalctl -u nodelink around this time)`,
    { guildId }
  ));
  await releaseFailedGuild(guildId, state);
}

/**
 * Recovery ended without resuming playback. Fully disconnect the guild so it
 * isn't left soft-released with a queue, no inactivity timer and a stale
 * card — unless someone else has taken over this guild in the meantime.
 */
async function releaseFailedGuild(guildId: string, state: GuildState): Promise<void> {
  if (peekState(guildId) !== state || state.player || state.disconnecting) return;
  await disconnectGuild(guildId);
}

/** Ensure the guild has a connected player in the caller's voice channel. */
export async function ensurePlayer(interaction: GuildInteraction): Promise<Player> {
  const { guildId, guild, client } = interaction;
  const state = getState(guildId);
  const member = await guild.members.fetch(interaction.user.id);
  const memberChannelId = member.voice.channelId;

  if (state.player) {
    attachPlayerListeners(guildId, state, state.player);
    if (!memberChannelId) throw new UserError('Join the bot voice channel first.');
    if (state.voiceChannelId && state.voiceChannelId !== memberChannelId) {
      throw new UserError('Bot is already active in another voice channel.');
    }
    return state.player;
  }

  if (!memberChannelId) throw new UserError('Join a voice channel first.');
  state.voiceChannelId = memberChannelId;
  state.client = client;

  if (!await waitForNode(client)) {
    throw new AppError(ErrorCodes.NODELINK_UNAVAILABLE, 'NodeLink is not available right now — please try again in a moment.', { guildId });
  }

  const player = await joinVoiceChannelSafely(client, guildId, memberChannelId, guild.shardId);
  state.player = player;
  console.debug(`[VOICE] guild=${guildId} joined channel=${memberChannelId}`);
  attachPlayerListeners(guildId, state, player);
  // If the command fails after this (no results, queue full, Spotify error),
  // don't sit in voice forever — playNext() clears this once a track starts.
  armInactivity(state, () => disconnectGuild(guildId));
  return player;
}

/** Play the next queued track, or go idle. */
export async function playNext(guildId: string): Promise<void> {
  const state = peekState(guildId);
  if (!state?.player || state.disconnecting) return;

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

  const who = { userId: next.requesterId, userTag: next.requesterTag };
  recordPlay(guildId, { title: next.info.title, uri: next.info.uri, ...who });
  recordHistory(guildId, { title: next.info.title, url: next.info.uri, ...who });

  if (!await playOrReset(guildId, state, next.encoded)) return;
  await updateVoiceChannelStatus(state, buildVoiceStatusText(state));
  await repostController(guildId, state);
}

// A failed playTrack means the player is dead (e.g. NodeLink "Player not found").
// Reset and release the guild so the next /play builds a fresh one, instead of
// the guild sitting on a phantom "now playing" track forever.
async function playOrReset(guildId: string, state: GuildState, encoded: string): Promise<boolean> {
  if (!state.player) return false;
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

async function replayCurrent(guildId: string): Promise<boolean> {
  const state = getState(guildId);
  if (!state.player || !state.current || state.disconnecting) return false;

  clearInactivity(state);
  state.paused = false;
  state.trackSeq += 1;

  // true either way: on failure the reset already took care of the guild.
  if (!await playOrReset(guildId, state, state.current.encoded)) return true;
  await updateVoiceChannelStatus(state, buildVoiceStatusText(state));
  await upsertController(guildId, state);
  return true;
}

/** Toggle pause / resume. Returns the new paused flag, or null if nothing is playing. */
export async function togglePause(guildId: string): Promise<boolean | null> {
  const state = getState(guildId);
  if (!state.player || !state.current) return null;
  const paused = !state.paused;
  await state.player.setPaused(paused);
  state.paused = paused; // only once NodeLink accepted it
  await updateVoiceChannelStatus(state, buildVoiceStatusText(state));
  await upsertController(guildId, state);
  return paused;
}

/** Cycles: Off → Track → Queue → Off */
export async function toggleLoopMode(guildId: string): Promise<'track' | 'queue' | 'off'> {
  const state = getState(guildId);
  if (state.loopCurrent) {
    state.loopCurrent = false;
    state.loopQueue = true;
  } else if (state.loopQueue) {
    state.loopQueue = false;
  } else {
    state.loopCurrent = true;
  }
  if (state.client) await upsertController(guildId, state);
  return state.loopCurrent ? 'track' : state.loopQueue ? 'queue' : 'off';
}

/** Skip: stopping fires the end event, which advances the queue. */
export async function stopTrack(guildId: string): Promise<void> {
  const state = getState(guildId);
  if (state.player && state.current) await state.player.stopTrack();
}

/** Stop playback and clear the queue (stay connected). */
export async function stopPlayback(guildId: string): Promise<void> {
  const state = getState(guildId);
  state.queue = [];
  state.loopCurrent = false;
  state.loopQueue = false;
  // The end event → playNext switches the card to idle.
  if (state.player && state.current) await state.player.stopTrack().catch(() => {});
}

/** Clear queued tracks (keep current). */
export async function clearQueue(guildId: string): Promise<void> {
  const state = getState(guildId);
  state.queue = [];
  if (state.client) await upsertController(guildId, state);
}

/** Leave voice and drop the guild's state. */
export async function disconnectGuild(guildId: string): Promise<void> {
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
    if (messageId && channelId) await deleteMessage(state.client, channelId, messageId);
    if (messageId || channelId) clearStatsMessage(guildId);

    if (state.player) {
      await updateVoiceChannelStatus(state, '');
      detachPlayerListeners(state);
      await state.player.stopTrack().catch(() => {});
    }
    // leaveVoiceChannel() leaves voice on Discord's side and destroys the NodeLink player.
    await state.client?.shoukaku.leaveVoiceChannel(guildId).catch(() => {});
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
