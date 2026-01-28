/************************************************************
 * DJ DIKKAT - Music Bot
 * Stats UI
 * Stats embed builder
 * Build 2.0.5
 * Author: Yanoee
 ************************************************************/

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getStatsSnapshot, topFromMap, topFromUrlMap, topUsers } = require('./stats');

const TITLE_LIMIT = 60;

function medal(i) {
  if (i === 0) return '🥇';
  if (i === 1) return '🥈';
  if (i === 2) return '🥉';
  return '🏅';
}

function truncateTitle(title) {
  if (!title) return '—';
  if (title.length <= TITLE_LIMIT) return title;
  return `${title.slice(0, TITLE_LIMIT - 1)}…`;
}

function formatTopList(list, mapToLine) {
  if (!list.length) return '—';
  return list.map(mapToLine).join('\n');
}

function pickRandomTitle(stats) {
  const titles = Object.keys(stats.totals.songsByTitle || {});
  if (!titles.length) return '—';
  const idx = Math.floor(Math.random() * titles.length);
  return titles[idx];
}

function buildStatsEmbed() {
  const snap = getStatsSnapshot();

  const topTitles = topFromMap(snap.totals.songsByTitle, 3);
  const topUrls = topFromUrlMap(snap.totals.songsByUrl, 3);
  const hasUrls = topUrls.length > 0;
  const topPeople = topUsers(snap.totals.users, 3);

  const todayTop = topFromMap(snap.today.songsByTitle || {}, 1);
  const weeklyTop = topFromMap(snap.weekly.songsByTitle || {}, 1);
  const honorable = pickRandomTitle(snap);

  const topUrlMap = new Map(topUrls.map((u) => [u.title, u.key]));
  const getUrlForTitle = (title) => topUrlMap.get(title) || null;
  const getAnyUrlForTitle = (title) => {
    if (!title) return null;
    if (topUrlMap.has(title)) return topUrlMap.get(title);
    for (const [url, meta] of Object.entries(snap.totals.songsByUrl || {})) {
      if (meta && meta.title === title) return url;
    }
    return null;
  };

  const embed = new EmbedBuilder()
    .setTitle('📊 DJ DIKKAT Stats')
    .setColor(0x2b6cb0);

  embed.addFields(
    {
      name: '🎵 Most played song',
      value: hasUrls
        ? formatTopList(topUrls, (x, i) => `${medal(i)} [${truncateTitle(x.title)}](${x.key}) — ${x.count}`)
        : formatTopList(topTitles, (x, i) => {
          const url = getUrlForTitle(x.key);
          const title = truncateTitle(x.key);
          return url
            ? `${medal(i)} [${title}](${url}) — ${x.count}`
            : `${medal(i)} ${title} — ${x.count}`;
        }),
      inline: false
    },
    {
      name: '👤 Top users',
      value: formatTopList(topPeople, (x, i) => `${medal(i)} <@${x.id}> — ${x.count}`),
      inline: false
    },
    {
      name: '📅 Daily top (today)',
      value: todayTop.length
        ? (() => {
          const title = truncateTitle(todayTop[0].key);
          const url = getAnyUrlForTitle(todayTop[0].key);
          return url
            ? `⭐ [${title}](${url}) — ${todayTop[0].count}`
            : `⭐ ${title} — ${todayTop[0].count}`;
        })()
        : '—',
      inline: false
    },
    {
      name: '📈 Weekly top (7d)',
      value: weeklyTop.length
        ? (() => {
          const title = truncateTitle(weeklyTop[0].key);
          const url = getUrlForTitle(weeklyTop[0].key);
          return url
            ? `⭐ [${title}](${url}) — ${weeklyTop[0].count}`
            : `⭐ ${title} — ${weeklyTop[0].count}`;
        })()
        : '—',
      inline: false
    },
    {
      name: '🏅 Honorable mention',
      value: (() => {
        const title = truncateTitle(honorable);
        const url = getAnyUrlForTitle(honorable);
        return url ? `[${title}](${url})` : title;
      })(),
      inline: false
    }
  );

  return embed;
}

module.exports = {
  buildStatsEmbed,
  buildStatsMessage,
  buildStatsChannelMessage
};

function buildStatsMessage(userId) {
  const embed = buildStatsEmbed();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`dmremove:stats:${userId}`)
      .setLabel('Remove')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row] };
}

function buildStatsChannelMessage(guildId) {
  const embed = buildStatsEmbed();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`statsremove:${guildId}`)
      .setLabel('Remove')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row] };
}
