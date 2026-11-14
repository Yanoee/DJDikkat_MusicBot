/************************************************************
 * DJ DIKKAT - Music Bot
 * /transitions
 * DJ transitions (saved per server): crossfade between songs,
 * soft fades on pause / skip / stop / seek, volume leveling.
 * No options shows the settings; any option changes them, also
 * when nothing is playing (the bot's voice channel is only
 * required while the bot is in one).
 * Author: Yanoee
 ************************************************************/
import { CROSSFADE_MAX_S, getTransitions } from '../services/features.ts';
import type { Transitions } from '../services/features.ts';
import { setTransitions } from '../music/transitions.ts';
import { peekState } from '../music/state.ts';
import { localizations, t } from '../i18n/index.ts';
import type { Locale, MessageKey } from '../i18n/index.ts';
import { canControlPlayback, ephemeral, slash, userLocale } from './shared.ts';
import type { Command } from './shared.ts';

/** The summary placeholders: "on" / "off", "4 s" / "off". */
function summaryVars(locale: Locale, s: Transitions) {
  const onOff = (on: boolean) => t(locale, on ? 'transitions.state.on' : 'transitions.state.off');
  return {
    state: onOff(s.enabled),
    crossfade: s.crossfadeS > 0 ? t(locale, 'transitions.seconds', { seconds: s.crossfadeS }) : onOff(false),
    leveling: onOff(s.leveling)
  };
}

/**
 * Settings reply. Crossfade and volume leveling stay editable while transitions
 * are off (the panel dims them the same way), so say when they don't apply yet.
 */
function reply(locale: Locale, key: MessageKey, s: Transitions): string {
  const text = t(locale, key, summaryVars(locale, s));
  return s.enabled ? text : `${text}
${t(locale, 'transitions.off_note')}`;
}

export const transitions: Command = {
  data: slash('transitions', 'cmd.transitions')
    .addBooleanOption(option => option
      .setName('on')
      .setNameLocalizations(localizations('cmd.transitions.on.name'))
      .setDescription(t('en', 'cmd.transitions.on'))
      .setDescriptionLocalizations(localizations('cmd.transitions.on')))
    .addIntegerOption(option => option
      .setName('crossfade')
      .setNameLocalizations(localizations('cmd.transitions.crossfade.name'))
      .setDescription(t('en', 'cmd.transitions.crossfade'))
      .setDescriptionLocalizations(localizations('cmd.transitions.crossfade'))
      .setMinValue(0)
      .setMaxValue(CROSSFADE_MAX_S))
    .addBooleanOption(option => option
      .setName('volume-leveling')
      .setNameLocalizations(localizations('cmd.transitions.leveling.name'))
      .setDescription(t('en', 'cmd.transitions.leveling'))
      .setDescriptionLocalizations(localizations('cmd.transitions.leveling'))),
  async execute(interaction) {
    const locale = userLocale(interaction);
    const next: Partial<Transitions> = {};
    const on = interaction.options.getBoolean('on');
    const crossfade = interaction.options.getInteger('crossfade');
    const leveling = interaction.options.getBoolean('volume-leveling');
    if (on !== null) next.enabled = on;
    if (crossfade !== null) next.crossfadeS = crossfade;
    if (leveling !== null) next.leveling = leveling;

    if (!Object.keys(next).length) {
      return interaction.reply(ephemeral(reply(locale, 'transitions.summary', getTransitions(interaction.guildId))));
    }
    // Crossfade and volume leveling are locked while transitions are off (same as the panel),
    // unless this same command turns them on.
    if ((next.crossfadeS !== undefined || next.leveling !== undefined) && !(next.enabled ?? getTransitions(interaction.guildId).enabled)) {
      return interaction.reply(ephemeral(t(locale, 'transitions.locked')));
    }
    // While the bot is in voice, only listeners in its channel change the sound (like /autoplay).
    const state = peekState(interaction.guildId);
    if (state?.voiceChannelId) {
      if (!await canControlPlayback(interaction, state)) return;
      state.textChannelId = interaction.channelId;
    }
    const saved = await setTransitions(interaction.guildId, next);
    const content = ephemeral(reply(locale, 'transitions.updated', saved));
    return interaction.deferred || interaction.replied ? interaction.followUp(content) : interaction.reply(content);
  }
};
