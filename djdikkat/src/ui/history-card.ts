/************************************************************
 * DJ DIKKAT - Music Bot
 * History card
 * The paginated /history embed (sent by DM).
 * Author: Yanoee
 ************************************************************/
import { EmbedBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getHistoryPage } from '../services/memory.ts';
import { pagerRow, mention } from './pager.ts';
import { t } from '../i18n/index.ts';
import type { Locale } from '../i18n/index.ts';

const PAGE_SIZE = 10;

export function buildHistoryMessage(guildId: string, page: number, userId: string, locale: Locale) {
  const data = getHistoryPage(guildId, page, PAGE_SIZE);
  const lines = data.entries.map((e, i) =>
    `${(data.page - 1) * PAGE_SIZE + i + 1}. ${e.url ? `[${e.title}](${e.url})` : e.title} · ${mention(e.userId, e.userTag, locale)}`);
  const embed = new EmbedBuilder()
    .setTitle(t(locale, 'history.title'))
    .setColor(0x2b6cb0)
    .setDescription(lines.join('\n') || '-')
    .setFooter({ text: t(locale, 'history.footer', { page: data.page, pages: data.totalPages }) });
  const row = pagerRow('history', guildId, data.page, data.totalPages, userId, locale).addComponents(
    new ButtonBuilder().setCustomId(`dmremove:history:${userId}`).setLabel(t(locale, 'common.remove')).setEmoji('🗑️').setStyle(ButtonStyle.Danger)
  );
  return { embeds: [embed], components: [row] };
}
