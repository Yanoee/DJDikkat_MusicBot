/************************************************************
 * DJ DIKKAT - DM Store
 * Tracks message IDs of DMs the bot sends so they can be
 * bulk-deleted later via the admin panel "Clean DMs" button.
 * Build 5.2.0
 * Author: Yanoee
 ************************************************************/
import { ChannelType } from 'discord.js';
import type { Client, DMChannel } from 'discord.js';
import * as db from './db.ts';

interface TrackedDm {
  channelId: string;
  messageId: string;
  type: string;
}

const MAX_ENTRIES = 500;

let cache: TrackedDm[] = [];

export async function loadAll(): Promise<number> {
  const rows = await db.query<{ channel_id: string; message_id: string; type: string }[]>(
    'SELECT channel_id, message_id, type FROM dm_messages ORDER BY id DESC LIMIT ?', [MAX_ENTRIES]);
  cache = rows.map(r => ({ channelId: r.channel_id, messageId: r.message_id, type: r.type }));
  return cache.length;
}

export async function trackDm(channelId: string, messageId: string, type = 'dm'): Promise<void> {
  cache.unshift({ channelId, messageId, type });
  if (cache.length > MAX_ENTRIES) cache.length = MAX_ENTRIES;
  db.background((async () => {
    await db.query('INSERT INTO dm_messages (channel_id, message_id, type, created_at) VALUES (?, ?, ?, ?)',
      [channelId, messageId, type.slice(0, 32), new Date()]);
    // keep the newest MAX_ENTRIES rows
    await db.query(
      'DELETE FROM dm_messages WHERE id <= (SELECT id FROM (SELECT id FROM dm_messages ORDER BY id DESC LIMIT 1 OFFSET ?) t)',
      [MAX_ENTRIES]);
  })(), 'track DM');
}

/** Deletes every tracked DM. Unreachable ones are kept for the next attempt. */
export async function cleanDms(client: Client): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed  = 0;
  const keep: TrackedDm[] = [];

  for (const entry of cache) {
    try {
      const channel = client.channels.cache.get(entry.channelId)
        ?? await client.channels.fetch(entry.channelId).catch(() => null);
      if (!channel?.isTextBased()) { failed++; keep.push(entry); continue; }
      const msg = await channel.messages.fetch(entry.messageId).catch(() => null);
      if (msg) { await msg.delete(); deleted++; }
      // message gone (deleted now or already) — drop it from the list
    } catch {
      failed++;
      keep.push(entry);
    }
  }

  const done = cache.filter(e => !keep.includes(e)).map(e => e.messageId);
  cache = keep;
  if (done.length) await db.query('DELETE FROM dm_messages WHERE message_id IN (?)', [done]);
  return { deleted, failed };
}

/**
 * Sweeps cached DM channels + every guild owner's DM channel and deletes the
 * bot's messages there — covers DMs sent before tracking existed.
 */
export async function scanAndCleanDms(client: Client): Promise<{ deleted: number; failed: number; scanned: number }> {
  let deleted = 0;
  let failed  = 0;
  const scanned = new Set<string>();

  async function cleanChannel(channel: DMChannel | null): Promise<void> {
    if (!channel || scanned.has(channel.id)) return;
    scanned.add(channel.id);
    try {
      const msgs = await channel.messages.fetch({ limit: 50 });
      for (const msg of msgs.values()) {
        if (msg.author.id !== client.user?.id) continue;
        if (await msg.delete().then(() => true, () => false)) deleted++; else failed++;
      }
    } catch { failed++; }
  }

  for (const channel of client.channels.cache.values()) {
    if (channel.type === ChannelType.DM && !channel.partial) await cleanChannel(channel);
  }
  for (const guild of client.guilds.cache.values()) {
    const owner = await client.users.fetch(guild.ownerId).catch(() => null);
    await cleanChannel(await owner?.createDM().catch(() => null) ?? null);
  }

  // a full sweep supersedes the tracked list
  cache = [];
  await db.query('DELETE FROM dm_messages');
  return { deleted, failed, scanned: scanned.size };
}
