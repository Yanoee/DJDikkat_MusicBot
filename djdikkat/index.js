/************************************************************
 * DJ DIKKAT - Music Bot
 * Bot entrypoint
 * Client bootstrap and event wiring
 * Build 5.0.0
 * Author: Yanoee
 ************************************************************/
const path = require('path');
// Always load the bot's .env regardless of current working directory.
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Logger must be required before anything else so the console patch applies globally.
const { startHeartbeat, setLogLevel } = require('./logger');

const { Client, GatewayIntentBits, Events, ActivityType } = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');
const { version: BOT_VERSION } = require('../package.json');

const { handleInteraction, deployCommands, setButtonCooldownMs } = require('./commands');
const { peekState, getActiveVoiceCount, getActiveGuildIds, setCommandCooldownMs } = require('./state');
const { disconnectGuild, handlePlayerFailure } = require('./player');
const { deleteMessage } = require('./ui');
const { sendAnnouncement, sendOwnerWelcome } = require('./announcement');
const { startInternalServer, startupPresence } = require('./internal-server');
const memory = require('./memory');
const { getAllSavedUiMessages, clearUiMessage, getAllSavedStatsMessages, clearStatsMessage } = memory;
const db = require('./db');
const stats = require('./stats');
const dmStore = require('./dm-store');
const configStore = require('./config-store');
const { setMaintenance } = require('./runtime-flags');

const { DISCORD_TOKEN, NODELINK_HOST, NODELINK_PORT, NODELINK_PASSWORD, NODELINK_SECURE } = process.env;
const required = { DISCORD_TOKEN, NODELINK_HOST, NODELINK_PORT, NODELINK_PASSWORD };
const missing = Object.keys(required).filter(key => !required[key]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

// ---------------- DISCORD CLIENT ----------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// ---------------- NODELINK ----------------

const shoukaku = new Shoukaku(
  new Connectors.DiscordJS(client),
  [{
    name: 'main',
    url: `${NODELINK_HOST}:${NODELINK_PORT}`,
    auth: NODELINK_PASSWORD,
    secure: NODELINK_SECURE === 'true'
  }],
  {
    // Shoukaku's defaults (3 tries × 5s = ~15s total) can be exhausted before
    // NodeLink finishes a cold boot (40+ sources, now 2 workers) if the bot
    // and NodeLink ever restart around the same time — the node then sits in
    // DISCONNECTED with no further automatic retry until the bot itself is
    // restarted. Wider budget so a coincidental simultaneous restart recovers
    // on its own instead of needing a manual intervention.
    reconnectTries: 10,
    reconnectInterval: 5
  }
);

client.shoukaku = shoukaku;

shoukaku.on('error', (nodeName, error) => {
  console.error(`[NODELINK ERROR] Node ${nodeName}`, error);
});

shoukaku.on('ready', (nodeName) => {
  console.log(`✅ NodeLink node ready: ${nodeName}`);
});

// 'close' fires on every dropped NodeLink socket; Shoukaku then retries on
// its own (reconnectTries below) and emits 'ready' again once it's back.
shoukaku.on('close', (nodeName, code, reason) => {
  console.warn(`⚠️ NodeLink node connection closed: ${nodeName} (${code}) ${reason || ''}`);
  recoverActiveGuilds();
});

// 'disconnect' fires only once every reconnect try is used up — Shoukaku has
// then removed the node for good and will never retry. Exit so systemd
// (Restart=always) brings up a fresh process that connects from scratch.
shoukaku.on('disconnect', (nodeName, movedPlayers) => {
  console.error(`❌ NodeLink node ${nodeName} gave up reconnecting (moved ${movedPlayers} player(s)) — exiting so systemd restarts the bot`);
  process.exit(1);
});

// When the node itself drops, every guild's player session on it is dead too —
// sweep them so they self-heal instead of silently failing on the next command.
function recoverActiveGuilds() {
  const guildIds = getActiveGuildIds();
  if (!guildIds.length) return;
  console.warn(`⚠️ Sweeping ${guildIds.length} active guild(s) for player recovery`);
  for (const guildId of guildIds) {
    handlePlayerFailure(guildId, { reconnect: true }).catch(err =>
      console.error(`[NODE RECOVERY] guild ${guildId} failed:`, err));
  }
}

// discord.js can lose its gateway shard for good (Sep 16: every voice join
// failed with "Shard 0 not found" for 23h). A brief blip during a gateway
// reconnect is normal, so only give up if it's still happening 2 min later —
// exit(1) and let systemd (Restart=always) bring up a clean process.
// ponytail: heuristic trigger, replace if discord.js ever exposes shard health.
const SHARD_LOST_GRACE_MS = 2 * 60 * 1000;
const SHARD_LOST_EPISODE_MS = 30 * 60 * 1000; // episode older than this = old blip, start over
let shardLostSince = 0;

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection', reason);
  if (!/Shard \d+ not found/.test(reason?.message || '')) return;
  const now = Date.now();
  if (!shardLostSince || now - shardLostSince > SHARD_LOST_EPISODE_MS) {
    shardLostSince = now;
  } else if (now - shardLostSince > SHARD_LOST_GRACE_MS) {
    console.error('❌ Discord shard still missing after 2 min — exiting so systemd restarts the bot');
    process.exit(1);
  }
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception', err);
});

client.on('error', (err) => {
  console.error('Discord client error', err);
});

client.on('warn', (info) => {
  console.warn('Discord client warn', { info });
});

// ---------------- READY ----------------

client.once(Events.ClientReady, async () => {
  console.log(`🚀 Starting DJ DIKKAT  v${BOT_VERSION}`);
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`🏠 Guilds: ${client.guilds.cache.size}`);
  if (process.env.DEPLOY_COMMANDS === 'true') {
    // A failed deploy must not take the rest of startup down with it.
    try {
      await deployCommands(client);
    } catch (err) {
      console.error('❌ Command deploy failed:', err.message);
    }
  } else {
    console.log('ℹ️  Command deploy skipped');
  }
  if (client.user) {
    client.user.setPresence(startupPresence() || {
      activities: [{ name: '🎵 Dakka Records INC.', type: ActivityType.Playing }],
      status: 'online'
    });
  }

  // Admin API + heartbeat first — the startup announcements below walk every
  // guild one by one and can take a while.
  const internalPort = parseInt(process.env.BOT_INTERNAL_PORT || '3001', 10);
  startInternalServer(client, internalPort);

  startHeartbeat(client, getActiveVoiceCount);

  await memory.syncAllGuildInfo(client).catch(err => console.error('[DB] Guild directory sync failed:', err.message));
  await cleanupStaleCards(client);
  cleanupStaleStats(client);
  await announceAll(client);
  setInterval(() => announceAll(client), 60 * 60 * 1000);
});

async function cleanupStaleCards(client) {
  const saved = getAllSavedUiMessages();
  for (const { guildId, channelId, messageId } of saved) {
    await deleteMessage(client, channelId, messageId);
    await clearUiMessage(guildId);
  }
  if (saved.length > 0) {
    console.log(`🧹 Cleaned up ${saved.length} stale card(s) from previous session`);
  }
}

function cleanupStaleStats(client) {
  const AUTO_DELETE_MS = 3 * 60 * 1000;
  const saved = getAllSavedStatsMessages();
  if (!saved.length) return;

  let scheduled = 0;
  for (const { guildId, channelId, messageId, postedAt } of saved) {
    const elapsed   = postedAt ? Date.now() - new Date(postedAt).getTime() : Infinity;
    const remaining = Math.max(0, AUTO_DELETE_MS - elapsed);

    const deleteMsg = async () => {
      await deleteMessage(client, channelId, messageId);
      await clearStatsMessage(guildId);
    };

    if (remaining === 0) {
      deleteMsg();
    } else {
      setTimeout(deleteMsg, remaining);
      scheduled++;
    }
  }

  const instant = saved.length - scheduled;
  if (instant)   console.log(`📊 Deleted ${instant} expired stats card(s) on startup`);
  if (scheduled) console.log(`📊 Scheduled cleanup for ${scheduled} stats card(s) (within 3 min window)`);
}

// Runs at startup and hourly; sendAnnouncement itself skips guilds that
// already got one in the last 7 days.
async function announceAll(client) {
  for (const guild of client.guilds.cache.values()) {
    await announceIfNeeded(guild, client);
  }
}

async function announceIfNeeded(guild, client) {
  try {
    await sendAnnouncement(guild, client);
  } catch (err) {
    console.error(`Failed to announce in guild ${guild.id}:`, err);
  }
}

client.on(Events.GuildCreate, async (guild) => {
  db.background(memory.syncGuildInfo(guild, true), `sync joined guild ${guild.id}`);
  await sendOwnerWelcome(guild, client);
  await announceIfNeeded(guild, client);
});

client.on(Events.GuildDelete, (guild) => {
  db.background(memory.syncGuildInfo(guild, false), `sync left guild ${guild.id}`);
});

client.on(Events.GuildUpdate, (_old, guild) => {
  db.background(memory.syncGuildInfo(guild, true), `sync updated guild ${guild.id}`);
});

// ---------------- INTERACTIONS ----------------

client.on(Events.InteractionCreate, handleInteraction);

// ---------------- VC EMPTY AUTO-LEAVE ----------------

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;

  const state = peekState(guild.id);
  if (!state?.player || !state.voiceChannelId) return;

  const channel = guild.channels.cache.get(state.voiceChannelId);
  if (!channel || !channel.members) return;

  // only humans count
  const humans = channel.members.filter(m => !m.user.bot);
  console.debug(`[VOICE] guild=${guild.id} channel=${channel.id} humans=${humans.size}`);
  if (humans.size === 0) {
    console.debug(`[VOICE] guild=${guild.id} — last human left, disconnecting`);
    await disconnectGuild(guild.id);
  }
});

// ---------------- DATA + LOGIN ----------------

// Everything is preloaded from MariaDB before login so all reads stay
// synchronous. If the DB isn't reachable, exit and let systemd retry.
async function loadData() {
  await db.ensureSchema();
  const mem   = await memory.loadAll();
  const st    = await stats.loadAll();
  const dms   = await dmStore.loadAll();
  const confs = await configStore.loadAll();

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
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 ${signal} received — flushing pending DB writes`);
  await Promise.race([memory.flush(), new Promise(r => setTimeout(r, 5000))]).catch(() => {});
  await db.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

loadData()
  .catch(err => {
    console.error('❌ Could not load data from MariaDB — exiting so systemd retries:', err.message);
    process.exit(1);
  })
  .then(() => client.login(DISCORD_TOKEN))
  .catch(err => {
    console.error('❌ Discord login failed:', err.message);
    process.exit(1);
  });

