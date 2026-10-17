/************************************************************
 * DJ DIKKAT - Music Bot
 * Setup card
 * The "thanks for adding me" message (Discord components v2):
 * how to start, the web panel, links, and a language picker
 * that redraws the card in place. DMed to the server owner on
 * join; the web panel can post it in a channel too.
 * Author: Yanoee
 ************************************************************/
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, SectionBuilder, SeparatorBuilder,
  SeparatorSpacingSize, StringSelectMenuBuilder, TextDisplayBuilder, ThumbnailBuilder
} from 'discord.js';
import type { Guild } from 'discord.js';
import { config } from '../config.ts';
import { LOCALES, t } from '../i18n/index.ts';
import type { Locale } from '../i18n/index.ts';

const ACCENT = 0x3b82c4;
const FLAGS: Record<Locale, string> = { en: '🇬🇧', tr: '🇹🇷' };

/** removeFor: in a DM, the owner gets a Remove button (customId carries their ID). */
export function buildSetupCard(guild: Guild, locale: Locale, removeFor?: string) {
  const site = config.publicUrl;
  const host = new URL(site).host;
  const text = (content: string) => new TextDisplayBuilder().setContent(content);
  const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

  const links = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(locale, 'setup.btn.panel')).setEmoji('🎛️').setURL(`${site}/dashboard/${guild.id}`),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(locale, 'setup.btn.website')).setEmoji('🌐').setURL(site),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(locale, 'setup.btn.bug')).setEmoji('🐛').setURL(`${config.links.github}/issues`),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(locale, 'setup.btn.invite')).setEmoji('➕').setURL(`${site}/invite`)
  );
  const start = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Primary).setCustomId('setup:start').setLabel(t(locale, 'setup.btn.start')).setEmoji('🎵')
  );
  if (removeFor) {
    start.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setCustomId(`dmremove:welcome:${removeFor}`)
      .setLabel(t(locale, 'common.remove')).setEmoji('🗑️'));
  }
  const language = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(`setup:lang:${guild.id}`).addOptions(LOCALES.map(l => ({
      label: t(l, `language.name.${l}`), value: l, emoji: FLAGS[l], default: l === locale
    })))
  );

  const head = new SectionBuilder()
    .addTextDisplayComponents(text(`## ${t(locale, 'setup.title', { guild: guild.name })}\n${t(locale, 'setup.intro')}`))
    .setThumbnailAccessory(new ThumbnailBuilder().setURL(guild.client.user.displayAvatarURL({ size: 128 })));

  const card = new ContainerBuilder().setAccentColor(ACCENT)
    .addSectionComponents(head)
    .addSeparatorComponents(line())
    .addTextDisplayComponents(
      text(t(locale, 'setup.steps')),
      text(`### ${t(locale, 'setup.panel.head')}\n${t(locale, 'setup.panel.body', { host, url: `${site}/dashboard/${guild.id}` })}`),
      text(`### ${t(locale, 'setup.free.head')}\n${t(locale, 'setup.free.body', { patreon: config.links.patreon })}`)
    )
    .addSeparatorComponents(line())
    .addActionRowComponents(links, start)
    .addActionRowComponents(language);

  return { components: [card], flags: MessageFlags.IsComponentsV2 as const };
}
