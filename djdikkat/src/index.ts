/************************************************************
 * DJ DIKKAT - Music Bot
 * Bot entrypoint
 * Client + NodeLink bootstrap, event wiring, data load, login.
 * Author: Yanoee
 ************************************************************/
// Settings come from the shared .env file via systemd (see config.ts).
// ESM evaluates imports in order, so the logger's console patch runs before
// any other module.
import { setLogLevel } from './lib/logger.ts';

import { Client, GatewayIntentBits, Events, Partials } from 'discord.js';
import { Shoukaku, Connectors } from 'shoukaku';
import { config, missingSettings } from './config.ts';
import { setButtonCooldownMs } from './components/buttons.ts';
import { getActiveGuildIds, setCommandCooldownMs } from './music/state.ts';
import { handlePlayerFailure } from './music/player.ts';
import { handleInteraction } from './events/interaction-create.ts';
import { onReady } from './events/ready.ts';
import { onGuildCreate, onGuildDelete, onGuildUpdate, onVoiceStateUpdate } from './events/guild.ts';
import * as memory from './services/memory.ts';
import * as db from './services/db.ts';
import * as stats from './services/stats.ts';
import * as dmStore from './services/dm-store.ts';
import * as configStore from './services/config-store.ts';
import { onMemberJoin } from './services/greeting.ts';
import { giveAutoroles, onMemberLeave } from './services/features.ts';
import { errMsg } from './lib/errors.ts';
import type {} from './lib/types.ts'; // Client.shoukaku augmentation

if (missingSettings.length) {
  console.error(`Missing required settings in shared/.env: ${missingSettings.join(', ')}`);
  process.exit(1);
}

// ---------------- DISCORD CLIENT ----------------

// Member greetings need the privileged Server Members intent. Asking for it
// while the Developer Portal switch is off makes login fail, so ask Discord
// first and only request it when it's allowed (the panel then offers greetings).
const MEMBERS_INTENT_FLAGS = (1 << 14) | (1 << 15); // GATEWAY_GUILD_MEMBERS (+ _LIMITED)
async function membersIntentAllowed(): Promise<boolean> {
  try {
    const res = await fetch('https://discord.com/api/v10/applications/@me', { headers: { Authorization: `Bot ${config.discordToken}` } });
    const app = res.ok ? await res.json() as { flags?: number } : {};
    return ((app.flags ?? 0) & MEMBERS_INTENT_FLAGS) !== 0;
  } catch {
    return false;
  }
}
const membersIntent = await membersIntentAllowed();
console.log(`👥 Server Members intent: ${membersIntent ? 'on (member greetings available)' : 'off in the Developer Portal (member greetings disabled)'}`);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, ...(membersIntent ? [GatewayIntentBits.GuildMembers] : [])],
  // Leave messages for members who joined before the last restart (not in the cache).
  partials: [Partials.GuildMember]
});

// ---------------- NODELINK ----------------

const shoukaku = new Shoukaku(
  new Connectors.DiscordJS(client),
  [{ name: 'main', url: `${config.nodelink.host}:${config.nodelink.port}`, auth: config.nodelink.password, secure: config.nodelink.secure }],
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

// ---------------- EVENTS ----------------

client.once(Events.ClientReady, onReady);
client.on(Events.InteractionCreate, handleInteraction);
client.on(Events.GuildCreate, onGuildCreate);
client.on(Events.GuildDelete, onGuildDelete);
client.on(Events.GuildUpdate, (_old, guild) => onGuildUpdate(guild));
client.on(Events.VoiceStateUpdate, (_old, newState) => onVoiceStateUpdate(newState));
client.on(Events.GuildMemberAdd, member => {
  onMemberJoin(member).catch(err => console.error(`[WELCOME] guild ${member.guild.id} failed:`, err));
  giveAutoroles(member).catch(err => console.error(`[AUTOROLE] guild ${member.guild.id} failed:`, err));
});
// Auto-role waits for Discord's membership screening ("pending") to be passed.
client.on(Events.GuildMemberUpdate, (old, member) => {
  if (old.pending && !member.pending) giveAutoroles(member).catch(err => console.error(`[AUTOROLE] guild ${member.guild.id} failed:`, err));
});
client.on(Events.GuildMemberRemove, member => {
  onMemberLeave(member).catch(err => console.error(`[LEAVE] guild ${member.guild.id} failed:`, err));
});

// ---------------- DATA + LOGIN ----------------

// Everything is preloaded from MariaDB before login so all reads stay
// synchronous. If the DB isn't reachable, exit and let systemd retry.
async function loadData(): Promise<void> {
  await db.ensureSchema();
  const [mem, st, dms, confs] = await Promise.all([memory.loadAll(), stats.loadAll(), dmStore.loadAll(), configStore.loadAll()]);

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
await client.login(config.discordToken).catch(err => {
  console.error('❌ Discord login failed:', errMsg(err));
  process.exit(1);
});
