/************************************************************
 * DJ DIKKAT - Announcement helper
 * Welcome and weekly announcement scheduling
 * Build 2.1.0
 * Author: Yanoee
 ************************************************************/

const { EmbedBuilder, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getGuildMemory, setGuildSettings } = require('./memory');

const ANNOUNCEMENT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function buildAnnouncementEmbed() {
  return new EmbedBuilder()
    .setTitle('🎵 Hey! DJ DIKKAT is still free — and always will be.')
    .setColor(0x2b6cb0)
    .setDescription(
      'Just a quick weekly reminder that DJ DIKKAT is completely free.\n' +
      'No premium plan. No ads. No paywalls. Just music.\n\n' +
      'If the bot has been useful, consider supporting on Patreon — it helps\n' +
      'keep the servers running. But it\'s never required. Ever.'
    )
    .addFields(
      { name: '💡 Free forever',  value: 'No paid plan now. No paid plan ever. That\'s a promise.',                                         inline: false },
      { name: '❤️ Support (optional)', value: '[patreon.com/Yanoee](https://www.patreon.com/Yanoee) — keeps the lights on',                 inline: false },
      { name: '🌐 Website',       value: '[www.djdikkat.com](https://www.djdikkat.com)',                                                     inline: false },
      { name: '🐛 Found a bug?',  value: '[github.com/Yanoee/DJDikkat_MusicBot/issues](https://github.com/Yanoee/DJDikkat_MusicBot/issues)', inline: false },
      { name: '👤 Built by',      value: 'Yanoee — one person, doing this in spare time',                                                    inline: false }
    )
    .setFooter({ text: 'This message appears weekly • Admins can dismiss it' })
    .setTimestamp();
}

function canSendInChannel(channel, guild) {
  if (!channel || !guild) return false;
  if (channel.guildId !== guild.id) return false;
  if (!channel.isTextBased() || channel.isThread()) return false;
  const member = guild.members.me || guild.members.cache.get(guild.client.user?.id);
  if (!member) return false;
  const permissions = channel.permissionsFor(member);
  return permissions?.has(PermissionsBitField.Flags.SendMessages);
}

function findAnnouncementChannel(guild, settings, preferredChannelId = null) {
  if (!guild || !guild.channels) return null;

  const candidateIds = [];
  if (preferredChannelId) candidateIds.push(preferredChannelId);
  if (settings?.defaultTextChannelId) candidateIds.push(settings.defaultTextChannelId);

  for (const channelId of candidateIds) {
    const channel = guild.channels.cache.get(channelId);
    if (canSendInChannel(channel, guild)) {
      return channel;
    }
  }

  for (const channel of guild.channels.cache.values()) {
    if (canSendInChannel(channel, guild)) {
      return channel;
    }
  }

  return null;
}

function announcementDue(settings) {
  if (!settings || !settings.lastAnnouncementAt) return true;
  const last = Date.parse(settings.lastAnnouncementAt);
  if (!Number.isFinite(last)) return true;
  return Date.now() - last >= ANNOUNCEMENT_INTERVAL_MS;
}

async function sendCustomToAll(client, payload) {
  const { title, message, color, footer } = payload;
  let sent = 0;
  let failed = 0;
  const total = client.guilds.cache.size;

  for (const guild of client.guilds.cache.values()) {
    try {
      const memory   = getGuildMemory(guild.id);
      const settings = memory?.settings || {};
      const channel  = findAnnouncementChannel(guild, settings);
      if (!channel) { failed++; continue; }

      const embed = new EmbedBuilder()
        .setTitle(title?.trim() || '📢 Announcement')
        .setColor(typeof color === 'number' ? color : 0x2b6cb0)
        .setDescription(message.trim())
        .setTimestamp();

      if (footer?.trim()) {
        embed.setFooter({ text: footer.trim() });
      }

      const msg = await channel.send({ embeds: [embed] }).catch(() => null);
      if (msg) sent++; else failed++;
    } catch {
      failed++;
    }
  }

  return { sent, failed, total };
}

async function sendAnnouncement(guild, client, preferredChannelId = null) {
  if (!guild || !client) return false;

  const memory = getGuildMemory(guild.id);
  const settings = memory?.settings || {};
  if (!announcementDue(settings)) return false;

  const channel = findAnnouncementChannel(guild, settings, preferredChannelId);
  if (!channel) return false;

  const embed = buildAnnouncementEmbed();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`announce:remove:${guild.id}`)
      .setLabel('Remove announcement')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger)
  );

  const message = await channel.send({ embeds: [embed], components: [row] }).catch(() => null);
  if (!message) return false;

  await setGuildSettings(guild.id, {
    lastAnnouncementAt: new Date().toISOString(),
    defaultTextChannelId: channel.id
  });

  return true;
}

async function sendOwnerWelcome(guild, client) {
  if (!guild || !client) return;
  try {
    const owner = await client.users.fetch(guild.ownerId);
    if (!owner) return;

    const guildName = guild?.name ?? 'your server';

    const embed = new EmbedBuilder()
      .setTitle(`👋 Thanks for adding DJ DIKKAT to ${guildName}!`)
      .setColor(0x2b6cb0)
      .setDescription(
        'Hey! I\'m DJ DIKKAT — a free Discord music bot built by one person in their spare time.\n' +
        'No ads. No premium tiers. No BS. Just music, free forever.\n\n' +
        'Here\'s everything you need to get started:'
      )
      .addFields(
        {
          name: '🎵 Quick Start',
          value: [
            '`/play <song or URL>` — Search or paste a YouTube / Spotify link',
            '`/skip` — Skip the current track',
            '`/pause` — Pause / Resume',
            '`/stop` — Stop playback (bot stays in voice)',
            '`/queue` — View the current queue',
            '`/disconnect` — Disconnect the bot',
            '`/history` — View recently played tracks',
            '`/stats` — Music stats for this server',
          ].join('\n'),
          inline: false
        },
        {
          name: '🔒 Permissions needed',
          value: '`Connect` · `Speak` · `Send Messages` · `Embed Links` · `Read Message History`\nMake sure I have these in your music channel.',
          inline: false
        },
        {
          name: '💸 Completely free',
          value: 'DJ DIKKAT is free forever. No hidden costs, no trials.\nIf you ever want to support the project: [patreon.com/Yanoee](https://www.patreon.com/Yanoee) — never required.',
          inline: false
        },
        {
          name: '🌐 Website & Support',
          value: '[www.djdikkat.com](https://www.djdikkat.com) — info, bug reports & donations',
          inline: false
        },
        {
          name: '🐛 Report a bug',
          value: '[github.com/Yanoee/DJDikkat_MusicBot/issues](https://github.com/Yanoee/DJDikkat_MusicBot/issues)',
          inline: false
        }
      )
      .setFooter({ text: 'One-time setup message • Built by Yanoee • djdikkat.com' })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`dmremove:welcome:${owner.id}`)
        .setLabel('Remove')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
    );

    await owner.send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.warn(`Could not DM owner of guild ${guild.id}: ${err.message}`);
  }
}

module.exports = {
  sendAnnouncement,
  sendCustomToAll,
  sendOwnerWelcome
};
