/************************************************************
 * DJ DIKKAT - Music Bot
 * Health card
 * DM health embed (/health), in the admin's language.
 * Author: Yanoee
 ************************************************************/
import os from 'node:os';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { Client } from 'discord.js';
import type { Node } from 'shoukaku';
import * as db from '../services/db.ts';
import { getInactivityRemaining, getActiveVoiceCount } from '../music/state.ts';
import type { GuildState } from '../music/state.ts';
import { formatMs } from './player-card.ts';
import { formatUptime } from '../lib/logger.ts';
import type { getStatsMeta } from '../services/stats.ts';
import { t } from '../i18n/index.ts';
import type { Locale } from '../i18n/index.ts';

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let b = bytes;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(1)} ${units[i]}`;
}

function timeAgo(date: Date | string | null, locale: Locale): string {
  if (!date) return '-';
  const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (!Number.isFinite(s) || s < 0) return '-';
  if (s < 60) return t(locale, 'time.seconds_ago', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t(locale, 'time.minutes_ago', { n: m });
  const h = Math.floor(m / 60);
  return h < 24 ? t(locale, 'time.hours_ago', { h, m: m % 60 }) : t(locale, 'time.days_ago', { d: Math.floor(h / 24), h: h % 24 });
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

async function formatLastUpdate(locale: Locale): Promise<string> {
  const [row] = await db.query<{ ts: Date; status: string; failed_at: string | null; nodelink_updated: number; commit_after: string | null }[]>(
    'SELECT ts, status, failed_at, nodelink_updated, commit_after FROM update_history ORDER BY ts DESC, id DESC LIMIT 1'
  ).catch(() => []);
  if (!row) return t(locale, 'health.update.none');
  const step = row.failed_at || t(locale, 'common.unknown');
  const status = row.status === 'success' ? t(locale, 'health.update.success')
    : row.status === 'recovered' ? t(locale, 'health.update.recovered', { step })
    : t(locale, 'health.update.failed', { step });
  const nodelink = row.nodelink_updated
    ? `${t(locale, 'health.update.nodelink_updated')}${row.commit_after ? ` → \`${row.commit_after}\`` : ''}`
    : t(locale, 'health.update.nodelink_same');
  return `${status} • ${timeAgo(row.ts, locale)}\n🎚️ NodeLink  ${nodelink}`;
}

async function buildHealthEmbed(
  client: Client, state: GuildState, meta: ReturnType<typeof getStatsMeta>, node: Node | null, locale: Locale
): Promise<EmbedBuilder> {
  const ns = node?.stats ?? null;
  const rem = getInactivityRemaining(state);
  // `node` comes from pickNode(), which only returns a CONNECTED node; one
  // Shoukaku still knows about but isn't connected to is mid-reconnect.
  const nodeState = node ? 'health.nodelink.connected' : (client.shoukaku.nodes.size ? 'health.nodelink.reconnecting' : 'health.nodelink.unavailable');
  const status = state.current ? (state.paused ? 'health.status.paused' : 'health.status.playing') : 'health.status.idle';

  return new EmbedBuilder()
    .setTitle(t(locale, 'health.title'))
    .setColor(0x2b6cb0)
    .setTimestamp()
    .addFields(
      // Bot
      { name: t(locale, 'health.ping'),    value: `${Math.round(client.ws.ping)}ms`, inline: true },
      { name: t(locale, 'health.voice'),   value: `${getActiveVoiceCount()}`, inline: true },
      { name: t(locale, 'health.status'),  value: t(locale, status), inline: true },
      { name: t(locale, 'health.cpu'),     value: `${averageCpuPercent().toFixed(1)}%`, inline: true },
      { name: t(locale, 'health.ram'),     value: `${formatBytes(process.memoryUsage().rss)} / ${formatBytes(os.totalmem())}`, inline: true },
      { name: t(locale, 'health.uptime'),  value: formatUptime(process.uptime()), inline: true },
      // NodeLink
      { name: t(locale, 'health.nodelink'), value: t(locale, nodeState), inline: true },
      // NodeLink adds `ping` to the Lavalink stats payload; Shoukaku's type doesn't know it
      { name: t(locale, 'health.nl_ping'),     value: ns && 'ping' in ns ? `${ns.ping}ms` : '-', inline: true },
      { name: t(locale, 'health.nl_players'),  value: ns ? `${ns.players}` : '-', inline: true },
      { name: t(locale, 'health.nl_cpu'),      value: ns ? `${(ns.cpu.systemLoad * 100).toFixed(1)}%` : '-', inline: true },
      { name: t(locale, 'health.nl_memory'),   value: ns ? formatBytes(ns.memory.used) : '-', inline: true },
      {
        name: t(locale, 'health.frames'),
        value: ns?.frameStats ? t(locale, 'health.frames.value', { deficit: ns.frameStats.deficit, nulled: ns.frameStats.nulled }) : '-',
        inline: true
      },
      // Playback
      { name: t(locale, 'health.queue'),          value: t(locale, 'card.tracks', { count: state.queue.length }), inline: true },
      { name: t(locale, 'health.tracks_boot'),    value: `${meta.tracksSinceBoot}`, inline: true },
      { name: t(locale, 'health.inactivity'),     value: rem ? formatMs(rem) : '-', inline: true },
      // Services
      { name: t(locale, 'health.stats_written'), value: timeAgo(meta.lastWriteTime, locale), inline: true },
      { name: t(locale, 'health.load'),          value: os.loadavg().map(v => v.toFixed(2)).join(' / '), inline: true },
      { name: t(locale, 'health.last_update'),   value: await formatLastUpdate(locale), inline: false }
    );
}

export async function buildHealthMessage(
  client: Client, state: GuildState, meta: ReturnType<typeof getStatsMeta>, node: Node | null, userId: string, guildId: string, locale: Locale
) {
  const button = (id: string, label: string, emoji: string, style: ButtonStyle) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);
  return {
    embeds: [await buildHealthEmbed(client, state, meta, node, locale)],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(`dmremove:health:${userId}`, t(locale, 'common.remove'), '🗑️', ButtonStyle.Secondary),
        button(`memreset:all:${guildId}:${userId}`, t(locale, 'health.reset_memory'), '🧹', ButtonStyle.Danger),
        button(`memreset:history:${guildId}:${userId}`, t(locale, 'health.reset_history'), '🧹', ButtonStyle.Danger),
        button(`memreset:messages:${guildId}:${userId}`, t(locale, 'health.reset_messages'), '🗑️', ButtonStyle.Danger)
      )
    ]
  };
}
