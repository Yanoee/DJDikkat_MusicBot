/************************************************************
 * DJ DIKKAT - Music Bot
 * Restart resume
 * Keeps the music going through deploys and restarts. Every
 * 30 s and on shutdown, each playing server's song, position
 * and queue are saved (bot_config "playback"). NodeLink keeps
 * our players for 60 s after we drop, and the next start
 * hands it the same session id, so songs keep playing while
 * the bot is away; restorePlayback() then takes each server
 * back over, or starts its song again where it was.
 * Author: Yanoee
 ************************************************************/
import { Node } from 'shoukaku';
import type { Client } from 'discord.js';
import { getConfig, saveConfigNow, setConfig } from '../services/config-store.ts';
import type { PlaybackSnapshot } from '../services/config-store.ts';
import { peekState } from './state.ts';
import { disconnectGuild, pickNode, restorePlayback, savePlayback } from './player.ts';
import type { RemotePlayer } from './player.ts';
import { errMsg } from '../lib/errors.ts';

export const RESUME_TIMEOUT_S = 60;        // NodeLink keeps our players this long after we drop
const SAVE_EVERY_MS = 30_000;              // crash cover; a normal shutdown saves fresh
const MAX_AGE_MS = 10 * 60 * 1000;         // an older save isn't played back (the bot was down a while)
const NODE_WAIT_MS = 20_000;
const POSITIONS_TIMEOUT_MS = 1500;

let pendingSession: string | null = null;
let sessionResumed = false;
let saveTimer: NodeJS.Timeout | null = null;
let lastSavedEmpty = false;

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Call after the DB is loaded and before login. Shoukaku resumes a NodeLink
 * session only within one process (a new Node starts without an id), so the
 * saved id is slipped into the first connect.
 */
export function installSessionResume(): void {
  pendingSession = getConfig('playback')?.nodeSessionId ?? null;
  const connect = Node.prototype.connect;
  Node.prototype.connect = function (this: Node) {
    if (pendingSession && !this.sessionId) this.sessionId = pendingSession;
    pendingSession = null;
    return connect.call(this);
  };
}

/** Shoukaku 'ready': did NodeLink take our old session back? */
export function onNodeReady(resumed: boolean): void {
  if (resumed) sessionResumed = true;
}

function snapshot(client: Client, reason: PlaybackSnapshot['reason'], positions = new Map<string, number>()): PlaybackSnapshot {
  const node = pickNode(client) ?? [...client.shoukaku.nodes.values()][0];
  return { savedAt: Date.now(), reason, nodeSessionId: node?.sessionId ?? null, guilds: savePlayback(positions) };
}

/** NodeLink's own position for every player (more exact than Shoukaku's last update). */
async function livePositions(client: Client): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const node = pickNode(client);
  if (!node) return out;
  const players = await Promise.race([node.rest.getPlayers().catch(() => []), delay(POSITIONS_TIMEOUT_MS).then(() => [])]) as RemotePlayer[];
  // An empty player reports 0; keep Shoukaku's last known position for those.
  for (const p of players) if (p.track && typeof p.state?.position === 'number') out.set(p.guildId, p.state.position);
  return out;
}

function saveNow(client: Client): void {
  const snap = snapshot(client, 'periodic');
  if (!snap.guilds.length && lastSavedEmpty) return; // nothing playing, already saved that
  lastSavedEmpty = !snap.guilds.length;
  setConfig('playback', snap);
}

function startSaving(client: Client): void {
  if (saveTimer) clearInterval(saveTimer);
  saveNow(client);
  saveTimer = setInterval(() => saveNow(client), SAVE_EVERY_MS);
}

/** On SIGTERM / SIGINT: save what's playing, for the next start. Players and voice stay up. */
export async function saveForRestart(client: Client): Promise<number> {
  if (saveTimer) clearInterval(saveTimer);
  saveTimer = null;
  const snap = snapshot(client, 'shutdown', await livePositions(client));
  await saveConfigNow('playback', snap);
  return snap.guilds.length;
}

/** Leaves voice in a server we didn't bring back (NodeLink's player and Discord's voice state). */
async function dropLeftover(client: Client, guildId: string, remote: boolean): Promise<void> {
  if (remote) await pickNode(client)?.rest.destroyPlayer(guildId).catch(() => {});
  const guild = client.guilds.cache.get(guildId);
  if (guild?.members.me?.voice.channelId) {
    guild.shard.send({ op: 4, d: { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false } });
  }
}

/** After login: bring back what was playing before the restart, then start the periodic save. */
export async function restoreAfterRestart(client: Client<true>): Promise<void> {
  const snap = getConfig('playback');
  const saved = snap && Date.now() - snap.savedAt < MAX_AGE_MS ? snap.guilds : [];
  const start = Date.now();
  let node = pickNode(client);
  while (!node && Date.now() - start < NODE_WAIT_MS) {
    await delay(250);
    node = pickNode(client);
  }

  const remote = new Map<string, RemotePlayer>();
  if (node && sessionResumed) {
    for (const p of await node.rest.getPlayers().catch(() => []) as RemotePlayer[]) remote.set(p.guildId, p);
  }

  const counts = { kept: 0, restarted: 0, skipped: 0 };
  if (node) {
    for (const entry of saved) {
      try {
        counts[await restorePlayback(client, entry, snap!.savedAt, remote.get(entry.guildId) ?? null, sessionResumed)]++;
      } catch (err) {
        counts.skipped++;
        console.warn(`[RESUME] guild=${entry.guildId} not brought back: ${errMsg(err)}`);
        await disconnectGuild(entry.guildId).catch(() => {});
      }
    }
  } else if (saved.length) {
    console.warn(`[RESUME] NodeLink not ready after ${NODE_WAIT_MS / 1000}s, ${saved.length} server(s) not brought back`);
  }

  // Anything still in voice or on NodeLink without a player of ours is left over from before.
  const leftovers = new Set([...remote.keys()]);
  for (const guild of client.guilds.cache.values()) if (guild.members.me?.voice.channelId) leftovers.add(guild.id);
  let dropped = 0;
  for (const guildId of leftovers) {
    if (peekState(guildId)?.player) continue;
    await dropLeftover(client, guildId, remote.has(guildId));
    dropped++;
  }

  if (saved.length || remote.size || dropped) {
    const age = snap ? Math.round((Date.now() - snap.savedAt) / 1000) : 0;
    console.log(`🔁 Restart resume: session ${sessionResumed ? 'resumed' : 'new'}, ${saved.length} saved (${snap?.reason ?? 'none'}, ${age}s old) → ${counts.kept} kept playing, ${counts.restarted} restarted, ${counts.skipped} skipped, ${dropped} left over`);
  }
  startSaving(client);
}
