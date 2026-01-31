/************************************************************
 * DJ DIKKAT - Music Bot
 * Health reporter
 * DM health embed builder
 * Build 2.0.7
 * Author: Yanoee
 ************************************************************/

const os = require('os');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getInactivityRemaining, getActiveVoiceCount } = require('./state');

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let b = bytes;
  while (b >= 1024 && i < units.length - 1) {
    b /= 1024;
    i += 1;
  }
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

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

let lastCpu = process.cpuUsage();
let lastCpuTime = Date.now();

function averageCpuPercent() {
  const now = Date.now();
  const elapsedMs = now - lastCpuTime;
  if (elapsedMs <= 0) return 0;
  const current = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  lastCpuTime = now;

  const usedMs = (current.user + current.system) / 1000;
  const cores = os.cpus().length || 1;
  const pct = (usedMs / (elapsedMs * cores)) * 100;
  return Number.isFinite(pct) ? pct : 0;
}

function buildHealthEmbed(client, state, meta, node) {
  const nodeStats = node && node.stats ? node.stats : null;
  const status = state.current
    ? (state.paused ? 'Paused' : 'Playing')
    : 'Idle';

  const inactivity = getInactivityRemaining(state);
  const inactivityText = inactivity ? formatMs(inactivity) : '—';

  const embed = new EmbedBuilder()
    .setTitle('🩺 DJ DIKKAT Health')
    .setColor(0x2b6cb0);

  embed.addFields(
    { name: '📡 Discord Ping', value: `${Math.round(client.ws.ping)}ms`, inline: true },
    { name: '🎧 Voice Sessions', value: `${getActiveVoiceCount()}`, inline: true },
    { name: '🎵 Status', value: status, inline: true },
    { name: '🧠 CPU', value: `${averageCpuPercent().toFixed(1)}%`, inline: true },
    { name: '💾 RAM', value: `${formatBytes(process.memoryUsage().rss)} / ${formatBytes(os.totalmem())}`, inline: true },
    { name: '🕒 Uptime', value: formatUptime(process.uptime()), inline: true }
  );

  const nodeState = node ? (node.state === 2 ? 'Connected' : 'Reconnecting') : 'Unavailable';
  const nodePing = nodeStats && Number.isFinite(nodeStats.ping) ? `${nodeStats.ping}ms` : '—';
  const nodePlayers = nodeStats && Number.isFinite(nodeStats.players) ? `${nodeStats.players}` : '—';
  const nodeCpu = nodeStats && nodeStats.cpu && Number.isFinite(nodeStats.cpu.systemLoad)
    ? `${(nodeStats.cpu.systemLoad * 100).toFixed(1)}%`
    : '—';
  const nodeMem = nodeStats && nodeStats.memory && Number.isFinite(nodeStats.memory.used)
    ? formatBytes(nodeStats.memory.used)
    : '—';
  const nodeFrames = nodeStats && nodeStats.frameStats
    ? `deficit ${nodeStats.frameStats.deficit} / nulled ${nodeStats.frameStats.nulled}`
    : '—';

  embed.addFields(
    { name: '🎚️ Lavalink Status', value: nodeState, inline: true },
    { name: '📡 Lavalink Ping', value: nodePing, inline: true },
    { name: '🎶 Players', value: nodePlayers, inline: true },
    { name: '🔥 Lavalink CPU', value: nodeCpu, inline: true },
    { name: '💾 Lavalink Memory', value: nodeMem, inline: true },
    { name: '⚠️ Frame Stats', value: nodeFrames, inline: true }
  );

  embed.addFields(
    { name: '📜 Queue', value: `${state.queue.length} tracks`, inline: true },
    { name: '⏭️ Tracks since boot', value: `${meta.tracksSinceBoot}`, inline: true },
    { name: '💤 Inactivity left', value: inactivityText, inline: true }
  );

  if (meta.lastWriteTime) {
    embed.addFields({ name: '🧾 Stats last write', value: meta.lastWriteTime.toISOString(), inline: false });
  }

  embed.addFields({
    name: '🔥 Load Average',
    value: os.loadavg().map(v => v.toFixed(2)).join(' / '),
    inline: false
  });

  return embed;
}

module.exports = {
  buildHealthEmbed,
  buildHealthMessage
};

function buildHealthMessage(client, state, meta, node, userId, guildId) {
  const embed = buildHealthEmbed(client, state, meta, node);
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
      .setStyle(ButtonStyle.Danger)
    ,
    new ButtonBuilder()
      .setCustomId(`memreset:messages:${guildId}:${userId}`)
      .setLabel('Reset Messages')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger)
  );
  return { embeds: [embed], components: [row] };
}
