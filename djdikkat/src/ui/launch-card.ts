/************************************************************
 * DJ DIKKAT - Music Bot
 * Launch messages
 * The one-time "DJ DIKKAT got a big upgrade" post for every
 * server's channel (with a language picker), and the DM to
 * each server's admin: activation links for people who never
 * used the panel, "open your panel" for everyone else.
 * Author: Yanoee
 ************************************************************/
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MediaGalleryBuilder, MessageFlags,
  SeparatorBuilder, SeparatorSpacingSize, StringSelectMenuBuilder, TextDisplayBuilder
} from 'discord.js';
import type { Guild } from 'discord.js';
import { config } from '../config.ts';
import { LOCALES, t } from '../i18n/index.ts';
import type { Locale } from '../i18n/index.ts';
import { renderLaunch } from './banner-image.ts';

const ACCENT = 0x3b82c4;
const FLAGS: Record<Locale, string> = { en: '🇬🇧', tr: '🇹🇷' };
const IMAGE = 'launch.png';
const banners = new Map<Locale, Promise<Buffer>>();

/** The banner in the message's language, drawn once per language. */
async function bannerFile(locale: Locale) {
  if (!banners.has(locale)) {
    banners.set(locale, renderLaunch({
      kicker: t(locale, 'launch.img.kicker'), tagline: t(locale, 'launch.img.tagline'),
      chips: t(locale, 'launch.img.chips').split(',').map(s => s.trim()), locale
    }));
  }
  return new AttachmentBuilder(await banners.get(locale)!, { name: IMAGE });
}
const text = (content: string) => new TextDisplayBuilder().setContent(content);
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

/** The channel post. `attachments: []` + the new file: a language switch replaces the banner too. */
export async function buildLaunchPost(guild: Guild, locale: Locale) {
  const site = config.publicUrl;
  const links = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(locale, 'launch.btn.panel')).setEmoji('🎛️').setURL(`${site}/dashboard/${guild.id}`),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(locale, 'setup.btn.website')).setEmoji('🌐').setURL(site),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(locale, 'setup.btn.bug')).setEmoji('🐛').setURL(`${config.links.github}/issues`)
  );
  const language = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(`launch:lang:${guild.id}`).addOptions(LOCALES.map(l => ({
      label: t(l, `language.name.${l}`), value: l, emoji: FLAGS[l], default: l === locale
    })))
  );
  const card = new ContainerBuilder().setAccentColor(ACCENT)
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(item => item.setURL(`attachment://${IMAGE}`)))
    .addTextDisplayComponents(
      text(`## ${t(locale, 'launch.title')}\n${t(locale, 'launch.intro')}`),
      text(t(locale, 'launch.list')),
      text(t(locale, 'launch.admins'))
    )
    .addSeparatorComponents(line())
    .addActionRowComponents(links)
    .addActionRowComponents(language);
  return { components: [card], files: [await bannerFile(locale)], attachments: [], flags: MessageFlags.IsComponentsV2 as const };
}

export interface AdminServer { guild: Guild; activateUrl: string | null }

/** The DM to one admin, covering all of their servers (activation links where they never used the panel). */
export async function buildLaunchDm(servers: AdminServer[], locale: Locale) {
  const site = config.publicUrl;
  const activate = servers.some(s => s.activateUrl);
  const buttons = servers.slice(0, 20).map(({ guild, activateUrl }) => new ButtonBuilder().setStyle(ButtonStyle.Link)
    .setLabel(t(locale, activateUrl ? 'launch.dm.activate' : 'launch.dm.open', { server: guild.name.slice(0, 50) }))
    .setURL(activateUrl ?? `${site}/dashboard/${guild.id}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));

  const card = new ContainerBuilder().setAccentColor(ACCENT)
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(item => item.setURL(`attachment://${IMAGE}`)))
    .addTextDisplayComponents(
      text(`## ${t(locale, activate ? 'launch.dm.title_activate' : 'launch.dm.title_open')}`),
      text(t(locale, activate ? 'launch.dm.body_activate' : 'launch.dm.body_open')),
      text(t(locale, 'launch.list'))
    )
    .addSeparatorComponents(line());
  for (const row of rows) card.addActionRowComponents(row);
  if (activate) card.addTextDisplayComponents(text(`-# ${t(locale, 'launch.dm.fine_print')}`));
  return { components: [card], files: [await bannerFile(locale)], flags: MessageFlags.IsComponentsV2 as const };
}
