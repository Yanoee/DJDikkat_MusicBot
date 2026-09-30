/************************************************************
 * DJ DIKKAT - Music Bot
 * Stats UI
 * Per-guild stats embed builder
 * Build 5.2.0
 * Author: Yanoee
 ************************************************************/
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getStatsSnapshot, topFromMap, topFromUrlMap, topUsers } from './stats.ts';

const TITLE_LIMIT = 60;
const MEDALS = ['🥇', '🥈', '🥉'];

const medal = (i: number) => MEDALS[i] ?? '🏅';
const truncate = (title: string) => title.length <= TITLE_LIMIT ? title : `${title.slice(0, TITLE_LIMIT - 1)}…`;

function buildStatsEmbed(guildId: string): EmbedBuilder {
  const snap = getStatsSnapshot(guildId);

  // title -> first URL it was played from, for linking title-only lists
  const urlByTitle = new Map<string, string>();
  for (const [url, v] of Object.entries(snap.totals.songsByUrl)) if (!urlByTitle.has(v.title)) urlByTitle.set(v.title, url);
  const link = (title: string) => {
    const url = urlByTitle.get(title);
    return url ? `[${truncate(title)}](${url})` : truncate(title);
  };
  const top1 = (map: Record<string, number>) => {
    const [first] = topFromMap(map, 1);
    return first ? `⭐ ${link(first.key)} — ${first.count}` : '—';
  };
  const list = <T>(items: T[], line: (x: T, i: number) => string) => items.length ? items.map(line).join('\n') : '—';

  const topUrls = topFromUrlMap(snap.totals.songsByUrl, 3);
  const titles = Object.keys(snap.totals.songsByTitle);
  const honorable = titles[Math.floor(Math.random() * titles.length)];

  return new EmbedBuilder()
    .setTitle('📊 DJ DIKKAT Stats')
    .setColor(0x2b6cb0)
    .addFields(
      {
        name: '🎵 Most played song',
        value: topUrls.length
          ? list(topUrls, (x, i) => `${medal(i)} [${truncate(x.title)}](${x.key}) — ${x.count}`)
          : list(topFromMap(snap.totals.songsByTitle, 3), (x, i) => `${medal(i)} ${link(x.key)} — ${x.count}`)
      },
      { name: '👤 Top users', value: list(topUsers(snap.totals.users, 3), (x, i) => `${medal(i)} <@${x.id}> — ${x.count}`) },
      { name: '📅 Daily top (today)', value: top1(snap.today.songsByTitle) },
      { name: '📈 Weekly top (7d)', value: top1(snap.weekly.songsByTitle) },
      { name: '🏅 Honorable mention', value: honorable ? link(honorable) : '—' }
    );
}

export function buildStatsChannelMessage(guildId: string) {
  return {
    embeds: [buildStatsEmbed(guildId)],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`statsremove:${guildId}`).setLabel('Remove').setEmoji('🗑️').setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}
