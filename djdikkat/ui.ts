/************************************************************
 * DJ DIKKAT - Music Bot
 * Player card
 * The "Now Playing" / idle card and its buttons
 * Build 5.2.0
 * Author: Yanoee
 ************************************************************/
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { Client, Message, SendableChannels } from 'discord.js';
import { getInactivityRemaining, clearIdleUiTimer } from './state.ts';
import type { GuildState } from './state.ts';
import { setUiMessage, getUiMessage, clearUiMessage } from './memory.ts';
import { logError } from './errors.ts';
import type { LastPlayed } from './types.ts';

const controllers = new Map<string, Message>();               // guildId -> card message
const controllerQueues = new Map<string, Promise<void>>();    // guildId -> pending card op
const QUEUE_TITLE_LIMIT = 25;
const NOW_PLAYING_TITLE_LIMIT = 50;
const IDLE_REFRESH_MS = 30 * 1000;

const COLORS = {
  youtube:    0xFF0000,
  spotify:    0x1DB954,
  soundcloud: 0xFF5500,
  paused:     0x4a5568,
  default:    0x2b6cb0
};
type Source = 'youtube' | 'spotify' | 'soundcloud' | 'default';

/** H:MM:SS or M:SS */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Fetch + delete one message by ID. Every failure is swallowed; true if deleted. */
export async function deleteMessage(client: Client | null, channelId: string, messageId: string): Promise<boolean> {
  if (!client) return false;
  const channel = client.channels.cache.get(channelId) ?? await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;
  const msg = await channel.messages.fetch(messageId).catch(() => null);
  return msg ? msg.delete().then(() => true, () => false) : false;
}

async function fetchSendable(client: Client, channelId: string): Promise<SendableChannels | null> {
  const channel = client.channels.cache.get(channelId) ?? await client.channels.fetch(channelId).catch(() => null);
  return channel?.isSendable() ? channel : null;
}

const truncate = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

export function truncateQueueTitle(title: string | undefined): string {
  return truncate((title || 'Unknown').trim(), QUEUE_TITLE_LIMIT);
}

function getSourceKey(uri: string | null | undefined): Source {
  if (!uri) return 'default';
  try {
    const host = new URL(uri).hostname.toLowerCase();
    if (host.includes('youtube') || host.includes('youtu.be')) return 'youtube';
    if (host.includes('spotify')) return 'spotify';
    if (host.includes('soundcloud')) return 'soundcloud';
  } catch {}
  return 'default';
}

function sourceLabel(uri: string | null | undefined): string {
  const key = getSourceKey(uri);
  if (key === 'youtube') return 'YouTube';
  if (key === 'spotify') return 'Spotify';
  if (key === 'soundcloud') return 'SoundCloud';
  try { return new URL(uri ?? '').hostname.replace(/^www\./, ''); } catch { return 'Unknown'; }
}

function getArtworkUrl(info: { artworkUrl?: string; uri?: string }): string | null {
  if (info.artworkUrl) return info.artworkUrl;
  if (getSourceKey(info.uri) !== 'youtube') return null;
  try {
    const url = new URL(info.uri!);
    const id = url.searchParams.get('v') || url.pathname.slice(1);
    return id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : null;
  } catch { return null; }
}

// Split "Artist - Song Name" YouTube titles into separate fields
function parseTrackMeta(title: string, uri: string | undefined): { artist: string | null; trackTitle: string } {
  if (getSourceKey(uri) === 'youtube') {
    const idx = title.indexOf(' - ');
    if (idx > 0 && idx < 40) return { artist: title.slice(0, idx).trim(), trackTitle: title.slice(idx + 3).trim() };
  }
  return { artist: null, trackTitle: title || 'Unknown title' };
}

const who = (t: { requesterId?: string; requesterTag?: string }) =>
  t.requesterId ? `<@${t.requesterId}>` : (t.requesterTag || 'Unknown');

function buildEmbed(state: GuildState): EmbedBuilder {
  // Idle
  if (!state.current) {
    const embed = new EmbedBuilder()
      .setTitle('💤 Dakka Records')
      .setColor(COLORS.default)
      .setDescription('**No music is playing...**\nUse `/play` to start something!');
    if (state.lastPlayed?.title) {
      const title = truncate(state.lastPlayed.title, NOW_PLAYING_TITLE_LIMIT);
      embed.addFields({ name: '⏮️ Last played', value: state.lastPlayed.uri ? `[${title}](${state.lastPlayed.uri})` : title });
    }
    const remaining = getInactivityRemaining(state);
    if (remaining) embed.setFooter({ text: `⏳ Auto-disconnect in ${formatMs(remaining)}` });
    return embed;
  }

  // Playing / paused
  const info = state.current.info;
  const uri = info.uri;
  const { artist, trackTitle } = parseTrackMeta(info.title, uri);
  const displayTitle = truncate(trackTitle, NOW_PLAYING_TITLE_LIMIT);
  const trackLink = uri ? `[${displayTitle}](${uri})` : displayTitle;
  const src = sourceLabel(uri);
  const artwork = getArtworkUrl(info);

  const embed = new EmbedBuilder()
    .setTitle(`${state.paused ? '⏸️' : '▶️'} Dakka Records Sunar:`)
    .setColor(state.paused ? COLORS.paused : COLORS[getSourceKey(uri)])
    .setDescription(state.paused ? `**⏸️ PAUSED**\n${trackLink}` : `**Now Playing:**\n${trackLink}`);
  if (artwork) embed.setThumbnail(artwork);

  embed.addFields(
    { name: '⏱️ Length', value: info.length ? formatMs(info.length) : 'Live', inline: true },
    { name: '🙋 Requested by', value: who(state.current), inline: true },
    ...(artist ? [{ name: '🎤 Artist', value: artist, inline: true }] : []),
    { name: '🔁 Loop', value: state.loopCurrent ? 'Track' : state.loopQueue ? 'Queue' : 'Off', inline: true },
    { name: '🌐 Source', value: src, inline: true },
    { name: '📜 Queue', value: `${state.queue.length} track(s)`, inline: true }
  );

  // Up next: top 3
  const next = state.queue.slice(0, 3);
  if (next.length) {
    const lines = next.map((t, i) => {
      const title = truncateQueueTitle(t.info.title);
      return `${i + 1}. ${t.info.uri ? `[${title}](${t.info.uri})` : title} — ${who(t)}`;
    });
    const more = state.queue.length > 3 ? `\n*(+${state.queue.length - 3} more)*` : '';
    embed.addFields({ name: '⏭️ Up next', value: lines.join('\n') + more });
  }

  embed.setFooter({ text: state.queue.length ? `${state.queue.length} track(s) remaining • ${src}` : `Last track • ${src}` });
  return embed;
}

function startIdleRefresh(guildId: string, state: GuildState): void {
  if (state.idleUiTimer) return;
  state.idleUiTimer = setInterval(() => {
    if (state.current) clearIdleUiTimer(state);
    else upsertController(guildId, state);
  }, IDLE_REFRESH_MS);
}

async function resolveControllerMessage(guildId: string, client: Client | null): Promise<Message | null> {
  const cached = controllers.get(guildId);
  if (cached) return cached;
  const { messageId, channelId } = getUiMessage(guildId);
  if (!client || !messageId || !channelId) return null;

  const channel = client.channels.cache.get(channelId) ?? await client.channels.fetch(channelId).catch(() => null);
  const msg = channel?.isTextBased() ? await channel.messages.fetch(messageId).catch(() => null) : null;
  if (!msg) {
    clearUiMessage(guildId);
    return null;
  }
  controllers.set(guildId, msg);
  return msg;
}

function buildIdleButtons(guildId: string, lastPlayed: LastPlayed | null) {
  if (!lastPlayed?.title) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`music:replay:${guildId}`).setLabel('Play Again').setEmoji('⏮️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`music:disconnect:${guildId}`).setEmoji('🔌').setStyle(ButtonStyle.Danger)
    )
  ];
}

/**
 * Row 1: [⏸/▶ Pause] [⏭ Skip] [⏹ Stop]
 * Row 2: [🔁/🔂 Loop] [🔀 Shuffle] [📜 Queue] [🧹 Clear]
 */
function buildButtons(guildId: string, state: GuildState) {
  const button = (action: string, emoji: string, style: ButtonStyle) =>
    new ButtonBuilder().setCustomId(`music:${action}:${guildId}`).setEmoji(emoji).setStyle(style);
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button('toggle', state.paused ? '▶️' : '⏸️', state.paused ? ButtonStyle.Success : ButtonStyle.Primary),
      button('skip', '⏭️', ButtonStyle.Secondary),
      button('stop', '⏹️', ButtonStyle.Danger)
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button('loop', state.loopCurrent ? '🔂' : '🔁', state.loopCurrent || state.loopQueue ? ButtonStyle.Success : ButtonStyle.Secondary),
      button('shuffle', '🔀', ButtonStyle.Secondary),
      button('queue', '📜', ButtonStyle.Secondary),
      button('clearqueue', '🧹', ButtonStyle.Secondary)
    )
  ];
}

// ── Per-guild controller queue ──────────────────────────────────
// Every card operation (upsert / repost / remove) runs after the previous one
// for that guild has settled, so e.g. Skip's edit and the end event's repost
// can't interleave and leave two cards behind.
function enqueueController(guildId: string, what: string, fn: () => Promise<void>): Promise<void> {
  const next = (controllerQueues.get(guildId) ?? Promise.resolve())
    .then(fn)
    .catch(err => { logError(err, { guildId, during: `controller ${what}` }); })
    .finally(() => { if (controllerQueues.get(guildId) === next) controllerQueues.delete(guildId); });
  controllerQueues.set(guildId, next);
  return next;
}

async function postCard(guildId: string, channel: SendableChannels, payload: Parameters<SendableChannels['send']>[0]): Promise<Message | null> {
  const msg = await channel.send(payload).catch(() => null);
  if (msg) {
    controllers.set(guildId, msg);
    setUiMessage(guildId, channel.id, msg.id);
  }
  return msg;
}

/** Create or update the card in place. */
export function upsertController(guildId: string, state: GuildState): Promise<void> {
  return enqueueController(guildId, 'upsert', async () => {
    if (!state.player || !state.textChannelId || !state.client) return;
    const channel = await fetchSendable(state.client, state.textChannelId);
    if (!channel) return;

    const payload = {
      embeds: [buildEmbed(state)],
      components: state.current ? buildButtons(guildId, state) : buildIdleButtons(guildId, state.lastPlayed)
    };
    if (state.current) clearIdleUiTimer(state);
    else startIdleRefresh(guildId, state);

    const current = await resolveControllerMessage(guildId, state.client);
    if (!current) {
      await postCard(guildId, channel, payload);
      return;
    }
    if (await current.edit(payload).then(() => true, () => false)) return;

    // Edit failed — send a replacement first, then delete the old card
    controllers.delete(guildId);
    if (await postCard(guildId, channel, payload)) await current.delete().catch(() => {});
    else controllers.set(guildId, current);
  });
}

/** Recreate the card at the bottom of the channel (new track). */
export function repostController(guildId: string, state: GuildState): Promise<void> {
  return enqueueController(guildId, 'repost', async () => {
    if (!state.player || !state.textChannelId || !state.client) return;
    clearIdleUiTimer(state);
    const channel = await fetchSendable(state.client, state.textChannelId);
    if (!channel) return;

    const current = await resolveControllerMessage(guildId, state.client);
    if (current) {
      await current.delete().catch(() => {});
      controllers.delete(guildId);
      clearUiMessage(guildId);
    }
    await postCard(guildId, channel, { embeds: [buildEmbed(state)], components: buildButtons(guildId, state) });
  });
}

export function removeController(guildId: string, client: Client | null): Promise<void> {
  return enqueueController(guildId, 'remove', async () => {
    const current = controllers.get(guildId) ?? await resolveControllerMessage(guildId, client);
    if (current) {
      await current.delete().catch(() => {});
      controllers.delete(guildId);
    }
    clearUiMessage(guildId);
  });
}
