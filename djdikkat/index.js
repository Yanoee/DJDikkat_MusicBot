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

const { Client, GatewayIntentBits, Events, ActivityType } = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');
const pkg = require('../package.json');

const { handleInteraction, deployCommands } = require('./commands');
const { getState } = require('./state');
const { disconnectGuild } = require('./player');

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
  console.log('🚀 Starting Dj Dikkat');
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`🏠 Guilds: ${client.guilds.cache.size}`);
  if (process.env.DEPLOY_COMMANDS === 'true') {
    await deployCommands(client);
  } else {
    console.log('ℹ️ DEPLOY_COMMANDS not set to true — skipping command deploy');
  }
  if (client.user) {
    client.user.setPresence({
      activities: [{ name: pkg.description || 'DJ DIKKAT', type: ActivityType.Playing }],
      status: 'online'
    });
  }
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

