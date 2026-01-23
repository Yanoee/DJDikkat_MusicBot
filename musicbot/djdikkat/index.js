/************************************************************
 * DJ DIKKAT - Music Bot
 * Bot entrypoint
 * Client bootstrap and event wiring
 * Build 2.0.3.17
 * Author: Yanoee
 ************************************************************/
require('dotenv').config();

const { Client, GatewayIntentBits, Events, ActivityType } = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');
const pkg = require('../package.json');

const { handleInteraction, deployCommands } = require('./commands');
const { getState } = require('./state');
const { disconnectGuild } = require('./player');

// ---------------- DISCORD CLIENT ----------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// ---------------- LAVALINK ----------------

const shoukaku = new Shoukaku(
  new Connectors.DiscordJS(client),
  [{
    name: 'main',
    url: `${process.env.LAVALINK_HOST}:${process.env.LAVALINK_PORT}`,
    auth: process.env.LAVALINK_PASSWORD
  }]
);

client.shoukaku = shoukaku;

// Forward raw voice packets (REQUIRED)
client.on('raw', (p) => {
  if (p.t === 'VOICE_SERVER_UPDATE') shoukaku.emit('VOICE_SERVER_UPDATE', p.d);
  if (p.t === 'VOICE_STATE_UPDATE') shoukaku.emit('VOICE_STATE_UPDATE', p.d);
});

// ---------------- READY ----------------

client.once(Events.ClientReady, async () => {
  console.log(`🚀 Starting Dj Dikkat`);
  console.log(`✅ Logged in as ${client.user.tag}`);
  await deployCommands(client);
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

client.login(process.env.DISCORD_TOKEN);

