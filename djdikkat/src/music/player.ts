/************************************************************
 * DJ DIKKAT - Music Bot
 * Player plug
 * Playback engine and NodeLink control
 * Author: Yanoee
 ************************************************************/
import { Constants } from 'shoukaku';
import type { LavalinkPlayer, Node, Player, Track, TrackEndEvent, TrackExceptionEvent, TrackStuckEvent, WebSocketClosedEvent } from 'shoukaku';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { Client, Guild, User, VoiceBasedChannel } from 'discord.js';
import { getState, peekState, clearInactivity, armInactivity, clearState, getActiveGuildIds } from './state.ts';
import type { GuildState } from './state.ts';
import { upsertController, removeController, repostController, deleteMessage } from '../ui/player-card.ts';
import { recordHistory, getStatsMessage, clearStatsMessage, getHistoryPage } from '../services/memory.ts';
import { recordPlay } from '../services/stats.ts';
import { UserError, AppError, logError, errMsg } from '../lib/errors.ts';
import type { LastPlayed, QueueTrack } from '../lib/types.ts';
import { guildLocaleVia } from '../services/locale.ts';
import { voiceDenial } from '../services/access.ts';
import { tracksOf } from './search.ts';
import { originalAudioTrackId } from './audio-track.ts';
import { filterSet } from './filters.ts';
import type { FilterName } from './filters.ts';
import { AUTOPLAY_BATCH, avoidFor, noteRejected, pickSeeds, pickSimilar, playedKeys } from './autoplay.ts';
import { getFeatures, setAutoplayFeature } from '../services/features.ts';
import { applyTransitions, syncNextTrack, forgetPreload, consumePreload, upNext, songStarting, songStarted, skipWithCrossfade } from './transitions.ts';
import { onSongStart, cancelRadio, resetRadio, radioTick, radioResumed } from './radio.ts';
import { t } from '../i18n/index.ts';

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

function buildVoiceStatusText(state: GuildState, guildId: string): string {
  const title = state.current?.info.title;
  if (!title) return '';
  return state.paused ? `⏸️ ${title}` : t(guildLocaleVia(state.client, guildId), 'voice.status_playing', { title });
}

// Shoukaku sets node.state to CONNECTED on NodeLink's "ready" op and
// drops it on every socket close, so it is the single source of truth.
export function pickNode(client: Client): Node | null {
  return [...client.shoukaku.nodes.values()].find(n => n.state === Constants.State.CONNECTED) ?? null;
}

const RESOLVE_CONCURRENCY = 5;

/** Resolves saved links to tracks (playlists, History), a few at a time; links that no longer load are skipped. */
export async function resolveLinks(client: Client, uris: string[]): Promise<Track[]> {
  const node = pickNode(client);
  if (!node) throw new UserError('common.music_server_down');
  const out: Track[] = [];
  for (let i = 0; i < uris.length; i += RESOLVE_CONCURRENCY) {
    const batch = await Promise.all(uris.slice(i, i + RESOLVE_CONCURRENCY)
      .map(uri => node.rest.resolve(uri).then(tracksOf, () => [])));
    for (const tracks of batch) if (tracks[0]) out.push(tracks[0]);
  }
  return out;
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
    logError(new AppError('NODELINK_UNAVAILABLE', 'NodeLink node not ready after wait', { nodes }));
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
  try {
    return await joinVoiceChannelLogged(client, guildId, channelId, shardId);
  } catch (err) {
    if (!errMsg(err).includes('existing connection')) throw err;
    softReleaseConnection(client, guildId);
    return joinVoiceChannelLogged(client, guildId, channelId, shardId);
  }
}

/**
 * On a failed join, Shoukaku drops its Connection without telling Discord we
 * left — Discord then skips VOICE_SERVER_UPDATE on the next try and that one
 * times out too. Leave properly, and log what Discord did/didn't send so a
 * VOICE_JOIN_FAILED line says why.
 */
async function joinVoiceChannelLogged(client: Client, guildId: string, channelId: string, shardId: number): Promise<Player> {
  const pending = client.shoukaku.joinVoiceChannel({ guildId, channelId, shardId, deaf: true });
  const conn = client.shoukaku.connections.get(guildId); // set synchronously by joinVoiceChannel
  try {
    return await pending;
  } catch (err) {
    if (errMsg(err).includes('existing connection')) throw err;
    conn?.disconnect();
    const guild = client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(channelId) as VoiceBasedChannel | undefined;
    const me = guild?.members.me;
    throw new AppError('VOICE_JOIN_FAILED', errMsg(err), {
      guildId, channelId,
      gotSession: Boolean(conn?.sessionId), gotServer: Boolean(conn?.serverUpdate), region: conn?.region ?? null,
      rtcRegion: channel?.rtcRegion ?? 'auto', inChannel: channel?.members.size ?? null, userLimit: channel?.userLimit ?? null,
      missing: me && channel ? channel.permissionsFor(me).missing([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]) : null,
      botVoice: me?.voice.channelId ?? null, shardPing: client.ws.ping,
      nodes: [...client.shoukaku.nodes.values()].map(n => `${n.name}:${n.state}`)
    }, err);
  }
}

/** Why the bot can't join/speak in this channel, judged from Discord permissions; null = fine. */
function joinBlocker(guild: Guild, channelId: string): 'voice.no_perms' | 'voice.channel_full' | null {
  const channel = guild.channels.cache.get(channelId) as VoiceBasedChannel | undefined;
  const me = guild.members.me;
  if (!channel || !me) return null; // not cached — let the join itself decide
  const perms = channel.permissionsFor(me);
  if (!perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) return 'voice.no_perms';
  if (channel.type === ChannelType.GuildVoice && !perms.has(PermissionFlagsBits.Speak)) return 'voice.no_perms';
  if (channel.full && !perms.has(PermissionFlagsBits.MoveMembers)) return 'voice.channel_full';
  return null;
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
    logError(new AppError('RECOVERY_FAILED', 'Recovery attempt crashed unexpectedly', { guildId }, err)));
}

/** Unhooks our handlers from whichever player they're on. */
function detachPlayerListeners(state: GuildState): void {
  state.unlistenPlayer?.();
  state.unlistenPlayer = null;
  state.listenedPlayer = null;
}

/**
 * Hooks the end/closed/exception/stuck handlers onto a guild's player (once
 * per player; a different player first loses the old player's handlers).
 * closed    = Discord voice websocket dropped (node crash, session invalidated, etc.)
 * exception = track failed to load/play
 */
function attachPlayerListeners(guildId: string, state: GuildState, player: Player): void {
  if (state.listenedPlayer === player) return;
  detachPlayerListeners(state);

  const onEnd = async (endEvent: TrackEndEvent) => {
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
    // CROSSFADING / GAPLESS = NodeLink already switched to the song we
    // preloaded (see followAutoAdvance); if that isn't the song we expect any
    // more, it's handled below like a finished song and the right one goes on.
    const autoAdvanced = reason === 'CROSSFADING' || reason === 'GAPLESS';
    if (autoAdvanced && previous && await followAutoAdvance(guildId, state, previous)) return;
    const canLoop = reason === '' || reason === 'FINISHED' || autoAdvanced;
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
    // An auto-advance we didn't follow left NodeLink playing a song we no
    // longer want (e.g. the queue was cleared under the preload). A new song
    // replaced it above; with nothing to play, stop it, or it plays on while
    // the bot shows idle. Its 'stopped' end event isn't for our (null) current
    // and is ignored above.
    if (autoAdvanced && !state.current && state.player && !state.disconnecting && peekState(guildId) === state) {
      await state.player.stopTrack().catch(() => {});
    }
  };

  const onClosed = async (closeEvent: WebSocketClosedEvent) => {
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

  const onException = (exceptionEvent: TrackExceptionEvent) => {
    logError(new AppError('TRACK_EXCEPTION', 'Track failed to load/play', { guildId, exception: exceptionEvent.exception }));
    // The follow-up end event (loadFailed) advances the queue.
    if (!state.disconnecting && state.player) scheduleFailureFallback(guildId, state);
  };

  const onStuck = async (stuckEvent: TrackStuckEvent) => {
    logError(new AppError('TRACK_STUCK', 'Track playback stuck', {
      guildId, thresholdMs: stuckEvent.thresholdMs, track: state.current?.info.title ?? null
    }));
    if (state.disconnecting || !state.player) return;
    scheduleFailureFallback(guildId, state);
    // The resulting 'stopped' end event advances the queue.
    await state.player.stopTrack().catch(() => {});
  };

  // Every player update (~2 s): make sure NodeLink holds the right next song.
  // Commands and the panel that change the queue call syncNextTrack too; this
  // catches any that don't. Nothing is sent when it already matches.
  const onUpdate = () => {
    if (!state.disconnecting && state.current) {
      autoplayEarly(guildId, state);
      void syncNextTrack(guildId);
      radioTick(guildId, upNext(state)); // renders the next song's host line ahead
    }
  };
  // A song's stream is up (our playTrack, or NodeLink's own switch): the
  // earliest moment NodeLink can take a preload it will crossfade into.
  const onStart = () => {
    if (!state.disconnecting) void songStarted(guildId);
  };

  player.on('end', onEnd);
  player.on('closed', onClosed);
  player.on('exception', onException);
  player.on('stuck', onStuck);
  player.on('update', onUpdate);
  player.on('start', onStart);
  state.listenedPlayer = player;
  state.unlistenPlayer = () => {
    player.off('end', onEnd);
    player.off('closed', onClosed);
    player.off('exception', onException);
    player.off('stuck', onStuck);
    player.off('update', onUpdate);
    player.off('start', onStart);
  };
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
  forgetPreload(guildId);
  state.player = null;
  state.current = null;
  state.paused = false;
  cancelRadio(guildId); // the player (and its mix layers) is gone; a rejoin gets normal volume

  // Release the connection gateway-side + locally, never over NodeLink REST.
  if (state.client) softReleaseConnection(state.client, guildId);

  if (!reconnect || !state.voiceChannelId || !state.client || !state.queue.length) {
    console.debug(`[RECOVERY] guild=${guildId} — no auto-reconnect (reconnect=${reconnect}, queue=${state.queue.length})`);
    await releaseFailedGuild(guildId, state);
    return;
  }

  // The final pass (no extra delay) is the last resort: NodeLink's "unassigned,
  // will be reassigned on next request" has been observed NOT to reliably
  // reassign — PATCH kept 404ing across all gentle attempts. A full teardown +
  // fresh player is the code path every normal /play uses, so it's worth one
  // real attempt before conceding.
  const attempts = RECONNECT_ATTEMPT_DELAYS_MS.length;
  for (let attempt = 1; attempt <= attempts + 1; attempt++) {
    const lastResort = attempt > attempts;
    if (!lastResort) await delay(RECONNECT_ATTEMPT_DELAYS_MS[attempt - 1]! + Math.random() * RECONNECT_JITTER_MS);
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
      if (lastResort) await client.shoukaku.leaveVoiceChannel(guildId).catch(() => {});
      const player = await joinVoiceChannelSafely(client, guildId, state.voiceChannelId!, client.guilds.cache.get(guildId)?.shardId ?? 0);
      state.player = player;
      attachPlayerListeners(guildId, state, player);
      await applyTransitions(guildId); // a fresh NodeLink player starts with its global config (all off)
      const how = lastResort ? 'via full recreate (last resort)' : `on attempt ${attempt}/${attempts}`;
      console.log(`[RECOVERY] Rejoined voice for guild ${guildId} ${how}, resuming queue`);
      await playNext(guildId);
      return;
    } catch (err) {
      console.warn(`[RECOVERY] ${lastResort ? 'Last-resort full recreate' : `Attempt ${attempt}/${attempts}`} failed for guild ${guildId}: ${errMsg(err)}`);
    }
  }

  logError(new AppError(
    'RECOVERY_FAILED',
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
    if (!memberChannelId) throw new UserError('voice.join_mine');
    if (state.voiceChannelId && state.voiceChannelId !== memberChannelId) {
      throw new UserError('voice.busy_elsewhere');
    }
    return state.player;
  }

  if (!memberChannelId) throw new UserError('voice.join_first');
  const denied = voiceDenial(member, memberChannelId);
  if (denied) throw new UserError(denied.key, denied.vars);
  const blocked = joinBlocker(guild, memberChannelId);
  if (blocked) throw new UserError(blocked, { channel: memberChannelId });
  state.voiceChannelId = memberChannelId;
  state.client = client;

  if (!await waitForNode(client)) {
    throw new UserError('common.music_server_down');
  }

  const player = await joinVoiceChannelSafely(client, guildId, memberChannelId, guild.shardId);
  state.player = player;
  console.debug(`[VOICE] guild=${guildId} joined channel=${memberChannelId}`);
  attachPlayerListeners(guildId, state, player);
  // Before the first song: NodeLink only builds a crossfade-capable stream
  // for songs started while crossfade is on.
  await applyTransitions(guildId);
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
  if (!state.queue.length && await autoplayFill(guildId, state)) return playNext(guildId);
  const next = state.queue.shift();
  if (!next) {
    state.current = null;
    void syncNextTrack(guildId); // nothing playing: nothing preloaded either
    await updateVoiceChannelStatus(state, '');
    armInactivity(state, () => disconnectGuild(guildId));
    await upsertController(guildId, state);
    return;
  }

  markStarted(guildId, state, next);
  if (!await playOrReset(guildId, state, next)) return;
  await updateVoiceChannelStatus(state, buildVoiceStatusText(state, guildId));
  await repostController(guildId, state);
}

/** A queued song is now playing: our state, play stats, history and autoplay seeds. */
function markStarted(guildId: string, state: GuildState, next: QueueTrack): void {
  state.current = next;
  state.paused = false;
  state.trackSeq += 1;
  state.startedAt = Date.now();
  state.autoplayHalted = false;
  state.played = [next, ...state.played].slice(0, AUTOPLAY_PLAYED);
  // Only songs a person asked for seed autoplay; a song coming round again (loop queue) moves to the front.
  if (next.requesterId && !next.autoplay) {
    const same = (tr: QueueTrack) => tr.encoded === next.encoded || (!!next.info.uri && tr.info.uri === next.info.uri);
    state.requested = [{ track: next, at: state.startedAt }, ...state.requested.filter(r => !same(r.track))].slice(0, AUTOPLAY_REQUESTED);
  }

  const who = { userId: next.requesterId, userTag: next.requesterTag };
  recordPlay(guildId, { title: next.info.title, uri: next.info.uri, ...who });
  recordHistory(guildId, { title: next.info.title, url: next.info.uri, artwork: next.info.artworkUrl, ...who });
  // Radio host: counts the song and plans its line (1.5 s in, once NodeLink plays it).
  onSongStart(guildId);
}

/**
 * Moves our state on from `previous` to the song upNext() names, by the same
 * rules as onEnd + playNext (loop track replays it, loop queue sends it to the
 * back) — without telling NodeLink anything. Only call when upNext(state) is set.
 */
function stepToNext(guildId: string, state: GuildState, previous: QueueTrack): void {
  clearInactivity(state);
  if (state.loopCurrent) {
    state.current = previous;
    state.paused = false;
    state.trackSeq += 1;
    return;
  }
  if (state.loopQueue) state.queue.push(previous);
  rememberLast(state, previous);
  markStarted(guildId, state, state.queue.shift()!);
}

/**
 * NodeLink switched to the song we preloaded by itself: its end event for
 * the old song says 'crossfading' (or 'gapless', when that song's stream
 * couldn't crossfade) and a TrackStartEvent for the new one follows. A
 * playTrack now would start that song over from 0 (NodeLink replaces even
 * the same track), so only our own state follows along. The sound effect is
 * NodeLink's player setting and carries over by itself. False = NodeLink
 * played something we no longer expect (the queue changed under the
 * preload); the caller then puts the right song on the normal way.
 */
async function followAutoAdvance(guildId: string, state: GuildState, previous: QueueTrack): Promise<boolean> {
  const preloaded = consumePreload(guildId, state.player);
  if (!preloaded || upNext(state)?.encoded !== preloaded) return false;
  stepToNext(guildId, state, previous);
  console.debug(`[NODE] guild=${guildId} NodeLink moved on to "${state.current?.info.title ?? '?'}" by itself`);
  // Shoukaku still holds the old song's last position until NodeLink's next
  // update (2 s); the card and panel drawn now would start from that. Ask.
  const player = state.player;
  const live = await player?.node.rest.getPlayer(guildId).catch(() => null) as RemotePlayer | null | undefined;
  if (player && state.player === player) player.position = typeof live?.state?.position === 'number' ? live.state.position : 0;
  void syncNextTrack(guildId); // and the one after that
  await updateVoiceChannelStatus(state, buildVoiceStatusText(state, guildId));
  // Same card handling as a normal start: a replay redraws, a new song reposts.
  if (state.loopCurrent) await upsertController(guildId, state);
  else await repostController(guildId, state);
  return true;
}

type PlayTrack = NonNullable<Parameters<Player['playTrack']>[0]['track']>;

// A failed playTrack means the player is dead (e.g. NodeLink "Player not found").
// Reset and release the guild so the next /play builds a fresh one, instead of
// the guild sitting on a phantom "now playing" track forever.
async function playOrReset(guildId: string, state: GuildState, track: Track, start: { position?: number; paused?: boolean } = {}): Promise<boolean> {
  if (!state.player) return false;
  try {
    // When YouTube's default audio is an AI auto-dub, ask NodeLink for the
    // original. audioTrackId isn't in shoukaku's types, but shoukaku sends the
    // track object as-is; NodeLink falls back to the default if the ID is gone.
    const audioTrackId = originalAudioTrackId(track.pluginInfo);
    const play: PlayTrack & { audioTrackId?: string } = audioTrackId ? { encoded: track.encoded, audioTrackId } : { encoded: track.encoded };
    // paused: false — NodeLink keeps the pause flag across tracks, so skipping
    // while paused would otherwise start the next track silent.
    // position: a restart picks the song up where it was (see restorePlayback).
    await state.player.playTrack({ track: play, paused: start.paused ?? false, ...(start.position ? { position: start.position } : {}) });
    // A new player (rejoin, recovery) doesn't have the session's sound effect yet.
    if (state.filter && state.filterPlayer !== state.player) {
      await state.player.setFilters(filterSet(state.filter)).catch(err => console.warn(`[FILTER] guild=${guildId} not re-applied: ${errMsg(err)}`));
      state.filterPlayer = state.player;
    }
    // A replace drops a crossfade preload but can keep a gapless one, so the
    // old answer is unknown now; the next song is sent again once this one's
    // stream is up (its TrackStartEvent, see onStart).
    songStarting(guildId);
    return true;
  } catch (err) {
    logError(new AppError('TRACK_EXCEPTION', 'playTrack failed — resetting player', { guildId }, err));
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
  if (!await playOrReset(guildId, state, state.current)) return true;
  await updateVoiceChannelStatus(state, buildVoiceStatusText(state, guildId));
  await upsertController(guildId, state);
  return true;
}

/** Toggle pause / resume. Returns the new paused flag, or null if nothing is playing. */
export async function togglePause(guildId: string): Promise<boolean | null> {
  const state = getState(guildId);
  if (!state.player || !state.current) return null;
  const paused = !state.paused;
  if (paused) cancelRadio(guildId); // a line never waits out a pause
  await state.player.setPaused(paused);
  state.paused = paused; // only once NodeLink accepted it
  await updateVoiceChannelStatus(state, buildVoiceStatusText(state, guildId));
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
  void syncNextTrack(guildId); // the loop decides what comes next
  if (state.client) await upsertController(guildId, state);
  return state.loopCurrent ? 'track' : state.loopQueue ? 'queue' : 'off';
}

/** Skip: stopping fires the end event, which advances the queue. */
export async function stopTrack(guildId: string, { jump = false } = {}): Promise<void> {
  const state = getState(guildId);
  if (!state.player || !state.current) return;
  // Every skip (button, /skip, panel skip and jump) comes through here, the
  // crossfade skip included (its backstop stops directly), so this counts once.
  // A jump to a queued song is "play that now", not "not like this one".
  if (!jump) noteQuickSkip(guildId, state, state.current);
  cancelRadio(guildId); // the host stops talking the moment someone skips
  // With transitions on, a skip blends into the next song like a song's own end.
  const plain = async () => { if (state.player && state.current) await state.player.stopTrack(); };
  if (await skipWithCrossfade(guildId, state, plain)) return;
  await plain();
}

/** Stop playback and clear the queue (stay connected). */
export async function stopPlayback(guildId: string): Promise<void> {
  const state = getState(guildId);
  state.queue = [];
  state.loopCurrent = false;
  state.loopQueue = false;
  state.autoplayHalted = true;   // Stop means stop, not "find something similar"
  cancelRadio(guildId);
  // The end event → playNext switches the card to idle.
  if (state.player && state.current) await state.player.stopTrack().catch(() => {});
}

/** Clear queued tracks (keep current). */
export async function clearQueue(guildId: string): Promise<void> {
  const state = getState(guildId);
  state.queue = [];
  void syncNextTrack(guildId);
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
  resetRadio(guildId); // cut the host, and the next session starts counting (and greeting) again

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
    forgetPreload(guildId);
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
    earlyTried.delete(guildId);
    // Drop the entry right here (no await in between) so a /play arriving
    // during the card cleanup below builds a fresh state instead of
    // attaching to this one just before it's deleted.
    clearState(guildId);
  }

  await removeController(guildId, savedClient);
}

// ── Sound effects ───────────────────────────────────────────

export const FILTER_COOLDOWN_MS = 3000;

/** Seconds until this server may change the effect again, or 0. */
export function filterCooldown(guildId: string): number {
  const left = getState(guildId).filterAt + FILTER_COOLDOWN_MS - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/** Puts one preset on (or clears it with null) for the rest of the session. */
export async function setFilter(guildId: string, name: FilterName | null): Promise<void> {
  const state = getState(guildId);
  if (!state.player) throw new UserError('common.nothing_playing');
  await state.player.setFilters(filterSet(name));
  state.filter = name;
  state.filterPlayer = state.player;
  state.filterAt = Date.now();
  if (state.client) await upsertController(guildId, state);
}

// ── Autoplay ────────────────────────────────────────────────

const AUTOPLAY_PLAYED = 5;       // songs started this session, kept so autoplay doesn't pick them again
const AUTOPLAY_REQUESTED = 10;   // people-requested songs kept as seed candidates (pickSeeds takes the newest few)
const AUTOPLAY_RECENT = 100;     // songs this server played lately are not picked again
const AUTOPLAY_QUICK_SKIP_MS = 30_000; // an autoplay song skipped sooner than this was a bad pick
// Autoplay keeps the queue topped up: once the last queued song has played a
// little, it already picks the next few, so the queue never looks empty while
// music goes on (and a crossfade has a song to fade into). Songs people add
// still go in front of these (enqueueRequested).
const AUTOPLAY_EARLY_MIN_PLAYED_MS = 10_000; // Shoukaku's position can still be the old song's right after a start
const earlyTried = new Map<string, number>(); // guildId -> trackSeq the early fill already ran for (once per song)

export const autoplayOn = (guildId: string) => getFeatures(guildId).autoplay.enabled;

/** A skip of an autoplay song right after it started tells autoplay to avoid songs like it. */
function noteQuickSkip(guildId: string, state: GuildState, track: QueueTrack): void {
  if (track.autoplay && state.startedAt && Date.now() - state.startedAt < AUTOPLAY_QUICK_SKIP_MS) noteRejected(guildId, track);
}

/**
 * Adds a few songs like what people requested lately, if autoplay is on,
 * someone is listening and Stop wasn't pressed. Runs when the queue is empty
 * after a song (current = null), or early near the end of the last queued song
 * (autoplayEarly, current set). Returns true when it added songs.
 */
async function autoplayFill(guildId: string, state: GuildState): Promise<boolean> {
  if (!autoplayOn(guildId) || state.autoplayHalted || !state.client || !humansInVoice(state, guildId)) return false;
  // Seeds only ever come from songs people queued (pickSeeds keeps to this listening session).
  const seeds = pickSeeds(state.requested, Date.now());
  if (!seeds.length) return false;
  const node = pickNode(state.client);
  if (!node) return false;
  const played = new Set<string>();
  // playedKeys also catches the same song from another source ("Artist - Song (Official Video)" vs "Song").
  for (const tr of state.played) for (const k of playedKeys(tr.info.title, tr.info.author, tr.info.uri)) played.add(k);
  for (const h of getHistoryPage(guildId, 1, AUTOPLAY_RECENT).entries) for (const k of playedKeys(h.title, '', h.url)) played.add(k);
  const current = state.current;
  const seq = state.trackSeq;
  try {
    const picks = await pickSimilar(id => node.rest.resolve(id), seeds, played, { count: AUTOPLAY_BATCH, avoid: avoidFor(guildId), guildId });
    // Whatever happened while it looked wins: songs queued, Stop, autoplay
    // switched off, the song moved on, a disconnect or a fresh session.
    if (!picks.length || state.queue.length || state.current !== current || state.trackSeq !== seq) return false;
    if (state.autoplayHalted || state.disconnecting || !state.player || peekState(guildId) !== state || !autoplayOn(guildId)) return false;
    state.queue.push(...picks.map((p): QueueTrack => ({
      ...p.track, requesterId: '', requesterTag: 'Autoplay', autoplay: true, autoplayFrom: p.seed.info.title.slice(0, 100)
    })));
    console.debug(`[AUTOPLAY] guild=${guildId} added ${picks.length}${current ? ' early' : ''}`);
    return true;
  } catch (err) {
    console.warn(`[AUTOPLAY] guild=${guildId} failed: ${errMsg(err)}`);
    return false;
  }
}

/**
 * Player update (~2 s): when the last queued song has played 10 s, fill
 * autoplay now instead of after it ends, so the queue shows what comes next
 * and a crossfade can fade into it. Once per song (a failed look isn't
 * repeated every 2 s; the normal fill at the end still tries). Loops never run
 * out, so they never need it.
 */
function autoplayEarly(guildId: string, state: GuildState): void {
  const { current, player } = state;
  if (!current || !player || current.info.isStream || state.queue.length || state.paused) return;
  if (state.loopCurrent || state.loopQueue || state.autoplayHalted || earlyTried.get(guildId) === state.trackSeq) return;
  if (!autoplayOn(guildId) || Date.now() - state.startedAt < AUTOPLAY_EARLY_MIN_PLAYED_MS) return;
  earlyTried.set(guildId, state.trackSeq);
  void autoplayFill(guildId, state).then(async added => {
    if (!added) return;
    await syncNextTrack(guildId); // preload the first pick now, the fade is close
    await upsertController(guildId, state);
  }).catch(err => logError(err, { guildId, during: 'autoplay early fill' }));
}

/** Turns autoplay on or off for a server; switched on while idle in voice, it starts right away. */
export async function setAutoplay(guildId: string, on: boolean): Promise<void> {
  setAutoplayFeature(guildId, on);
  const state = getState(guildId);
  if (on) state.autoplayHalted = false;
  if (on && state.player && !state.current && !state.queue.length) await playNext(guildId);
  else if (state.client) await upsertController(guildId, state);
}

// ── Restarts ────────────────────────────────────────────────
// A deploy or crash used to end the music everywhere. music/resume.ts saves
// this for every playing server and hands it back here after the restart.

/** What one server's playback needs to come back after a restart. */
export interface SavedPlayback {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string | null;
  current: QueueTrack | null;
  position: number;            // ms into `current`
  paused: boolean;
  loopCurrent: boolean;
  loopQueue: boolean;
  filter: FilterName | null;
  queue: QueueTrack[];
  played: QueueTrack[];        // autoplay: not picked again
  requested?: GuildState['requested']; // autoplay seeds; missing in saves from before smart autoplay
  autoplayHalted: boolean;
  lastPlayed: LastPlayed | null;
}

/** Every server with a player right now. `positions` = NodeLink's own clock where it answered. */
export function savePlayback(positions: Map<string, number>): SavedPlayback[] {
  const out: SavedPlayback[] = [];
  for (const guildId of getActiveGuildIds()) {
    const state = peekState(guildId);
    if (!state?.player || !state.voiceChannelId || state.disconnecting) continue;
    if (!state.current && !state.queue.length) continue; // idle in voice: nothing to bring back
    out.push({
      guildId,
      voiceChannelId: state.voiceChannelId,
      textChannelId: state.textChannelId,
      current: state.current,
      position: positions.get(guildId) ?? state.player.position ?? 0,
      paused: state.paused,
      loopCurrent: state.loopCurrent,
      loopQueue: state.loopQueue,
      filter: state.filter,
      queue: state.queue,
      played: state.played,
      requested: state.requested,
      autoplayHalted: state.autoplayHalted,
      lastPlayed: state.lastPlayed
    });
  }
  return out;
}

/** NodeLink's player as GET /players returns it (shoukaku's type leaves out `state`). */
export type RemotePlayer = LavalinkPlayer & { state?: { position?: number } };

/**
 * Brings one server's saved playback back after a restart. `remote` is the
 * player NodeLink kept alive when our session was resumed (null otherwise):
 * on the same song it's taken over as is, so the music never stopped;
 * otherwise the song starts again where it was. 'skipped' = nobody to play
 * for, or the channel is gone.
 */
export async function restorePlayback(client: Client, saved: SavedPlayback, savedAt: number, remote: RemotePlayer | null, resumed: boolean): Promise<'kept' | 'restarted' | 'skipped'> {
  const guild = client.guilds.cache.get(saved.guildId);
  const channel = guild?.channels.cache.get(saved.voiceChannelId);
  if (!guild || !channel?.isVoiceBased() || !channel.members.some(m => !m.user.bot)) return 'skipped';
  if (!saved.current && !saved.queue.length) return 'skipped';
  if (peekState(guild.id)?.player) return 'skipped'; // someone already started something

  const state = getState(guild.id);
  state.client = client;
  state.voiceChannelId = channel.id;
  state.textChannelId = saved.textChannelId;
  state.queue = [...saved.queue];
  state.loopCurrent = saved.loopCurrent;
  state.loopQueue = saved.loopQueue;
  state.filter = saved.filter;
  state.played = saved.played;
  // A save from before `requested` existed: its people-requested `played` songs are the best seeds there are;
  // a server deep in autoplay then has none, and its old seeds beat autoplay going quiet after the restart.
  const people = saved.played.filter(tr => tr.requesterId && !tr.autoplay);
  state.requested = Array.isArray(saved.requested) ? saved.requested
    : (people.length ? people : saved.played).map(track => ({ track, at: savedAt }));
  state.autoplayHalted = saved.autoplayHalted;
  state.lastPlayed = saved.lastPlayed;

  const player = await joinVoiceChannelSafely(client, guild.id, channel.id, guild.shardId);
  state.player = player;
  attachPlayerListeners(guild.id, state, player);
  clearInactivity(state);
  // The session goes on: no radio greeting. Before applyTransitions, which
  // also brings a kept player's volume back if a cut host line left it down.
  radioResumed(guild.id, saved.played.length);
  // Before any song starts (a kept player gets them again too; a restored one starts without).
  await applyTransitions(guild.id);

  const current = saved.current;
  // Where the song would be now if it kept playing while we were away.
  const awayMs = saved.paused ? 0 : Date.now() - savedAt;
  // Our session came back but NodeLink's player has no song, and by the clock
  // it would have finished: it ended while we were away. (An empty player
  // mid-song means NodeLink dropped it; that one is started again below.)
  const endedMeanwhile = resumed && !!remote && !remote.track && !!current && !current.info.isStream
    && saved.position + awayMs >= current.info.length - 15_000;
  // While we were away NodeLink may have crossfaded into the song we had
  // preloaded (its events then went nowhere): that's the saved next song.
  state.current = current;
  const movedOn = !!current && !!remote?.track && remote.track.encoded !== current.encoded
    && upNext(state)?.encoded === remote.track.encoded;
  state.current = null;
  if (current && remote && (remote.track?.encoded === current.encoded || movedOn)) {
    // NodeLink kept playing through the restart (sound effect included).
    state.current = current;
    if (movedOn) stepToNext(guild.id, state, current);
    else {
      state.trackSeq += 1;
      state.startedAt = Date.now() - (remote.state?.position ?? saved.position); // for the quick-skip check
    }
    state.paused = remote.paused;
    state.filterPlayer = player;
    void syncNextTrack(guild.id);
    await updateVoiceChannelStatus(state, buildVoiceStatusText(state, guild.id));
    await repostController(guild.id, state);
    verifyTakeover(guild.id, state, player, state.current!, remote.state?.position ?? (movedOn ? 0 : saved.position));
    return 'kept';
  }
  if (!current || endedMeanwhile) {
    if (current && state.loopCurrent) state.queue.unshift(current);
    else if (current && state.loopQueue) state.queue.push(current);
    rememberLast(state, current);
    await playNext(guild.id);
    return 'restarted';
  }
  state.current = current;
  state.paused = saved.paused;
  state.trackSeq += 1;
  const position = current.info.isStream ? 0 : Math.min(saved.position + (resumed && remote ? awayMs : 0), Math.max(0, current.info.length - 5000));
  state.startedAt = Date.now() - position;
  if (!await playOrReset(guild.id, state, current, { position, paused: saved.paused })) return 'skipped';
  await updateVoiceChannelStatus(state, buildVoiceStatusText(state, guild.id));
  await repostController(guild.id, state);
  return 'restarted';
}

const TAKEOVER_CHECK_MS = 3000;

/**
 * Taking a player over sends NodeLink fresh voice details, and NodeLink can
 * drop the song while it reconnects (seen after a crash: "UDP secretKey
 * missing"). Its end event comes before our listeners are on, so nothing would
 * notice. Look again a moment later; no song there = start it where it was.
 */
function verifyTakeover(guildId: string, state: GuildState, player: Player, track: QueueTrack, position: number): void {
  const seq = state.trackSeq;
  const at = Date.now();
  setTimeout(() => {
    void (async () => {
      if (peekState(guildId) !== state || state.player !== player || state.trackSeq !== seq || state.current !== track || state.disconnecting) return;
      const now = await player.node.rest.getPlayer(guildId).catch(() => null) as RemotePlayer | null;
      // Our end handler may have moved on while we asked (a crossfade event landing now).
      if (state.player !== player || state.trackSeq !== seq || state.current !== track || state.disconnecting) return;
      if (now?.track?.encoded === track.encoded) return;
      // NodeLink crossfaded into the next song before our listeners were on
      // (or while restorePlayback was still sending the transitions): its
      // events went nowhere. Follow it instead of replaying the old song's tail.
      if (now?.track && now.track.encoded === upNext(state)?.encoded) {
        forgetPreload(guildId); // its nextTrack is empty after its own switch
        stepToNext(guildId, state, track);
        state.paused = now.paused;
        console.warn(`[RESUME] guild=${guildId} NodeLink moved on to "${state.current?.info.title ?? '?'}" during the takeover, following it`);
        void syncNextTrack(guildId);
        await updateVoiceChannelStatus(state, buildVoiceStatusText(state, guildId));
        await repostController(guildId, state);
        return;
      }
      const elapsed = state.paused ? 0 : Date.now() - at;
      const from = track.info.isStream ? 0 : Math.min(position + elapsed, Math.max(0, track.info.length - 5000));
      console.warn(`[RESUME] guild=${guildId} NodeLink lost the song after the takeover, starting it again at ${Math.round(from / 1000)}s`);
      state.trackSeq += 1;
      if (await playOrReset(guildId, state, track, { position: from, paused: state.paused })) await upsertController(guildId, state);
    })().catch(err => logError(err, { guildId, during: 'resume takeover check' }));
  }, TAKEOVER_CHECK_MS);
}
