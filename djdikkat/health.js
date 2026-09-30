/************************************************************
 * DJ DIKKAT - Music Bot
 * Health reporter
 * DM health embed builder
 * Build 5.0.0
 * Author: Yanoee
 ************************************************************/

const os   = require('os');
const db   = require('./db');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getInactivityRemaining, getActiveVoiceCount } = require('./state');
const { formatMs } = require('./ui');

// ── Formatters ────────────────────────────────────────────

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let b = bytes;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(1)} ${units[i]}`;
}

function formatUptime(seconds) {
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor((seconds / 3600) % 24);
  const d = Math.floor(seconds / 86400);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function timeAgo(dateStr) {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  if (!Number.isFinite(diff) || diff < 0) return '—';
  const s = Math.floor(diff / 1000);
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

// ── CPU sampling ──────────────────────────────────────────

let lastCpu     = process.cpuUsage();
let lastCpuTime = Date.now();

function averageCpuPercent() {
  const now       = Date.now();
  const elapsedMs = now - lastCpuTime;
  if (elapsedMs <= 0) return 0;
  const current = process.cpuUsage(lastCpu);
  lastCpu     = process.cpuUsage();
  lastCpuTime = now;
  const usedMs = (current.user + current.system) / 1000;
  const cores  = os.cpus().length || 1;
  const pct    = (usedMs / (elapsedMs * cores)) * 100;
  return Number.isFinite(pct) ? pct : 0;
}

// ── External service checks ───────────────────────────────

async function loadLastUpdate() {
  try {
    const [row] = await db.query('SELECT * FROM update_history ORDER BY ts DESC, id DESC LIMIT 1');
    if (!row) return null;
    return {
      timestamp: db.toIso(row.ts),
      status:    row.status,
      failedAt:  row.failed_at,
      nodelink:  { updated: !!row.nodelink_updated, commitBefore: row.commit_before, commitAfter: row.commit_after }
    };
  } catch {
    return null;
  }
}

function formatLastUpdate(update) {
  if (!update) return '*No update record found.*\nRun update-all.sh at least once.';

  const icon       = update.status === 'success' ? '✅' : '❌';
  const statusText = update.status === 'success'
    ? 'Success'
    : `Failed at: **${update.failedAt || 'unknown'}**`;
  const when = timeAgo(update.timestamp);

  const lines = [`${icon} ${statusText} • ${when}`];

  if (update.nodelink) {
    const nl  = update.nodelink;
    const sha = nl.commitAfter ? ` → \`${nl.commitAfter}\`` : '';
    lines.push(`🎚️ NodeLink  ${nl.updated ? `🔄 updated${sha}` : '✔️ no change'}`);
  }

  return lines.join('\n');
}

// ── Embed builder ─────────────────────────────────────────

async function buildHealthEmbed(client, state, meta, node) {
  const nodeStats = node?.stats ?? null;

  const status = state.current
    ? (state.paused ? '⏸️ Paused' : '▶️ Playing')
    : '💤 Idle';

  const inactivityText = (() => {
    const rem = getInactivityRemaining(state);
    return rem ? formatMs(rem) : '—';
  })();

  const lastUpdate = await loadLastUpdate();

  const embed = new EmbedBuilder()
    .setTitle('🩺 DJ DIKKAT Health')
    .setColor(0x2b6cb0)
    .setTimestamp();

  // ── Bot ──────────────────────────────────────────────────
  embed.addFields(
    { name: '📡 Discord Ping',   value: `${Math.round(client.ws.ping)}ms`,                                   inline: true },
    { name: '🎧 Voice Sessions', value: `${getActiveVoiceCount()}`,                                           inline: true },
    { name: '🎵 Status',         value: status,                                                               inline: true },
    { name: '🧠 CPU',            value: `${averageCpuPercent().toFixed(1)}%`,                                 inline: true },
    { name: '💾 RAM',            value: `${formatBytes(process.memoryUsage().rss)} / ${formatBytes(os.totalmem())}`, inline: true },
    { name: '🕒 Uptime',         value: formatUptime(process.uptime()),                                       inline: true }
  );

  // ── NodeLink ──────────────────────────────────────────────
  // `node` comes from pickNode(), which only returns a CONNECTED node; a node
  // Shoukaku still knows about but isn't connected to is mid-reconnect.
  const nodeState   = node
    ? '🟢 Connected'
    : (client.shoukaku?.nodes?.size ? '🟡 Reconnecting' : '🔴 Unavailable');
  const nodePing    = nodeStats && Number.isFinite(nodeStats.ping)
    ? `${nodeStats.ping}ms` : '—';
  const nodePlayers = nodeStats && Number.isFinite(nodeStats.players)
    ? `${nodeStats.players}` : '—';
  const nodeCpu     = nodeStats?.cpu && Number.isFinite(nodeStats.cpu.systemLoad)
    ? `${(nodeStats.cpu.systemLoad * 100).toFixed(1)}%` : '—';
  const nodeMem     = nodeStats?.memory && Number.isFinite(nodeStats.memory.used)
    ? formatBytes(nodeStats.memory.used) : '—';
  const nodeFrames  = nodeStats?.frameStats
    ? `deficit ${nodeStats.frameStats.deficit} / nulled ${nodeStats.frameStats.nulled}` : '—';

  embed.addFields(
    { name: '🎚️ NodeLink',     value: nodeState,   inline: true },
    { name: '📡 NL Ping',       value: nodePing,    inline: true },
    { name: '🎶 NL Players',    value: nodePlayers, inline: true },
    { name: '🔥 NL CPU',        value: nodeCpu,     inline: true },
    { name: '💾 NL Memory',     value: nodeMem,     inline: true },
    { name: '⚠️ Frame Stats',   value: nodeFrames,  inline: true }
  );

  // ── Playback ──────────────────────────────────────────────
  embed.addFields(
    { name: '📜 Queue',           value: `${state.queue.length} tracks`, inline: true },
    { name: '⏭️ Tracks / boot',  value: `${meta.tracksSinceBoot}`,      inline: true },
    { name: '💤 Inactivity left', value: inactivityText,                 inline: true }
  );

  // ── Services ──────────────────────────────────────────────
  embed.addFields(
    { name: '🧾 Stats written', value: meta.lastWriteTime ? timeAgo(meta.lastWriteTime.toISOString()) : '—', inline: true },
    { name: '🔥 Load Average',  value: os.loadavg().map(v => v.toFixed(2)).join(' / '),                       inline: true }
  );

  // ── Last Update ────────────────────────────────────────────
  embed.addFields({
    name:   '🔄 Last Update',
    value:  formatLastUpdate(lastUpdate),
    inline: false
  });

  return embed;
}

// ── Message builder ───────────────────────────────────────

async function buildHealthMessage(client, state, meta, node, userId, guildId) {
  const embed = await buildHealthEmbed(client, state, meta, node);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`dmremove:health:${userId}`)
      .setLabel('Remove')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`memreset:all:${guildId}:${userId}`)
      .setLabel('Reset Memory')
      .setEmoji('🧹')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`memreset:history:${guildId}:${userId}`)
      .setLabel('Reset History')
      .setEmoji('🧹')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`memreset:messages:${guildId}:${userId}`)
      .setLabel('Reset Messages')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger)
  );
  return { embeds: [embed], components: [row] };
}

// ── Exports ───────────────────────────────────────────────

module.exports = { buildHealthMessage };
