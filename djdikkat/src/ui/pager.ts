/************************************************************
 * DJ DIKKAT - Music Bot
 * Pager row
 * Prev / Next buttons shared by the queue and history cards.
 * Author: Yanoee
 ************************************************************/
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { t } from '../i18n/index.ts';
import type { Locale } from '../i18n/index.ts';

/** customId: <prefix>:<prev|next>:<guildId>:<page>:<userId> */
export function pagerRow(prefix: string, guildId: string, page: number, totalPages: number, userId: string, locale: Locale) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}:prev:${guildId}:${page}:${userId}`).setLabel(t(locale, 'common.prev')).setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`${prefix}:next:${guildId}:${page}:${userId}`).setLabel(t(locale, 'common.next')).setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages)
  );
}

/** Mention when we have the user id, else the stored tag. */
export const mention = (userId: string | null | undefined, tag: string | null | undefined, locale: Locale) =>
  userId ? `<@${userId}>` : (tag || t(locale, 'common.unknown'));
