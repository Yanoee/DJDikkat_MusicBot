/************************************************************
 * DJ DIKKAT - Music Bot
 * /radio
 * The radio host (saved per server): a DJ voice over the start
 * of songs, trivia, requester names and jingles. Off until a
 * server turns it on. No options shows the settings; any option
 * changes them, also when nothing is playing. `test` says a
 * sample line over the song that's playing.
 * Author: Yanoee
 ************************************************************/
import { MessageFlags } from 'discord.js';
import { RADIO_EVERY, RADIO_VOLUMES, getRadio, isJingleUrl } from '../services/features.ts';
import type { Radio, RadioEvery, RadioVolume } from '../services/features.ts';
import { setRadio, testRadio } from '../music/radio.ts';
import { peekState } from '../music/state.ts';
import { localizations, t } from '../i18n/index.ts';
import type { Locale, MessageKey } from '../i18n/index.ts';
import { canControlPlayback, ephemeral, slash, userLocale } from './shared.ts';
import type { Command } from './shared.ts';

/** Typed in `jingle:` to go back to the stock jingles (both languages work everywhere). */
const RESET_WORDS = ['default', 'varsayılan', 'varsayilan'];

const isResetWord = (text: string) => {
  const word = text.trim();
  return RESET_WORDS.includes(word.toLowerCase()) || RESET_WORDS.includes(word.toLocaleLowerCase('tr'));
};

/** The summary placeholders, in the reader's language. */
function summaryVars(locale: Locale, s: Radio) {
  const onOff = (on: boolean) => t(locale, on ? 'radio.state.on' : 'radio.state.off');
  return {
    state: onOff(s.enabled),
    every: t(locale, `cmd.radio.every.${s.every}`),
    trivia: onOff(s.trivia),
    names: onOff(s.names),
    volume: t(locale, `cmd.radio.volume.${s.volume}`),
    jingles: onOff(s.jingles),
    jingle: t(locale, s.jingleUrl ? 'radio.jingle.own' : 'radio.jingle.stock')
  };
}

/** Settings reply; while the host is off, say why the rest doesn't apply yet (the panel dims it the same way). */
function reply(locale: Locale, key: MessageKey, s: Radio): string {
  const text = t(locale, key, summaryVars(locale, s));
  return s.enabled ? text : `${text}
${t(locale, 'radio.off_note')}`;
}

const TEST_REPLY = { spoken: 'radio.test.spoken', not_playing: 'radio.test.not_playing', failed: 'radio.test.failed' } as const satisfies Record<string, MessageKey>;

export const radio: Command = {
  data: slash('radio', 'cmd.radio')
    .addBooleanOption(option => option
      .setName('on')
      .setNameLocalizations(localizations('cmd.radio.on.name'))
      .setDescription(t('en', 'cmd.radio.on'))
      .setDescriptionLocalizations(localizations('cmd.radio.on')))
    .addIntegerOption(option => option
      .setName('every')
      .setNameLocalizations(localizations('cmd.radio.every.name'))
      .setDescription(t('en', 'cmd.radio.every'))
      .setDescriptionLocalizations(localizations('cmd.radio.every'))
      .addChoices(...RADIO_EVERY.map(n => ({ name: t('en', `cmd.radio.every.${n}`), name_localizations: localizations(`cmd.radio.every.${n}`), value: n }))))
    .addBooleanOption(option => option
      .setName('trivia')
      .setNameLocalizations(localizations('cmd.radio.trivia.name'))
      .setDescription(t('en', 'cmd.radio.trivia'))
      .setDescriptionLocalizations(localizations('cmd.radio.trivia')))
    .addBooleanOption(option => option
      .setName('names')
      .setNameLocalizations(localizations('cmd.radio.names.name'))
      .setDescription(t('en', 'cmd.radio.names'))
      .setDescriptionLocalizations(localizations('cmd.radio.names')))
    .addStringOption(option => option
      .setName('volume')
      .setNameLocalizations(localizations('cmd.radio.volume.name'))
      .setDescription(t('en', 'cmd.radio.volume'))
      .setDescriptionLocalizations(localizations('cmd.radio.volume'))
      .addChoices(...RADIO_VOLUMES.map(v => ({ name: t('en', `cmd.radio.volume.${v}`), name_localizations: localizations(`cmd.radio.volume.${v}`), value: v }))))
    .addBooleanOption(option => option
      .setName('jingles')
      .setNameLocalizations(localizations('cmd.radio.jingles.name'))
      .setDescription(t('en', 'cmd.radio.jingles'))
      .setDescriptionLocalizations(localizations('cmd.radio.jingles')))
    .addStringOption(option => option
      .setName('jingle')
      .setNameLocalizations(localizations('cmd.radio.jingle.name'))
      .setDescription(t('en', 'cmd.radio.jingle'))
      .setDescriptionLocalizations(localizations('cmd.radio.jingle'))
      .setMaxLength(300))
    .addBooleanOption(option => option
      .setName('test')
      .setNameLocalizations(localizations('cmd.radio.test.name'))
      .setDescription(t('en', 'cmd.radio.test'))
      .setDescriptionLocalizations(localizations('cmd.radio.test'))),
  async execute(interaction) {
    const locale = userLocale(interaction);
    const next: Partial<Radio> = {};
    const on = interaction.options.getBoolean('on');
    const every = interaction.options.getInteger('every');
    const trivia = interaction.options.getBoolean('trivia');
    const names = interaction.options.getBoolean('names');
    const volume = interaction.options.getString('volume');
    const jingles = interaction.options.getBoolean('jingles');
    const jingle = interaction.options.getString('jingle');
    const test = interaction.options.getBoolean('test') === true;
    if (on !== null) next.enabled = on;
    if (every !== null && RADIO_EVERY.includes(every as RadioEvery)) next.every = every as RadioEvery;
    if (trivia !== null) next.trivia = trivia;
    if (names !== null) next.names = names;
    if (volume !== null && RADIO_VOLUMES.includes(volume as RadioVolume)) next.volume = volume as RadioVolume;
    if (jingles !== null) next.jingles = jingles;
    if (jingle !== null) {
      // Checked here (not only in cleanRadio, which would quietly keep the old link) so a typo gets an answer.
      if (isResetWord(jingle)) next.jingleUrl = null;
      else if (isJingleUrl(jingle.trim())) next.jingleUrl = jingle.trim();
      else return interaction.reply(ephemeral(t(locale, 'radio.jingle_bad')));
    }

    if (!Object.keys(next).length && !test) {
      return interaction.reply(ephemeral(reply(locale, 'radio.summary', getRadio(interaction.guildId))));
    }
    // Everything but on/off (the test included) is locked while the host is off, same as the panel,
    // unless this same command turns it on.
    const changesMore = Object.keys(next).some(k => k !== 'enabled') || test;
    if (changesMore && !(next.enabled ?? getRadio(interaction.guildId).enabled)) {
      return interaction.reply(ephemeral(t(locale, 'radio.locked')));
    }
    // While the bot is in voice, only listeners in its channel change what they hear (like /transitions).
    const state = peekState(interaction.guildId);
    if (state?.voiceChannelId) {
      if (!await canControlPlayback(interaction, state)) return;
      state.textChannelId = interaction.channelId;
    }
    // The voice can take a few seconds to load, longer than Discord waits for a first answer.
    if (test && !interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const lines: string[] = [];
    const saved = Object.keys(next).length ? await setRadio(interaction.guildId, next) : getRadio(interaction.guildId);
    if (Object.keys(next).length) lines.push(reply(locale, 'radio.updated', saved));
    if (test) lines.push(t(locale, TEST_REPLY[await testRadio(interaction.guildId)] ?? 'radio.test.failed'));
    const text = lines.join('\n');
    if (interaction.deferred && !interaction.replied) return interaction.editReply(text);
    return interaction.replied ? interaction.followUp(ephemeral(text)) : interaction.reply(ephemeral(text));
  }
};
