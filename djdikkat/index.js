/************************************************************
 * DJ DIKKAT - Music Bot
 * Bot entrypoint
 * Client bootstrap and event wiring
 * Build 2.0.7
 * Author: Yanoee
 ************************************************************/
const path = require('path');
// Always load the bot's .env regardless of current working directory.
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Logger must be required before anything else so the console patch applies globally.
const { startHeartbeat } = require('./logger');

const { Client, GatewayIntentBits, Events, ActivityType } = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');
const pkg = require('../package.json');

const { handleInteraction, deployCommands } = require('./commands');
const { getState, getActiveVoiceCount } = require('./state');
const { disconnectGuild } = require('./player');
const { sendAnnouncement, sendOwnerWelcome } = require('./announcement');
const { startInternalServer } = require('./internal-server');
const { getAllSavedUiMessages, clearUiMessage } = require('./memory');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const required = [
  ['DISCORD_TOKEN/TOKEN', DISCORD_TOKEN],
  ['LAVALINK_HOST', process.env.LAVALINK_HOST],
  ['LAVALINK_PORT', process.env.LAVALINK_PORT],
  ['LAVALINK_PASSWORD', process.env.LAVALINK_PASSWORD]
];
const missing = required.filter(([, value]) => !value).map(([key]) => key);
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
client.lavalinkReadyNodes = new Set();

// ---------------- LAVALINK ----------------

const shoukaku = new Shoukaku(
  new Connectors.DiscordJS(client),
  [{
    name: 'main',
    url: `${process.env.LAVALINK_HOST}:${process.env.LAVALINK_PORT}`,
    auth: process.env.LAVALINK_PASSWORD,
    secure: process.env.LAVALINK_SECURE === 'true'
  }]
);

client.shoukaku = shoukaku;

shoukaku.on('error', (nodeName, error) => {
  console.error(`[LAVALINK ERROR] Node ${nodeName}`, error);
});

shoukaku.on('ready', (nodeName) => {
  console.log(`✅ Lavalink node ready: ${nodeName}`);
  client.lavalinkReadyNodes.add(nodeName);
});

shoukaku.on('disconnect', (nodeName, code, reason) => {
  console.warn(`⚠️ Lavalink node disconnected: ${nodeName} (${code}) ${reason || ''}`);
  client.lavalinkReadyNodes.delete(nodeName);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection', reason);
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
  console.log(`🚀 Starting DJ DIKKAT  v${pkg.version}`);
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`🏠 Guilds: ${client.guilds.cache.size}`);
  if (process.env.DEPLOY_COMMANDS === 'true') {
    await deployCommands(client);
  } else {
    console.log('ℹ️  Command deploy skipped');
  }
  if (client.user) {
    client.user.setPresence({
      activities: [{ name: pkg.description || 'DJ DIKKAT', type: ActivityType.Playing }],
      status: 'online'
    });
  }

  await cleanupStaleCards(client);
  await announceOnStartup(client);
  setInterval(() => announceWeekly(client), 60 * 60 * 1000);

  const internalPort = parseInt(process.env.BOT_INTERNAL_PORT || '3001', 10);
  startInternalServer(client, internalPort);

  startHeartbeat(client, getActiveVoiceCount);
});

async function cleanupStaleCards(client) {
  const saved = getAllSavedUiMessages();
  for (const { guildId, channelId, messageId } of saved) {
    try {
      const channel = client.channels.cache.get(channelId)
        || await client.channels.fetch(channelId).catch(() => null);
      if (channel?.messages) {
        const msg = await channel.messages.fetch(messageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }
    } catch {}
    await clearUiMessage(guildId);
  }
  if (saved.length > 0) {
    console.log(`🧹 Cleaned up ${saved.length} stale card(s) from previous session`);
  }
}

async function announceOnStartup(client) {
  for (const guild of client.guilds.cache.values()) {
    await announceIfNeeded(guild, client);
  }
}

async function announceWeekly(client) {
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
  await sendOwnerWelcome(guild, client);
  await announceIfNeeded(guild, client);
});

// ---------------- INTERACTIONS ----------------

client.on(Events.InteractionCreate, handleInteraction);

// ---------------- VC EMPTY AUTO-LEAVE ----------------

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;

  const state = getState(guild.id);
  if (!state.player || !state.voiceChannelId) return;

  const channel = guild.channels.cache.get(state.voiceChannelId);
  if (!channel || !channel.members) return;

  // only humans count
  const humans = channel.members.filter(m => !m.user.bot);
  if (humans.size === 0) {
    await disconnectGuild(guild.id);
  }
});

// ---------------- LOGIN ----------------

client.login(DISCORD_TOKEN);

