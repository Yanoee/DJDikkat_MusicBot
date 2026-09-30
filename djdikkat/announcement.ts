/************************************************************
 * DJ DIKKAT - Announcement helper
 * Weekly announcement, admin broadcasts, owner welcome DM
 * Build 5.2.0
 * Author: Yanoee
 ************************************************************/
import { EmbedBuilder, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { Client, Guild, GuildBasedChannel, SendableChannels } from 'discord.js';
import { getGuildMemory, setGuildSettings } from './memory.ts';
import type { GuildSettings } from './memory.ts';
import { errMsg } from './errors.ts';

const ANNOUNCEMENT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const PATREON = 'https://www.patreon.com/16130275/join';
const ISSUES  = 'https://github.com/Yanoee/DJDikkat_MusicBot/issues';

function buildAnnouncementEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🎵 DJ DIKKAT Appeared! 🎊')
    .setColor(0x2b6cb0)
    .setDescription(
      'Just a quick weekly reminder that DJ DIKKAT is completely free.\n' +
      'No premium plan. No ads. No paywalls. Just music.\n\n' +
      'If the bot has been useful, consider supporting on Patreon,\n' +
      'it helps to keep the servers running. But it\'s never required.'
    )
    .addFields(
      { name: '💡 Free forever', value: 'No paid plan now. No paid plan ever. That\'s a promise. ' },
      { name: '❤️ Support',      value: `[Donations](${PATREON}) — keeps the lights on` },
      { name: '🌐 Website',      value: '[Website](https://www.djdikkat.com)' },
      { name: '🐛 Found a bug?', value: `[Github](${ISSUES})` }
    )
    .setFooter({ text: 'This message appears weekly • Admins can dismiss it 🚀' })
    .setTimestamp();
}

function sendableIn(channel: GuildBasedChannel | undefined, guild: Guild): SendableChannels | null {
  const me = guild.members.me;
  if (!channel || !me || !channel.isSendable() || channel.isThread()) return null;
  return channel.permissionsFor(me).has(PermissionsBitField.Flags.SendMessages) ? channel : null;
}

/** Admin-pinned channel → channel the command came from → last command channel → first sendable. */
function findAnnouncementChannel(guild: Guild, settings: GuildSettings, preferredChannelId: string | null = null): SendableChannels | null {
  for (const id of [settings.announceChannelId, preferredChannelId, settings.defaultTextChannelId]) {
    const ch = id ? sendableIn(guild.channels.cache.get(id), guild) : null;
    if (ch) return ch;
  }
  for (const channel of guild.channels.cache.values()) {
    const ch = sendableIn(channel, guild);
    if (ch) return ch;
  }
  return null;
}

function announcementDue(settings: GuildSettings): boolean {
  const last = settings.lastAnnouncementAt ? Date.parse(settings.lastAnnouncementAt) : NaN;
  return !Number.isFinite(last) || Date.now() - last >= ANNOUNCEMENT_INTERVAL_MS;
}

export async function sendCustomToAll(client: Client, payload: { title?: string; message: string; color?: number; footer?: string }) {
  let sent = 0;
  let failed = 0;
  for (const guild of client.guilds.cache.values()) {
    const channel = findAnnouncementChannel(guild, getGuildMemory(guild.id).settings);
    if (!channel) { failed++; continue; }
    const embed = new EmbedBuilder()
      .setTitle(payload.title?.trim() || '📢 Announcement')
      .setColor(typeof payload.color === 'number' ? payload.color : 0x2b6cb0)
      .setDescription(payload.message.trim())
      .setTimestamp();
    if (payload.footer?.trim()) embed.setFooter({ text: payload.footer.trim() });
    if (await channel.send({ embeds: [embed] }).then(() => true, () => false)) sent++; else failed++;
  }
  return { sent, failed, total: client.guilds.cache.size };
}

/** Posts the weekly announcement if one is due. Returns true if posted. */
export async function sendAnnouncement(guild: Guild | null, preferredChannelId: string | null = null): Promise<boolean> {
  if (!guild) return false;
  const { settings } = getGuildMemory(guild.id);
  if (!announcementDue(settings)) return false;
  const channel = findAnnouncementChannel(guild, settings, preferredChannelId);
  if (!channel) return false;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`announce:remove:${guild.id}`).setLabel('Remove announcement').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
  );
  const message = await channel.send({ embeds: [buildAnnouncementEmbed()], components: [row] }).catch(() => null);
  if (!message) return false;

  setGuildSettings(guild.id, { lastAnnouncementAt: new Date().toISOString(), defaultTextChannelId: channel.id });
  return true;
}

export async function sendOwnerWelcome(guild: Guild): Promise<void> {
  try {
    const owner = await guild.client.users.fetch(guild.ownerId);
    const embed = new EmbedBuilder()
      .setTitle(`🎉 Thanks for adding DJ DIKKAT to ${guild.name}! 🎉`)
      .setColor(0x2b6cb0)
      .setDescription(
        'Hey!👋 \n' +
        'I\'m DJ DIKKAT — a free Discord music bot.\n' +
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
            '`/stats` — Music stats for this server'
          ].join('\n')
        },
        {
          name: '🔒 Permissions needed',
          value: '`Connect` · `Speak` · `Send Messages` · `Embed Links` · `Read Message History`\nMake sure I have these in your music channel.'
        },
        {
          name: '💸 Completely free',
          value: `DJ DIKKAT is free forever. No hidden costs, no trials.\nIf you ever want to support the project: [Patreon](${PATREON}) • I will be happy!`
        },
        { name: '🌐 Website & Support', value: '[www.djdikkat.com](https://www.djdikkat.com) — info, bug reports & donations' },
        { name: '🐛 Report a bug', value: `[github.com/Yanoee/DJDikkat_MusicBot/issues](${ISSUES})` }
      )
      .setFooter({ text: '• One-time setup message •' })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`dmremove:welcome:${owner.id}`).setLabel('Remove').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
    );
    await owner.send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.warn(`Could not DM owner of guild ${guild.id}: ${errMsg(err)}`);
  }
}
