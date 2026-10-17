/************************************************************
 * DJ DIKKAT - Music Bot
 * Guild + voice events
 * Directory sync on join/leave/update, the setup card, and
 * leaving voice when the last human leaves.
 * Author: Yanoee
 ************************************************************/
import type { Guild, VoiceState } from 'discord.js';
import { peekState } from '../music/state.ts';
import { disconnectGuild } from '../music/player.ts';
import { sendAnnouncement, sendSetupCard } from '../services/announcement.ts';
import * as memory from '../services/memory.ts';
import * as db from '../services/db.ts';

export async function onGuildCreate(guild: Guild): Promise<void> {
  db.background(memory.syncGuildInfo(guild, true), `sync joined guild ${guild.id}`);
  await sendSetupCard(guild);
  await sendAnnouncement(guild).catch(err => console.error(`Failed to announce in guild ${guild.id}:`, err));
}

export function onGuildDelete(guild: Guild): void {
  db.background(memory.syncGuildInfo(guild, false), `sync left guild ${guild.id}`);
}

export function onGuildUpdate(guild: Guild): void {
  db.background(memory.syncGuildInfo(guild, true), `sync updated guild ${guild.id}`);
}

export async function onVoiceStateUpdate(newState: VoiceState): Promise<void> {
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
}
