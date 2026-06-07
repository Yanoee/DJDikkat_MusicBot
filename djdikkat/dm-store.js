/************************************************************
 * DJ DIKKAT - DM Store
 * Tracks message IDs of DMs the bot sends so they can be
 * bulk-deleted later via the admin panel "Clean DMs" button.
 * Build 4.0.0
 * Author: Yanoee
 ************************************************************/

const fs   = require('fs');
const path = require('path');
const fsp  = fs.promises;

const FILE       = path.join(__dirname, 'data', 'dm-track.json');
const MAX_ENTRIES = 500;

let cache = null;

function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(FILE)) {
      const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      cache = Array.isArray(parsed) ? parsed : [];
    } else {
      cache = [];
    }
  } catch { cache = []; }
  return cache;
}

async function persist() {
  try {
    await fsp.mkdir(path.dirname(FILE), { recursive: true });
    await fsp.writeFile(FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('[dm-store] Failed to save:', err.message);
  }
}

async function trackDm(channelId, messageId, type = 'dm') {
  load();
  cache.unshift({ channelId, messageId, type, ts: new Date().toISOString() });
  if (cache.length > MAX_ENTRIES) cache.length = MAX_ENTRIES;
  await persist();
}

async function cleanDms(client) {
  load();
  let deleted = 0;
  let failed  = 0;
  const keep  = [];

  for (const entry of cache) {
    try {
      const channel = client.channels.cache.get(entry.channelId)
        || await client.channels.fetch(entry.channelId).catch(() => null);
      if (!channel) { failed++; continue; }
      const msg = await channel.messages.fetch(entry.messageId).catch(() => null);
      if (msg) {
        await msg.delete();
        deleted++;
      }
      // message gone (deleted now or already gone) — don't keep in list
    } catch {
      failed++;
      keep.push(entry); // unreachable channel — keep for next attempt
    }
  }

  cache = keep;
  await persist();
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
  await persist();

  return { deleted, failed, scanned: scanned.size };
}

module.exports = { trackDm, cleanDms, scanAndCleanDms };
