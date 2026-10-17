/************************************************************
 * DJ DIKKAT - Music Bot
 * /language
 * Language of the guild's public messages (player card, stats,
 * announcements). Ephemeral replies always follow each user's
 * own Discord language.
 * Author: Yanoee
 ************************************************************/
import { PermissionFlagsBits } from 'discord.js';
import { guildLocale, setGuildLocale } from '../services/locale.ts';
import { isLocale, localizations, t } from '../i18n/index.ts';
import { slash, say, canManageGuild } from './shared.ts';
import type { Command } from './shared.ts';

export const language: Command = {
  data: slash('language', 'cmd.language')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option
      .setName('language')
      .setDescription(t('en', 'cmd.language.value'))
      .setDescriptionLocalizations(localizations('cmd.language.value'))
      .setRequired(true)
      .addChoices(
        { name: t('en', 'language.choice.auto'), name_localizations: localizations('language.choice.auto'), value: 'auto' },
        { name: t('en', 'language.name.en'), value: 'en' },
        { name: t('en', 'language.name.tr'), value: 'tr' }
      )),

  async execute(interaction) {
    if (!canManageGuild(interaction)) return say(interaction, 'common.manage_server_only');
    const choice = interaction.options.getString('language', true);
    setGuildLocale(interaction.guildId, isLocale(choice) ? choice : null);
    const now = guildLocale(interaction.guildId, interaction.guild);
    return say(interaction, isLocale(choice) ? 'language.set' : 'language.auto', { language: t(now, `language.name.${now}`) });
  }
};
