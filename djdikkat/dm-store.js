/************************************************************
 * DJ DIKKAT - DM Store
 * Tracks message IDs of DMs the bot sends so they can be
 * bulk-deleted later via the admin panel "Clean DMs" button.
 * Build 5.0.0
 * Author: Yanoee
 ************************************************************/

const db = require('./db');

const MAX_ENTRIES = 500;

let cache = [];

async function loadAll() {
  const rows = await db.query(
    'SELECT channel_id, message_id, type, created_at FROM dm_messages ORDER BY id DESC LIMIT ?',
    [MAX_ENTRIES]
  );
  cache = rows.map(r => ({ channelId: r.channel_id, messageId: r.message_id, type: r.type, ts: db.toIso(r.created_at) }));
  return cache.length;
}

async function trackDm(channelId, messageId, type = 'dm') {
  const ts = new Date();
  cache.unshift({ channelId, messageId, type, ts: ts.toISOString() });
  if (cache.length > MAX_ENTRIES) cache.length = MAX_ENTRIES;
  db.background((async () => {
    await db.query(
      'INSERT INTO dm_messages (channel_id, message_id, type, created_at) VALUES (?, ?, ?, ?)',
      [channelId, messageId, String(type).slice(0, 32), ts]
    );
    // keep the newest MAX_ENTRIES rows
    await db.query(
      'DELETE FROM dm_messages WHERE id <= (SELECT id FROM (SELECT id FROM dm_messages ORDER BY id DESC LIMIT 1 OFFSET ?) t)',
      [MAX_ENTRIES]
    );
  })(), 'track DM');
}

async function cleanDms(client) {
  let deleted = 0;
  let failed  = 0;
  const keep  = [];

  for (const entry of cache) {
    try {
      const channel = client.channels.cache.get(entry.channelId)
        || await client.channels.fetch(entry.channelId).catch(() => null);
      if (!channel) { failed++; keep.push(entry); continue; } // unreachable — retry next time
      const msg = await channel.messages.fetch(entry.messageId).catch(() => null);
      if (msg) {
        await msg.delete();
        deleted++;
      }
      // message gone (deleted now or already gone) — don't keep in list
    } catch {
      failed++;
      keep.push(entry); // delete failed — keep for next attempt
    }
  }

  const done = cache.filter(e => !keep.includes(e)).map(e => e.messageId);
  cache = keep;
  if (done.length) await db.query('DELETE FROM dm_messages WHERE message_id IN (?)', [done]);
  return { deleted, failed };
}

// Scans guild owner DM channels + cached DM channels to delete bot messages.
// Covers historical DMs sent before tracking was introduced.
// ChannelType.DM = 1 in discord.js v14
async function scanAndCleanDms(client) {
  let deleted = 0;
  let failed  = 0;
  const scanned = new Set();

  async function cleanChannel(channel) {
    if (!channel || scanned.has(channel.id)) return;
    scanned.add(channel.id);
    try {
      const msgs = await channel.messages.fetch({ limit: 50 });
      for (const msg of msgs.values()) {
        if (msg.author?.id !== client.user?.id) continue;
        const ok = await msg.delete().then(() => true).catch(() => false);
        if (ok) deleted++; else failed++;
      }
    } catch { failed++; }
  }

  // 1. Cached DM channels from this session
  for (const channel of client.channels.cache.values()) {
    if (channel.type !== 1) continue;
    await cleanChannel(channel);
  }

  // 2. Guild owner DM channels (covers all historical welcome DMs)
  for (const guild of client.guilds.cache.values()) {
    try {
      const owner = await client.users.fetch(guild.ownerId).catch(() => null);
      if (!owner) continue;
      const dmChannel = await owner.createDM().catch(() => null);
      await cleanChannel(dmChannel);
    } catch { failed++; }
  }

  // Also wipe the tracked list since we've now done a full sweep
  cache = [];
  await db.query('DELETE FROM dm_messages');

  return { deleted, failed, scanned: scanned.size };
}

module.exports = { loadAll, trackDm, cleanDms, scanAndCleanDms };
