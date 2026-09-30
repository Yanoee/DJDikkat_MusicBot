/************************************************************
 * DJ DIKKAT - Music Bot
 * Bot entrypoint
 * Client bootstrap and event wiring
 * Build 5.1.0
 * Author: Yanoee
 ************************************************************/
// ESM evaluates imports in order: .env first, then the logger's console patch,
// before any other module runs.
import './env.ts';
import { startHeartbeat, setLogLevel } from './logger.ts';

import { Client, GatewayIntentBits, Events, ActivityType } from 'discord.js';
import { Shoukaku, Connectors } from 'shoukaku';
import pkg from '../package.json' with { type: 'json' };

import { handleInteraction, deployCommands, setButtonCooldownMs } from './commands.ts';
import { peekState, getActiveVoiceCount, getActiveGuildIds, setCommandCooldownMs } from './state.ts';
import { disconnectGuild, handlePlayerFailure } from './player.ts';
import { deleteMessage } from './ui.ts';
import { sendAnnouncement, sendOwnerWelcome } from './announcement.ts';
import { startInternalServer, startupPresence } from './internal-server.ts';
import * as memory from './memory.ts';
import * as db from './db.ts';
import * as stats from './stats.ts';
import * as dmStore from './dm-store.ts';
import * as configStore from './config-store.ts';
import { setMaintenance } from './runtime-flags.ts';
import { errMsg } from './errors.ts';
import type {} from './types.ts'; // Client.shoukaku augmentation

const { DISCORD_TOKEN, NODELINK_HOST, NODELINK_PORT, NODELINK_PASSWORD, NODELINK_SECURE } = process.env;
if (!DISCORD_TOKEN || !NODELINK_HOST || !NODELINK_PORT || !NODELINK_PASSWORD) {
  const missing = Object.entries({ DISCORD_TOKEN, NODELINK_HOST, NODELINK_PORT, NODELINK_PASSWORD }).filter(([, v]) => !v).map(([k]) => k);
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const STATS_AUTO_DELETE_MS = 3 * 60 * 1000;

// ---------------- DISCORD CLIENT ----------------

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

// ---------------- NODELINK ----------------

const shoukaku = new Shoukaku(
  new Connectors.DiscordJS(client),
  [{ name: 'main', url: `${NODELINK_HOST}:${NODELINK_PORT}`, auth: NODELINK_PASSWORD, secure: NODELINK_SECURE === 'true' }],
  // Shoukaku's defaults (3 tries × 5s) can run out before NodeLink finishes a
  // cold boot if both restart together; the node then never retries.
  { reconnectTries: 10, reconnectInterval: 5 }
);
client.shoukaku = shoukaku;

shoukaku.on('error', (nodeName, error) => console.error(`[NODELINK ERROR] Node ${nodeName}`, error));
shoukaku.on('ready', nodeName => console.log(`✅ NodeLink node ready: ${nodeName}`));

// 'close' fires on every dropped NodeLink socket; Shoukaku then retries on its
// own and emits 'ready' again. Every player session on the node is dead too —
// sweep them so they self-heal instead of silently failing on the next command.
shoukaku.on('close', (nodeName, code, reason) => {
  console.warn(`⚠️ NodeLink node connection closed: ${nodeName} (${code}) ${reason || ''}`);
  const guildIds = getActiveGuildIds();
  if (guildIds.length) console.warn(`⚠️ Sweeping ${guildIds.length} active guild(s) for player recovery`);
  for (const guildId of guildIds) {
    handlePlayerFailure(guildId, { reconnect: true }).catch(err => console.error(`[NODE RECOVERY] guild ${guildId} failed:`, err));
  }
});

// 'disconnect' fires only once every reconnect try is used up — Shoukaku has
// removed the node for good. Exit so systemd (Restart=always) starts fresh.
shoukaku.on('disconnect', nodeName => {
  console.error(`❌ NodeLink node ${nodeName} gave up reconnecting — exiting so systemd restarts the bot`);
  process.exit(1);
});

// discord.js can lose its gateway shard for good (Sep 16: every voice join
// failed with "Shard 0 not found" for 23h). A brief blip during a gateway
// reconnect is normal, so only give up if it's still happening 2 min later.
// ponytail: heuristic trigger, replace if discord.js ever exposes shard health.
const SHARD_LOST_GRACE_MS = 2 * 60 * 1000;
const SHARD_LOST_EPISODE_MS = 30 * 60 * 1000; // episode older than this = old blip, start over
let shardLostSince = 0;

process.on('unhandledRejection', reason => {
  console.error('Unhandled rejection', reason);
  if (!/Shard \d+ not found/.test(errMsg(reason))) return;
  const now = Date.now();
  if (!shardLostSince || now - shardLostSince > SHARD_LOST_EPISODE_MS) {
    shardLostSince = now;
  } else if (now - shardLostSince > SHARD_LOST_GRACE_MS) {
    console.error('❌ Discord shard still missing after 2 min — exiting so systemd restarts the bot');
    process.exit(1);
  }
});
process.on('uncaughtException', err => console.error('Uncaught exception', err));
client.on(Events.Error, err => console.error('Discord client error', err));
client.on(Events.Warn, info => console.warn('Discord client warn', { info }));

// ---------------- READY ----------------

client.once(Events.ClientReady, async readyClient => {
  console.log(`🚀 Starting DJ DIKKAT  v${pkg.version}`);
  console.log(`✅ Logged in as ${readyClient.user.tag}`);
  console.log(`🏠 Guilds: ${readyClient.guilds.cache.size}`);
  if (process.env.DEPLOY_COMMANDS === 'true') {
    // A failed deploy must not take the rest of startup down with it.
    await deployCommands(readyClient).catch(err => console.error('❌ Command deploy failed:', errMsg(err)));
  } else {
    console.log('ℹ️  Command deploy skipped');
  }
  readyClient.user.setPresence(startupPresence() ?? {
    activities: [{ name: '🎵 Dakka Records INC.', type: ActivityType.Playing }],
    status: 'online'
  });

  // Admin API + heartbeat first — the startup announcements below walk every
  // guild one by one and can take a while.
  startInternalServer(readyClient, parseInt(process.env.BOT_INTERNAL_PORT || '3001', 10));
  startHeartbeat(readyClient, getActiveVoiceCount);

  await memory.syncAllGuildInfo(readyClient).catch(err => console.error('[DB] Guild directory sync failed:', errMsg(err)));
  await cleanupStaleCards();
  cleanupStaleStats();
  await announceAll();
  setInterval(announceAll, 60 * 60 * 1000);
});

async function cleanupStaleCards(): Promise<void> {
  const saved = memory.getAllSavedUiMessages();
  for (const { guildId, channelId, messageId } of saved) {
    await deleteMessage(client, channelId, messageId);
    memory.clearUiMessage(guildId);
  }
  if (saved.length) console.log(`🧹 Cleaned up ${saved.length} stale card(s) from previous session`);
}

function cleanupStaleStats(): void {
  const saved = memory.getAllSavedStatsMessages();
  let scheduled = 0;
  for (const { guildId, channelId, messageId, postedAt } of saved) {
    const elapsed = postedAt ? Date.now() - Date.parse(postedAt) : Infinity;
    const remaining = Math.max(0, STATS_AUTO_DELETE_MS - elapsed);
    if (remaining) scheduled++;
    setTimeout(async () => {
      await deleteMessage(client, channelId, messageId);
      memory.clearStatsMessage(guildId);
    }, remaining);
  }
  const instant = saved.length - scheduled;
  if (instant)   console.log(`📊 Deleting ${instant} expired stats card(s) on startup`);
  if (scheduled) console.log(`📊 Scheduled cleanup for ${scheduled} stats card(s) (within 3 min window)`);
}

// Runs at startup and hourly; sendAnnouncement skips guilds that already got
// one in the last 7 days.
async function announceAll(): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    await sendAnnouncement(guild).catch(err => console.error(`Failed to announce in guild ${guild.id}:`, err));
  }
}

client.on(Events.GuildCreate, async guild => {
  db.background(memory.syncGuildInfo(guild, true), `sync joined guild ${guild.id}`);
  await sendOwnerWelcome(guild);
  await sendAnnouncement(guild).catch(err => console.error(`Failed to announce in guild ${guild.id}:`, err));
});
client.on(Events.GuildDelete, guild => db.background(memory.syncGuildInfo(guild, false), `sync left guild ${guild.id}`));
client.on(Events.GuildUpdate, (_old, guild) => db.background(memory.syncGuildInfo(guild, true), `sync updated guild ${guild.id}`));

// ---------------- INTERACTIONS ----------------

client.on(Events.InteractionCreate, handleInteraction);

// ---------------- VC EMPTY AUTO-LEAVE ----------------

client.on(Events.VoiceStateUpdate, async (_old, newState) => {
  const guild = newState.guild;
  const state = peekState(guild.id);
  if (!state?.player || !state.voiceChannelId) return;

  const channel = guild.channels.cache.get(state.voiceChannelId);
  if (!channel?.isVoiceBased()) return;

  const humans = channel.members.filter(m => !m.user.bot).size;
  console.debug(`[VOICE] guild=${guild.id} channel=${channel.id} humans=${humans}`);
  if (humans === 0) {
    console.debug(`[VOICE] guild=${guild.id} — last human left, disconnecting`);
    await disconnectGuild(guild.id);
  }
});

// ---------------- DATA + LOGIN ----------------

// Everything is preloaded from MariaDB before login so all reads stay
// synchronous. If the DB isn't reachable, exit and let systemd retry.
async function loadData(): Promise<void> {
  await db.ensureSchema();
  const [mem, st, dms, confs] = await Promise.all([memory.loadAll(), stats.loadAll(), dmStore.loadAll(), configStore.loadAll()]);

  const maintenance = configStore.getConfig('maintenance');
  if (maintenance) setMaintenance(maintenance.enabled, maintenance.message);
  const cooldowns = configStore.getConfig('cooldowns');
  if (cooldowns) {
    setCommandCooldownMs(cooldowns.commandCooldownMs);
    setButtonCooldownMs(cooldowns.buttonCooldownMs);
  }
  const logLevel = configStore.getConfig('logLevel');
  if (logLevel) setLogLevel(logLevel);

  console.log(`🗄️  MariaDB loaded: ${mem.guilds} guilds, ${mem.plays} history rows, ${st.counters} stat counters, ${dms} tracked DMs, ${confs} config keys`);
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 ${signal} received — flushing pending DB writes`);
  await Promise.race([memory.flush(), new Promise(r => setTimeout(r, 5000))]).catch(() => {});
  await db.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

try {
  await loadData();
} catch (err) {
  console.error('❌ Could not load data from MariaDB — exiting so systemd retries:', errMsg(err));
  process.exit(1);
}
await client.login(DISCORD_TOKEN).catch(err => {
  console.error('❌ Discord login failed:', errMsg(err));
  process.exit(1);
});
