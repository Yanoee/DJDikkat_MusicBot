/************************************************************
 * DJ DIKKAT - Music Bot
 * Sound commands
 * /filter: one sound effect for the session (or off).
 * /autoplay: similar songs when the queue runs out (saved per
 * server). Both need the caller in the bot's voice channel.
 * Author: Yanoee
 ************************************************************/
import { FILTERS, isFilter } from '../music/filters.ts';
import { autoplayOn, filterCooldown, setAutoplay, setFilter } from '../music/player.ts';
import { localizations, t } from '../i18n/index.ts';
import { playbackState, say, slash, userLocale } from './shared.ts';
import type { Command } from './shared.ts';

export const filter: Command = {
  data: slash('filter', 'cmd.filter').addStringOption(option => option
    .setName('effect')
    .setDescription(t('en', 'cmd.filter.effect'))
    .setDescriptionLocalizations(localizations('cmd.filter.effect'))
    .setRequired(true)
    .addChoices(...(['off', ...FILTERS] as const).map(f => ({ name: t('en', `fx.${f}`), name_localizations: localizations(`fx.${f}`), value: f })))),
  async execute(interaction) {
    const state = await playbackState(interaction);
    if (!state) return;
    if (!state.player || !state.current) return say(interaction, 'common.nothing_playing');
    const wait = filterCooldown(interaction.guildId);
    if (wait) return say(interaction, 'common.slow_down', { seconds: wait });
    const value = interaction.options.getString('effect', true);
    await setFilter(interaction.guildId, isFilter(value) ? value : null);
    return isFilter(value)
      ? say(interaction, 'fx.set', { name: t(userLocale(interaction), `fx.${value}`) })
      : say(interaction, 'fx.cleared');
  }
};

export const autoplay: Command = {
  data: slash('autoplay', 'cmd.autoplay').addBooleanOption(option => option
    .setName('on')
    .setDescription(t('en', 'cmd.autoplay.on'))
    .setDescriptionLocalizations(localizations('cmd.autoplay.on'))),
  async execute(interaction) {
    if (!await playbackState(interaction)) return;
    const on = interaction.options.getBoolean('on') ?? !autoplayOn(interaction.guildId);
    await setAutoplay(interaction.guildId, on);
    return say(interaction, on ? 'autoplay.on' : 'autoplay.off');
  }
};
