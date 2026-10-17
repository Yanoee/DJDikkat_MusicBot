/************************************************************
 * DJ DIKKAT - Music Bot
 * Info commands
 * /history and /health go to DMs, /stats posts one public card
 * per guild (removed after 3 minutes unless music is playing).
 * Author: Yanoee
 ************************************************************/
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { getState, peekState } from '../music/state.ts';
import { pickNode } from '../music/player.ts';
import { getStatsMeta } from '../services/stats.ts';
import { getStatsMessage, setStatsMessage, clearStatsMessage } from '../services/memory.ts';
import { guildLocale } from '../services/locale.ts';
import { deleteMessage } from '../ui/player-card.ts';
import { buildHistoryMessage } from '../ui/history-card.ts';
import { buildHealthMessage } from '../ui/health-card.ts';
import { buildStatsChannelMessage } from '../ui/stats-card.ts';
import { slash, say, sendDm, userLocale, STATS_AUTO_DELETE_MS } from './shared.ts';
import type { Command } from './shared.ts';

export const history: Command = {
  data: slash('history', 'cmd.history'),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const message = buildHistoryMessage(interaction.guildId, 1, interaction.user.id, userLocale(interaction));
    return sendDm(interaction, message, 'history', 'history.sent');
  }
};

export const health: Command = {
  data: slash('health', 'cmd.health'),
  async execute(interaction) {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) return say(interaction, 'common.admins_only');
    // DB lookup + DM can take longer than Discord's 3s window — ack first.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { client, guildId, user } = interaction;
    const message = await buildHealthMessage(client, getState(guildId), getStatsMeta(), pickNode(client), user.id, guildId, userLocale(interaction));
    return sendDm(interaction, message, 'health', 'health.sent');
  }
};

export const stats: Command = {
  data: slash('stats', 'cmd.stats'),
  async execute(interaction) {
    await interaction.deferReply();
    const { guildId, channelId } = interaction;
    const old = getStatsMessage(guildId);
    if (old.messageId && old.channelId) {
      await deleteMessage(interaction.client, old.channelId, old.messageId);
      clearStatsMessage(guildId);
    }
    // editReply resolves to the real Message (reply()'s InteractionResponse carries the interaction id).
    const message = await interaction.editReply(buildStatsChannelMessage(guildId, guildLocale(guildId, interaction.guild)));
    setStatsMessage(guildId, channelId, message.id);
    setTimeout(() => {
      if (peekState(guildId)?.current) return;
      message.delete().catch(() => {});
      if (getStatsMessage(guildId).messageId === message.id) clearStatsMessage(guildId);
    }, STATS_AUTO_DELETE_MS);
  }
};
