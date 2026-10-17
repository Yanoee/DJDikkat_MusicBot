/************************************************************
 * DJ DIKKAT - Music Bot
 * Queue card
 * The paginated /queue embed, with Shuffle / Clear / Web panel
 * (the player card itself keeps one row of icons).
 * Author: Yanoee
 ************************************************************/
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { GuildState } from '../music/state.ts';
import { cardIcon, panelButton, truncateQueueTitle } from './player-card.ts';
import { pagerRow, mention } from './pager.ts';
import { t } from '../i18n/index.ts';
import type { Locale } from '../i18n/index.ts';

const PAGE_SIZE = 10;

export function buildQueueMessage(guildId: string, state: GuildState, page: number, userId: string, locale: Locale) {
  const total = state.queue.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * PAGE_SIZE;
  const list = state.queue.slice(start, start + PAGE_SIZE).map((track, i) => {
    const title = truncateQueueTitle(track.info.title);
    return `${start + i + 1}. ${track.info.uri ? `[${title}](${track.info.uri})` : title} || ${mention(track.requesterId, track.requesterTag, locale)}`;
  }).join('\n') || '-';

  const nowPlaying = truncateQueueTitle(state.current?.info.title ?? t(locale, 'queue.nothing'));
  let description = `${t(locale, 'queue.now_playing', { title: nowPlaying })}\n\n${t(locale, 'queue.up_next')}\n${list}`;
  if (description.length > 4000) description = `${description.slice(0, 3997)}...`;

  const embed = new EmbedBuilder()
    .setTitle(t(locale, 'queue.title'))
    .setColor(0x2b6cb0)
    .setDescription(description)
    .setFooter({ text: t(locale, 'queue.footer', { page: safePage, pages: totalPages, count: total }) });
  const tools = new ActionRowBuilder<ButtonBuilder>();
  if (total) {
    tools.addComponents(
      new ButtonBuilder().setCustomId(`music:shuffle:${guildId}`).setLabel(t(locale, 'card.btn.shuffle')).setEmoji(cardIcon('shuffle', '🔀')).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`music:clearqueue:${guildId}`).setLabel(t(locale, 'card.btn.clear')).setEmoji(cardIcon('clear', '🧹')).setStyle(ButtonStyle.Secondary)
    );
  }
  tools.addComponents(panelButton(guildId, locale));
  return { content: '', embeds: [embed], components: [pagerRow('queuepage', guildId, safePage, totalPages, userId, locale), tools] };
}
