/************************************************************
 * DJ DIKKAT - Music Bot
 * Announcements
 * Weekly announcement, admin broadcasts and the owner welcome
 * DM, each in the guild's language.
 * Author: Yanoee
 ************************************************************/
import {
  AuditLogEvent, AttachmentBuilder, EmbedBuilder, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder,
  MediaGalleryBuilder, MessageFlags, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder
} from 'discord.js';
import type { Client, Guild, GuildBasedChannel, SendableChannels } from 'discord.js';
import { getGuildMemory, setGuildSettings } from './memory.ts';
import type { GuildSettings } from './memory.ts';
import { guildLocale } from './locale.ts';
import { errMsg } from '../lib/errors.ts';
import { config } from '../config.ts';
import { t } from '../i18n/index.ts';
import { buildSetupCard } from '../ui/setup-card.ts';
import { renderSupport } from '../ui/banner-image.ts';
import { getFeatures } from './features.ts';
import type { Locale } from '../i18n/index.ts';

const ANNOUNCEMENT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const issuesUrl = () => `${config.links.github}/issues`;

const IMAGE = 'support.png';
const banners = new Map<Locale, Promise<Buffer>>();

/** The weekly card: pink, hearts, free forever, Patreon if it comes from the heart. Banner drawn once per language. */
export async function buildAnnouncementCard(guildId: string, locale: Locale) {
  if (!banners.has(locale)) {
    banners.set(locale, renderSupport({ kicker: t(locale, 'announce.img.kicker'), tagline: t(locale, 'announce.img.tagline'), locale }));
  }
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(locale, 'announce.btn.support')).setEmoji('💖').setURL(config.links.patreon),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(locale, 'setup.btn.panel')).setEmoji('🎛️').setURL(`${config.publicUrl}/dashboard/${guildId}`),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(locale, 'setup.btn.bug')).setEmoji('🐛').setURL(issuesUrl()),
    new ButtonBuilder().setCustomId(`announce:remove:${guildId}`).setLabel(t(locale, 'announce.remove')).setEmoji('🗑️').setStyle(ButtonStyle.Secondary)
  );
  const card = new ContainerBuilder().setAccentColor(0xe8559a)
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(item => item.setURL(`attachment://${IMAGE}`)))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${t(locale, 'announce.title')}\n${t(locale, 'announce.body')}`))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents(buttons)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${t(locale, 'announce.footer')}`));
  const file = new AttachmentBuilder(await banners.get(locale)!, { name: IMAGE });
  return { components: [card], files: [file], flags: MessageFlags.IsComponentsV2 as const };
}

function sendableIn(channel: GuildBasedChannel | undefined, guild: Guild): SendableChannels | null {
  const me = guild.members.me;
  if (!channel || !me || !channel.isSendable() || channel.isThread()) return null;
  return channel.permissionsFor(me).has(PermissionsBitField.Flags.SendMessages) ? channel : null;
}

/** Admin-pinned channel → channel the command came from → last command channel → first sendable. */
export function findAnnouncementChannel(guild: Guild, settings: GuildSettings, preferredChannelId: string | null = null): SendableChannels | null {
  for (const id of [settings.announceChannelId, preferredChannelId, settings.defaultTextChannelId]) {
    const ch = id ? sendableIn(guild.channels.cache.get(id), guild) : null;
    if (ch) return ch;
  }
  for (const channel of guild.channels.cache.values()) {
    const ch = sendableIn(channel, guild);
    if (ch) return ch;
  }
  return null;
}

function announcementDue(settings: GuildSettings): boolean {
  const last = settings.lastAnnouncementAt ? Date.parse(settings.lastAnnouncementAt) : NaN;
  return !Number.isFinite(last) || Date.now() - last >= ANNOUNCEMENT_INTERVAL_MS;
}

export async function sendCustomToAll(client: Client, payload: { title?: string; message: string; color?: number; footer?: string }) {
  let sent = 0;
  let failed = 0;
  for (const guild of client.guilds.cache.values()) {
    const channel = findAnnouncementChannel(guild, getGuildMemory(guild.id).settings);
    if (!channel) { failed++; continue; }
    const embed = new EmbedBuilder()
      .setTitle(payload.title?.trim() || t(guildLocale(guild.id, guild), 'announce.custom_title'))
      .setColor(typeof payload.color === 'number' ? payload.color : 0x2b6cb0)
      .setDescription(payload.message.trim())
      .setTimestamp();
    if (payload.footer?.trim()) embed.setFooter({ text: payload.footer.trim() });
    if (await channel.send({ embeds: [embed] }).then(() => true, () => false)) sent++; else failed++;
  }
  return { sent, failed, total: client.guilds.cache.size };
}

/** Posts the weekly announcement if one is due. Returns true if posted. */
export async function sendAnnouncement(guild: Guild | null, preferredChannelId: string | null = null): Promise<boolean> {
  if (!guild) return false;
  const { settings } = getGuildMemory(guild.id);
  if (!getFeatures(guild.id).reminder.enabled || !announcementDue(settings)) return false;
  const channel = findAnnouncementChannel(guild, settings, preferredChannelId);
  if (!channel) return false;

  const card = await buildAnnouncementCard(guild.id, guildLocale(guild.id, guild));
  const message = await channel.send(card).catch(() => null);
  if (!message) return false;

  setGuildSettings(guild.id, { lastAnnouncementAt: new Date().toISOString(), defaultTextChannelId: channel.id });
  return true;
}

/** Who added the bot, from the audit log (needs View Audit Log), else null. */
export async function findInviter(guild: Guild): Promise<string | null> {
  const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 10 }).catch(() => null);
  return logs?.entries.find(e => e.targetId === guild.client.user.id)?.executorId ?? null;
}

/** The person to talk to about a server: whoever added the bot, else the owner. */
export async function guildAdminId(guild: Guild): Promise<string> {
  const known = getGuildMemory(guild.id).settings.inviterId;
  if (known) return known;
  const inviterId = await findInviter(guild);
  if (inviterId) setGuildSettings(guild.id, { inviterId });
  return inviterId ?? guild.ownerId;
}

/** DMs the setup card to whoever added the bot (the owner when that can't be found). */
export async function sendSetupCard(guild: Guild): Promise<void> {
  try {
    const user = await guild.client.users.fetch(await guildAdminId(guild));
    await user.send(buildSetupCard(guild, guildLocale(guild.id, guild), user.id));
  } catch (err) {
    console.warn(`Could not DM the setup card for guild ${guild.id}: ${errMsg(err)}`);
  }
}
