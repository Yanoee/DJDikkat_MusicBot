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
    .setTitle('🎉 DJ DIKKAT is Free Forever')
    .setColor(0x2b6cb0)
    .setDescription(
      'Welcome! DJ DIKKAT is a free music bot and will remain free. ' +
      'There is no paid version planned now or in the future. ' +
      'Donations are always appreciated but never required. ' +
      'Enjoy the music and use /play to start your queue!'
    )
    .addFields(
      { name: '💡 Free forever', value: 'No paid plan now, no paid plan later.', inline: false },
      { name: '🙌 Support', value: 'If you enjoy the bot, donations are welcome but not expected.', inline: false },
      { name: '🌐 Website', value: '[www.djdikkat.com](https://www.djdikkat.com)', inline: false },
      { name: '👤 Author', value: '@Yanoee (Discord: Yanoee#1995)', inline: false }
    );
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

module.exports = {
  sendAnnouncement,
  sendCustomToAll
};
