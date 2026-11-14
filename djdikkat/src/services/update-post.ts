/************************************************************
 * DJ DIKKAT - Music Bot
 * Update post
 * One "what's new" post per server (its language, with a
 * language picker): the v7 update (restart resume, DJ
 * transitions, smart autoplay, radio host, search, new look)
 * and "open your free web panel". Tracked in update7Posted.
 * Owner only: POST /update-post with dryRun, or confirm
 * "UPDATE". One post per second; servers already posted are
 * remembered, so a second run never posts twice.
 * Author: Yanoee
 ************************************************************/
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MediaGalleryBuilder, MessageFlags,
  SeparatorBuilder, SeparatorSpacingSize, StringSelectMenuBuilder, TextDisplayBuilder
} from 'discord.js';
import type { Client, Guild } from 'discord.js';
import { getGuildMemory } from './memory.ts';
import { guildLocale } from './locale.ts';
import { getConfig, setConfig } from './config-store.ts';
import { findAnnouncementChannel } from './announcement.ts';
import { renderLaunch } from '../ui/banner-image.ts';
import { config } from '../config.ts';
import { LOCALES, t } from '../i18n/index.ts';
import type { Locale } from '../i18n/index.ts';
import { errMsg } from '../lib/errors.ts';

const STEP_MS = 1000;
const ACCENT = 0x3b82c4;
const IMAGE = 'update.png';
const FLAGS: Record<Locale, string> = { en: '🇬🇧', tr: '🇹🇷' };
const banners = new Map<Locale, Promise<Buffer>>();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const text = (content: string) => new TextDisplayBuilder().setContent(content);

const status = { running: false, total: 0, posted: 0, noChannel: 0, failed: 0, finishedAt: null as string | null };
export const updatePostStatus = () => status;

/** The channel post. `attachments: []` + the new file: a language switch replaces the banner too. */
export async function buildUpdatePost(guild: Guild, locale: Locale) {
  if (!banners.has(locale)) {
    banners.set(locale, renderLaunch({
      kicker: t(locale, 'update.img.kicker'), tagline: t(locale, 'update.img.tagline'),
      chips: t(locale, 'update.img.chips').split(',').map(s => s.trim()), locale
    }));
  }
  const site = config.publicUrl;
  const links = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(locale, 'launch.btn.panel')).setEmoji('🎛️').setURL(`${site}/dashboard/${guild.id}`),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(locale, 'setup.btn.website')).setEmoji('🌐').setURL(site),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(locale, 'setup.btn.bug')).setEmoji('🐛').setURL(`${config.links.github}/issues`)
  );
  const language = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(`update:lang:${guild.id}`).addOptions(LOCALES.map(l => ({
      label: t(l, `language.name.${l}`), value: l, emoji: FLAGS[l], default: l === locale
    })))
  );
  const card = new ContainerBuilder().setAccentColor(ACCENT)
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(item => item.setURL(`attachment://${IMAGE}`)))
    .addTextDisplayComponents(
      text(`## ${t(locale, 'update.title')}\n${t(locale, 'update.intro')}`),
      text(t(locale, 'update.list')),
      text(`### ${t(locale, 'update.panel.head')}\n${t(locale, 'update.panel.body')}`)
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents(links)
    .addActionRowComponents(language);
  const file = new AttachmentBuilder(await banners.get(locale)!, { name: IMAGE });
  return { components: [card], files: [file], attachments: [], flags: MessageFlags.IsComponentsV2 as const };
}

const todo = (client: Client<true>) => {
  const done = new Set(getConfig('update7Posted') ?? []);
  return [...client.guilds.cache.values()].filter(g => !done.has(g.id));
};

/** How many servers would get it, and how many have no channel the bot can post in. */
export function updatePostPlan(client: Client<true>) {
  const guilds = todo(client);
  return { servers: guilds.length, noChannel: guilds.filter(g => !findAnnouncementChannel(g, getGuildMemory(g.id).settings)).length };
}

/** The post for one server, DMed to one user (the owner checking it). Marks nothing. */
export async function sendUpdatePreview(client: Client<true>, guildId: string, userId: string): Promise<string> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return 'not_in_guild';
  await (await client.users.fetch(userId)).send(await buildUpdatePost(guild, guildLocale(guild.id, guild)));
  return 'sent';
}

export function startUpdatePost(client: Client<true>): boolean {
  if (status.running) return false;
  Object.assign(status, { running: true, total: 0, posted: 0, noChannel: 0, failed: 0, finishedAt: null });
  run(client).catch(err => console.error(`[UPDATE] stopped: ${errMsg(err)}`))
    .finally(() => { status.running = false; status.finishedAt = new Date().toISOString(); });
  return true;
}

async function run(client: Client<true>): Promise<void> {
  const guilds = todo(client);
  const done = new Set(getConfig('update7Posted') ?? []);
  status.total = guilds.length;
  for (const guild of guilds) {
    const channel = findAnnouncementChannel(guild, getGuildMemory(guild.id).settings);
    if (!channel) status.noChannel++;
    else {
      try {
        await channel.send(await buildUpdatePost(guild, guildLocale(guild.id, guild)));
        status.posted++;
      } catch (err) {
        status.failed++;
        console.warn(`[UPDATE] guild=${guild.id} post failed: ${errMsg(err)}`);
      }
    }
    done.add(guild.id);
    setConfig('update7Posted', [...done]);
    await sleep(STEP_MS);
  }
}
