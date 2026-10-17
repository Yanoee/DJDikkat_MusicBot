/************************************************************
 * DJ DIKKAT - Music Bot
 * /panel
 * DMs a one-time login link to this server's web panel. The
 * token travels in the URL fragment (never sent to the server
 * or logged); only its SHA-256 is stored, for 10 minutes.
 * Author: Yanoee
 ************************************************************/
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { createClaim } from '../services/claims.ts';
import { trackDm } from '../services/dm-store.ts';
import { config } from '../config.ts';
import { t } from '../i18n/index.ts';
import { slash, say, edit, canManageGuild, userLocale } from './shared.ts';
import type { Command } from './shared.ts';

const CLAIM_TTL_MS = 10 * 60 * 1000;

export const panel: Command = {
  data: slash('panel', 'cmd.panel').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!canManageGuild(interaction)) return say(interaction, 'common.manage_server_only');
    if (!config.internal.panelSecret) return say(interaction, 'panel.disabled');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const locale = userLocale(interaction);
    const { user, guild } = interaction;
    const { token, expires } = await createClaim(user, guild, CLAIM_TTL_MS);

    const embed = new EmbedBuilder()
      .setTitle(t(locale, 'panel.dm.title', { guild: guild.name }))
      .setColor(0xcd412b)
      .setDescription(t(locale, 'panel.dm.body', { expires: Math.floor(expires.getTime() / 1000) }));
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(locale, 'panel.dm.open')).setURL(`${config.publicUrl}/auth/claim#${token}`),
      new ButtonBuilder().setCustomId(`dmremove:panel:${user.id}`).setLabel(t(locale, 'common.remove')).setEmoji('🗑️').setStyle(ButtonStyle.Secondary)
    );
    try {
      const sent = await user.send({ embeds: [embed], components: [row] });
      await trackDm(sent.channel.id, sent.id, 'panel').catch(() => {});
      return edit(interaction, 'panel.sent');
    } catch {
      return edit(interaction, 'common.dm_failed');
    }
  }
};
