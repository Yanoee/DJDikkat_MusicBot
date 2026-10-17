/************************************************************
 * DJ DIKKAT - Music Bot
 * ClientReady
 * Command deploy, presence, internal API, card icons, stale card cleanup
 * and the hourly announcement sweep.
 * Author: Yanoee
 ************************************************************/
import type { Client } from 'discord.js';
import pkg from '../../package.json' with { type: 'json' };
import { config } from '../config.ts';
import { deployCommands } from '../commands/index.ts';
import { STATS_AUTO_DELETE_MS } from '../commands/shared.ts';
import { getActiveVoiceCount } from '../music/state.ts';
import { deleteMessage, loadCardIcons } from '../ui/player-card.ts';
import { sendAnnouncement } from '../services/announcement.ts';
import { startInternalServer, startPresence } from '../internal/server.ts';
import * as memory from '../services/memory.ts';
import { startHeartbeat } from '../lib/logger.ts';
import { errMsg } from '../lib/errors.ts';

export async function onReady(client: Client<true>): Promise<void> {
  console.log(`🚀 Starting DJ DIKKAT  v${pkg.version}`);
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`🏠 Guilds: ${client.guilds.cache.size}`);
  if (config.deployCommands) {
    // A failed deploy must not take the rest of startup down with it.
    await deployCommands(client).catch(err => console.error('❌ Command deploy failed:', errMsg(err)));
  } else {
    console.log('ℹ️  Command deploy skipped');
  }
  startPresence(client);

  // Internal API + heartbeat first — the startup announcements below walk
  // every guild one by one and can take a while.
  startInternalServer(client, config.internal.port);
  startHeartbeat(client, getActiveVoiceCount);

  await memory.syncAllGuildInfo(client).catch(err => console.error('[DB] Guild directory sync failed:', errMsg(err)));
  await loadCardIcons(client);
  await cleanupStaleCards(client);
  cleanupStaleStats(client);
  await announceAll(client);
  setInterval(() => announceAll(client), 60 * 60 * 1000);
}

async function cleanupStaleCards(client: Client): Promise<void> {
  const saved = memory.getAllSavedUiMessages();
  for (const { guildId, channelId, messageId } of saved) {
    await deleteMessage(client, channelId, messageId);
    memory.clearUiMessage(guildId);
  }
  if (saved.length) console.log(`🧹 Cleaned up ${saved.length} stale card(s) from previous session`);
}

function cleanupStaleStats(client: Client): void {
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
async function announceAll(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    await sendAnnouncement(guild).catch(err => console.error(`Failed to announce in guild ${guild.id}:`, err));
  }
}
