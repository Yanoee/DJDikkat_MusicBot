/************************************************************
 * DJ DIKKAT - Music Bot
 * Health reporter
 * DM health embed builder (/health)
 * Build 5.2.0
 * Author: Yanoee
 ************************************************************/
import os from 'node:os';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { Client } from 'discord.js';
import type { Node } from 'shoukaku';
import * as db from './db.ts';
import { getInactivityRemaining, getActiveVoiceCount } from './state.ts';
import type { GuildState } from './state.ts';
import { formatMs } from './ui.ts';
import type { getStatsMeta } from './stats.ts';

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let b = bytes;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(1)} ${units[i]}`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds / 3600) % 24);
  const m = Math.floor((seconds / 60) % 60);
  const s = Math.floor(seconds % 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(' ');
}

function timeAgo(date: Date | string | null): string {
  if (!date) return '—';
  const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ${h % 24}h ago`;
}

// Process CPU % since the previous call
let lastCpu = process.cpuUsage();
let lastCpuTime = Date.now();
function averageCpuPercent(): number {
  const now = Date.now();
  const elapsedMs = now - lastCpuTime;
  if (elapsedMs <= 0) return 0;
  const used = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  lastCpuTime = now;
  return ((used.user + used.system) / 1000) / (elapsedMs * os.availableParallelism()) * 100;
}

async function formatLastUpdate(): Promise<string> {
  const [row] = await db.query<{ ts: Date; status: string; failed_at: string | null; nodelink_updated: number; commit_after: string | null }[]>(
    'SELECT ts, status, failed_at, nodelink_updated, commit_after FROM update_history ORDER BY ts DESC, id DESC LIMIT 1'
  ).catch(() => []);
  if (!row) return '*No update recorded yet.*';
  const status = row.status === 'success' ? '✅ Success'
    : row.status === 'recovered' ? `⚠️ Recovered (at: **${row.failed_at || 'unknown'}**)`
    : `❌ Failed at: **${row.failed_at || 'unknown'}**`;
  const nodelink = row.nodelink_updated ? `🔄 updated${row.commit_after ? ` → \`${row.commit_after}\`` : ''}` : '✔️ no change';
  return `${status} • ${timeAgo(row.ts)}\n🎚️ NodeLink  ${nodelink}`;
}

async function buildHealthEmbed(client: Client, state: GuildState, meta: ReturnType<typeof getStatsMeta>, node: Node | null): Promise<EmbedBuilder> {
  const ns = node?.stats ?? null;
  const rem = getInactivityRemaining(state);
  // `node` comes from pickNode(), which only returns a CONNECTED node; one
  // Shoukaku still knows about but isn't connected to is mid-reconnect.
  const nodeState = node ? '🟢 Connected' : (client.shoukaku.nodes.size ? '🟡 Reconnecting' : '🔴 Unavailable');

  return new EmbedBuilder()
    .setTitle('🩺 DJ DIKKAT Health')
    .setColor(0x2b6cb0)
    .setTimestamp()
    .addFields(
      // Bot
      { name: '📡 Discord Ping',   value: `${Math.round(client.ws.ping)}ms`, inline: true },
      { name: '🎧 Voice Sessions', value: `${getActiveVoiceCount()}`, inline: true },
      { name: '🎵 Status',         value: state.current ? (state.paused ? '⏸️ Paused' : '▶️ Playing') : '💤 Idle', inline: true },
      { name: '🧠 CPU',            value: `${averageCpuPercent().toFixed(1)}%`, inline: true },
      { name: '💾 RAM',            value: `${formatBytes(process.memoryUsage().rss)} / ${formatBytes(os.totalmem())}`, inline: true },
      { name: '🕒 Uptime',         value: formatUptime(process.uptime()), inline: true },
      // NodeLink
      { name: '🎚️ NodeLink',      value: nodeState, inline: true },
      // NodeLink adds `ping` to the Lavalink stats payload; Shoukaku's type doesn't know it
      { name: '📡 NL Ping',        value: ns && 'ping' in ns ? `${ns.ping}ms` : '—', inline: true },
      { name: '🎶 NL Players',     value: ns ? `${ns.players}` : '—', inline: true },
      { name: '🔥 NL CPU',         value: ns ? `${(ns.cpu.systemLoad * 100).toFixed(1)}%` : '—', inline: true },
      { name: '💾 NL Memory',      value: ns ? formatBytes(ns.memory.used) : '—', inline: true },
      { name: '⚠️ Frame Stats',    value: ns?.frameStats ? `deficit ${ns.frameStats.deficit} / nulled ${ns.frameStats.nulled}` : '—', inline: true },
      // Playback
      { name: '📜 Queue',           value: `${state.queue.length} tracks`, inline: true },
      { name: '⏭️ Tracks / boot',  value: `${meta.tracksSinceBoot}`, inline: true },
      { name: '💤 Inactivity left', value: rem ? formatMs(rem) : '—', inline: true },
      // Services
      { name: '🧾 Stats written', value: timeAgo(meta.lastWriteTime), inline: true },
      { name: '🔥 Load Average',  value: os.loadavg().map(v => v.toFixed(2)).join(' / '), inline: true },
      { name: '🔄 Last Update',   value: await formatLastUpdate(), inline: false }
    );
}

export async function buildHealthMessage(client: Client, state: GuildState, meta: ReturnType<typeof getStatsMeta>, node: Node | null, userId: string, guildId: string) {
  const button = (id: string, label: string, emoji: string, style: ButtonStyle) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);
  return {
    embeds: [await buildHealthEmbed(client, state, meta, node)],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(`dmremove:health:${userId}`, 'Remove', '🗑️', ButtonStyle.Secondary),
        button(`memreset:all:${guildId}:${userId}`, 'Reset Memory', '🧹', ButtonStyle.Danger),
        button(`memreset:history:${guildId}:${userId}`, 'Reset History', '🧹', ButtonStyle.Danger),
        button(`memreset:messages:${guildId}:${userId}`, 'Reset Messages', '🗑️', ButtonStyle.Danger)
      )
    ]
  };
}
