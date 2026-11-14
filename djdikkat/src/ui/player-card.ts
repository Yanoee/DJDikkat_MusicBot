/************************************************************
 * DJ DIKKAT - Music Bot
 * Player card
 * The "Now Playing" / idle card and its buttons, in the
 * guild's language. Discord components v2, the website's
 * player look: one framed container (the server's accent)
 * with the wide picture, one small line and the controls,
 * redrawn every 15 s so the progress bar moves.
 * Author: Yanoee
 ************************************************************/
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder,
  MessageFlags, SectionBuilder, SeparatorBuilder, SeparatorSpacingSize, StringSelectMenuBuilder, TextDisplayBuilder, ThumbnailBuilder
} from 'discord.js';
import { FILTERS } from '../music/filters.ts';
import type { Client, Message, SendableChannels } from 'discord.js';
import { getInactivityRemaining, clearIdleUiTimer } from '../music/state.ts';
import type { GuildState } from '../music/state.ts';
import { setUiMessage, getUiMessage, clearUiMessage, getGuildMemory } from '../services/memory.ts';
import { guildLocaleVia } from '../services/locale.ts';
import { logError } from '../lib/errors.ts';
import { renderNowPlaying } from './np-image.ts';
import { t } from '../i18n/index.ts';
import { getFeatures, getTransitions } from '../services/features.ts';
import type { Locale } from '../i18n/index.ts';
import { config } from '../config.ts';

const controllers = new Map<string, Message>();               // guildId -> card message
const controllerQueues = new Map<string, Promise<void>>();    // guildId -> pending card op
const QUEUE_TITLE_LIMIT = 25;
const NOW_PLAYING_TITLE_LIMIT = 50;
const CARD_REFRESH_MS = 15 * 1000;
const WEB_ACTOR_SHOWN_MS = 5 * 60 * 1000;

// Website rust theme (website/core/assets/rust.css)
const COLORS = {
  playing: 0x3b82c4,
  paused:  0x5e5a54,
  default: 0x3b82c4
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
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;
  const msg = await channel.messages.fetch(messageId).catch(() => null);
  return msg ? msg.delete().then(() => true, () => false) : false;
}

async function fetchSendable(client: Client, channelId: string): Promise<SendableChannels | null> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  return channel?.isSendable() ? channel : null;
}

const truncate = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

export function truncateQueueTitle(title: string | undefined): string {
  return truncate((title || '?').trim(), QUEUE_TITLE_LIMIT);
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

const SOURCE_LABELS: Partial<Record<Source, string>> = { youtube: 'YouTube', spotify: 'Spotify', soundcloud: 'SoundCloud' };

function sourceLabel(uri: string | null | undefined, locale: Locale): string {
  const label = SOURCE_LABELS[getSourceKey(uri)];
  if (label) return label;
  try { return new URL(uri ?? '').hostname.replace(/^www\./, ''); } catch { return t(locale, 'common.unknown'); }
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
function parseTrackMeta(title: string, uri: string | undefined): { artist: string | null; trackTitle: string | null } {
  if (getSourceKey(uri) === 'youtube') {
    const idx = title.indexOf(' - ');
    if (idx > 0 && idx < 40) return { artist: title.slice(0, idx).trim(), trackTitle: title.slice(idx + 3).trim() };
  }
  return { artist: null, trackTitle: title || null };
}

/** Seed titles in "Autoplay · like {title}": long enough to recognise, short enough for one line. */
const AUTOPLAY_FROM_LIMIT = 40;
const autoplayFrom = (track: { autoplayFrom?: string }) =>
  track.autoplayFrom?.trim() ? truncate(track.autoplayFrom.trim(), AUTOPLAY_FROM_LIMIT) : null;

const who = (track: { requesterId?: string; requesterTag?: string; autoplayFrom?: string }, locale: Locale) => {
  if (track.requesterId) return `<@${track.requesterId}>`;
  const from = autoplayFrom(track);
  return from ? t(locale, 'card.autoplay_from', { title: from }) : (track.requesterTag || t(locale, 'common.unknown'));
};

const NP_IMAGE = 'np.png';
const text = (content: string) => new TextDisplayBuilder().setContent(content);
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const link = (title: string, uri: string | null | undefined) => uri ? `[${title}](${uri})` : title;
/** Discord draws <t:…:R> as "in 3 minutes" and counts it down by itself, no edits needed. */
const countdown = (atMs: number) => `<t:${Math.floor(atMs / 1000)}:R>`;
const row = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

// ── Icons ─────────────────────────────────────────────────
// The website's Font Awesome player icons, uploaded once as the bot's own app emojis
// (djd_pause, djd_skip, …) and looked up by name at startup. Unicode emoji until then.
const icons = new Map<string, string>();   // emoji name -> id

export async function loadCardIcons(client: Pick<Client<true>, 'application'>): Promise<void> {
  const emojis = await client.application.emojis.fetch().catch(() => null);
  for (const emoji of emojis?.values() ?? []) if (emoji.name?.startsWith('djd_')) icons.set(emoji.name, emoji.id);
}

export function cardIcon(name: string, fallback: string): string | { id: string; name: string } {
  const id = icons.get(`djd_${name}`);
  return id ? { id, name: `djd_${name}` } : fallback;
}

export function panelButton(guildId: string, locale: Locale) {
  return new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(locale, 'card.btn.panel')).setEmoji(cardIcon('panel', '🖥️'))
    .setURL(`${config.publicUrl}/dashboard/${guildId}`);
}

function idleCard(guildId: string, state: GuildState, locale: Locale): ContainerBuilder {
  const accent = getGuildMemory(guildId).settings.cardAccent;
  const card = new ContainerBuilder().setAccentColor(accent ? parseInt(accent.slice(1), 16) : COLORS.default).addTextDisplayComponents(text(`-# ${t(locale, 'card.brand')}`));
  const head = text(`## ${t(locale, 'card.idle.title')}\n${t(locale, 'card.idle.body')}`);
  const avatar = state.client?.user?.displayAvatarURL({ size: 128 });
  if (avatar) card.addSectionComponents(new SectionBuilder().addTextDisplayComponents(head).setThumbnailAccessory(new ThumbnailBuilder().setURL(avatar)));
  else card.addTextDisplayComponents(head);

  const last = state.lastPlayed;
  if (last?.title) {
    card.addSeparatorComponents(line())
      .addTextDisplayComponents(text(`**${t(locale, 'card.last_played')}**\n${link(truncate(last.title, NOW_PLAYING_TITLE_LIMIT), last.uri)}`));
  }
  if (getInactivityRemaining(state) && state.inactivityUntil) {
    card.addTextDisplayComponents(text(`-# ${t(locale, 'card.leaving', { time: countdown(state.inactivityUntil) })}`));
  }
  const buttons = last?.title ? [
    new ButtonBuilder().setCustomId(`music:replay:${guildId}`).setLabel(t(locale, 'card.play_again')).setEmoji(cardIcon('replay', '⏮️')).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`music:disconnect:${guildId}`).setLabel(t(locale, 'card.btn.leave')).setEmoji(cardIcon('leave', '🔌')).setStyle(ButtonStyle.Danger)
  ] : [];
  return card.addActionRowComponents(row(...buttons, panelButton(guildId, locale)));
}

const plain = (label: string) => label.replace(/^[^\p{L}\p{N}]+/u, '').trim();

/**
 * What's switched on, for the picture's chips: crossfade, effect, autoplay, loop (words only, no emoji).
 * Drawn right to left and the leftmost ones dropped when out of room, so crossfade goes first: it's dropped first.
 */
function statusChips(guildId: string, state: GuildState, locale: Locale): string[] {
  const transitions = getTransitions(guildId);
  return [
    transitions.enabled && transitions.crossfadeS > 0 ? t(locale, 'card.crossfade', { seconds: transitions.crossfadeS }) : null,
    state.filter ? t(locale, `fx.${state.filter}`) : null,
    getFeatures(guildId).autoplay.enabled ? t(locale, 'card.chip.autoplay') : null,
    state.loopCurrent ? t(locale, 'card.chip.loop_song') : state.loopQueue ? t(locale, 'card.chip.loop_queue') : null
  ].filter((c): c is string => !!c).map(plain);
}

/** The picture, one small line (who asked, what's next) and the controls; the website's player look. */
function playingCard(guildId: string, state: GuildState, current: NonNullable<GuildState['current']>, locale: Locale, withImage: boolean): ContainerBuilder {
  const { info } = current;
  const accent = getGuildMemory(guildId).settings.cardAccent;
  const card = new ContainerBuilder().setAccentColor(state.paused ? COLORS.paused : accent ? parseInt(accent.slice(1), 16) : COLORS.playing);

  // Without the picture, title and artist go in text.
  if (withImage) card.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${NP_IMAGE}`)));
  else {
    const { artist, trackTitle } = parseTrackMeta(info.title, info.uri);
    card.addTextDisplayComponents(text(`### ${link(truncate(trackTitle ?? t(locale, 'card.unknown_title'), NOW_PLAYING_TITLE_LIMIT), info.uri)}${artist ? `\n${artist}` : ''}`));
  }

  const [next] = state.queue;
  const meta = [
    withImage ? null : `🙋 ${who(current, locale)}`,
    next ? `${t(locale, 'card.next', { title: link(truncateQueueTitle(next.info.title), next.info.uri) })}${state.queue.length > 1 ? ` ${t(locale, 'card.more', { count: state.queue.length - 1 })}` : ''}` : null,
    // In the picture's chips when there is a picture
    !withImage && state.filter ? t(locale, 'card.fx', { name: t(locale, `fx.${state.filter}`) }) : null,
    !withImage && getFeatures(guildId).autoplay.enabled ? t(locale, 'card.autoplay') : null,
    state.webActor && Date.now() - state.webActor.at < WEB_ACTOR_SHOWN_MS ? t(locale, 'card.via_web', { name: state.webActor.name }) : null
  ].filter(Boolean).join('  ·  ');
  if (meta) card.addTextDisplayComponents(text(`-# ${meta}`));   // can be empty: nothing next, requester in the picture
  return card.addSeparatorComponents(line()).addActionRowComponents(...buildButtons(guildId, state, locale).map(r => r.toJSON()));
}

/** The card (components v2) with its rendered picture. Falls back to text if rendering fails. */
export async function buildPayload(guildId: string, state: GuildState, locale: Locale) {
  // Mentions in the card never ping; `attachments: []` drops the old picture on edit.
  const base = { flags: MessageFlags.IsComponentsV2 as const, allowedMentions: { parse: [] }, attachments: [] };
  if (!state.current) return { ...base, components: [idleCard(guildId, state, locale)], files: [] };

  // Kept: the track can be stopped while the picture renders.
  const current = state.current;
  const { info, requesterId, requesterTag } = current;
  const { artist, trackTitle } = parseTrackMeta(info.title, info.uri);
  const member = state.client?.guilds.cache.get(guildId)?.members.cache.get(requesterId);
  // Autoplay picks say which song they follow; the picture shortens just that title to fit.
  const from = requesterId ? null : autoplayFrom(current);
  const png = await renderNowPlaying({
    title: trackTitle ?? t(locale, 'card.unknown_title'),
    artist: artist ?? info.author ?? null,
    artworkUrl: getArtworkUrl(info),
    positionMs: state.player?.position ?? 0,
    lengthMs: info.isStream ? 0 : info.length,
    paused: state.paused,
    label: t(locale, state.paused ? 'card.img.paused' : 'card.img.playing'),
    liveLabel: t(locale, 'card.live'),
    source: sourceLabel(info.uri, locale),
    accent: getGuildMemory(guildId).settings.cardAccent,
    requester: from
      ? { name: t(locale, 'card.autoplay_from', { title: '{title}' }), title: from, avatarUrl: null, label: t(locale, 'card.requested_by') }
      : requesterTag ? { name: member?.displayName ?? requesterTag, avatarUrl: member?.displayAvatarURL({ extension: 'png', size: 128 }) ?? null, label: t(locale, 'card.requested_by') } : null,
    chips: statusChips(guildId, state, locale),
    locale
  }).catch(err => { logError(err, { guildId, during: 'render now-playing image' }); return null; });
  return {
    ...base,
    components: [playingCard(guildId, state, current, locale, !!png)],
    files: png ? [new AttachmentBuilder(png, { name: NP_IMAGE })] : []
  };
}

/**
 * Redraws the card every 15 s while the progress bar moves, and while idle (the leave
 * countdown can start after the last edit). Nothing to redraw while paused or live.
 */
function syncCardRefresh(guildId: string, state: GuildState): void {
  if (state.current && (state.paused || state.current.info.isStream)) return clearIdleUiTimer(state);
  if (state.idleUiTimer) return;
  state.idleUiTimer = setInterval(() => upsertController(guildId, state), CARD_REFRESH_MS);
}

async function resolveControllerMessage(guildId: string, client: Client | null): Promise<Message | null> {
  const cached = controllers.get(guildId);
  if (cached) return cached;
  const { messageId, channelId } = getUiMessage(guildId);
  if (!client || !messageId || !channelId) return null;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  const msg = channel?.isTextBased() ? await channel.messages.fetch(messageId).catch(() => null) : null;
  if (!msg) {
    clearUiMessage(guildId);
    return null;
  }
  controllers.set(guildId, msg);
  return msg;
}

const FX_EMOJI: Record<string, string> = {
  off: '⭕', bass: '🔊', nightcore: '⚡', vaporwave: '🌴', slowed: '🐢', '8d': '🎧', karaoke: '🎤', soft: '☁️', treble: '🔔', echo: '🌊'
};

/** The effect picker (the current one shown as picked); same as /filter. */
function effectMenu(guildId: string, state: GuildState, locale: Locale) {
  const current = state.filter ?? 'off';
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`fx:${guildId}`)
    .setPlaceholder(t(locale, 'card.fx_pick'))
    .addOptions((['off', ...FILTERS] as const).map(f => ({ label: t(locale, `fx.${f}`), value: f, emoji: FX_EMOJI[f], default: f === current }))));
}

/**
 * Icons first, like the website's player: [⏸] [⏭] [⏹] [🔁] [☰], then the effect picker,
 * then Autoplay, Add to playlist and the web panel. Shuffle and Clear live in the queue view.
 */
function buildButtons(guildId: string, state: GuildState, locale: Locale) {
  const button = (action: string, emoji: ReturnType<typeof cardIcon>, style: ButtonStyle) =>
    new ButtonBuilder().setCustomId(`music:${action}:${guildId}`).setEmoji(emoji).setStyle(style);
  const loop = button('loop', cardIcon('loop', state.loopCurrent ? '🔂' : '🔁'), state.loopCurrent || state.loopQueue ? ButtonStyle.Success : ButtonStyle.Secondary);
  if (state.loopCurrent) loop.setLabel('1');   // looping this one track, not the queue
  return [row(
    button('toggle', state.paused ? cardIcon('play', '▶️') : cardIcon('pause', '⏸️'), state.paused ? ButtonStyle.Success : ButtonStyle.Primary),
    button('skip', cardIcon('skip', '⏭️'), ButtonStyle.Secondary),
    button('stop', cardIcon('stop', '⏹️'), ButtonStyle.Danger),
    loop,
    button('queue', cardIcon('queue', '📜'), ButtonStyle.Secondary)
  ), effectMenu(guildId, state, locale), row(
    button('autoplay', cardIcon('autoplay', '♾️'), getFeatures(guildId).autoplay.enabled ? ButtonStyle.Success : ButtonStyle.Secondary).setLabel(t(locale, 'card.btn.autoplay')),
    button('pladd', cardIcon('plus', '➕'), ButtonStyle.Secondary).setLabel(t(locale, 'card.btn.pladd')),
    panelButton(guildId, locale)
  )];
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

    const locale = guildLocaleVia(state.client, guildId);
    const payload = await buildPayload(guildId, state, locale);
    syncCardRefresh(guildId, state);

    const current = await resolveControllerMessage(guildId, state.client);
    if (!current) {
      await postCard(guildId, channel, payload);
      return;
    }
    // Cards from before components v2 can't be edited into one: replace those.
    if (current.flags.has(MessageFlags.IsComponentsV2) && await current.edit(payload).then(() => true, () => false)) return;

    // Edit failed: send a replacement first, then delete the old card
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
    const locale = guildLocaleVia(state.client, guildId);
    await postCard(guildId, channel, await buildPayload(guildId, state, locale));
    syncCardRefresh(guildId, state);
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
