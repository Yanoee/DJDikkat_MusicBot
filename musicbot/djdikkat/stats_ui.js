/************************************************************
 * DJ DIKKAT - Music Bot
 * Stats UI
 * Stats embed builder
 * Build 2.0.4.22
 * Author: Yanoee
 ************************************************************/

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getStatsSnapshot, topFromMap, topFromUrlMap, topUsers } = require('./stats');

function medal(i) {
  if (i === 0) return '🥇';
  if (i === 1) return '🥈';
  if (i === 2) return '🥉';
  return '🏅';
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
  const topUrl = topUrls.length ? topUrls[0] : null;
  const topPeople = topUsers(snap.totals.users, 3);

  const todayTop = topFromMap(snap.today.songsByTitle || {}, 1);
  const weeklyTop = topFromMap(snap.weekly.songsByTitle || {}, 1);
  const honorable = pickRandomTitle(snap);

  const embed = new EmbedBuilder()
    .setTitle('📊 DJ DIKKAT Stats')
    .setColor(0x2b6cb0);

  embed.addFields(
    {
      name: '🎵 Most played song',
      value: topUrl
        ? `${medal(0)} [${topUrl.title}](${topUrl.key}) — ${topUrl.count}`
        : formatTopList(topTitles, (x, i) => `${medal(i)} ${x.key} — ${x.count}`),
      inline: false
    },
    {
      name: '👤 Top users',
      value: formatTopList(topPeople, (x, i) => `${medal(i)} <@${x.id}> — ${x.count}`),
      inline: false
    },
    {
      name: '📅 Daily top (today)',
      value: todayTop.length ? `⭐ ${todayTop[0].key} — ${todayTop[0].count}` : '—',
      inline: false
    },
    {
      name: '📈 Weekly top (7d)',
      value: weeklyTop.length ? `⭐ ${weeklyTop[0].key} — ${weeklyTop[0].count}` : '—',
      inline: false
    },
    {
      name: '🏅 Honorable mention',
      value: honorable,
      inline: false
    }
  );

  return embed;
}

module.exports = {
  buildStatsEmbed,
  buildStatsMessage
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
