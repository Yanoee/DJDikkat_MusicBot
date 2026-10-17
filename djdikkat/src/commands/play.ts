/************************************************************
 * DJ DIKKAT - Music Bot
 * /play
 * Search or link → queue, with live suggestions while typing.
 * Author: Yanoee
 ************************************************************/
import { MessageFlags } from 'discord.js';
import type { ApplicationCommandOptionChoiceData, AutocompleteInteraction } from 'discord.js';
import type { Track } from 'shoukaku';
import { getState } from '../music/state.ts';
import { pickNode, ensurePlayer, playNext } from '../music/player.ts';
import { search, suggest, fold, normalizeLink } from '../music/search.ts';
import { upsertController, formatMs } from '../ui/player-card.ts';
import { localizations, t } from '../i18n/index.ts';
import type { QueueTrack } from '../lib/types.ts';
import { MAX_QUEUE, slash, edit, requester, userLocale } from './shared.ts';
import type { Command } from './shared.ts';

// As the user types, Discord shows the top matches; picking one sends that
// track's link to /play, so exactly that track plays.
const SUGGEST_MIN_CHARS = 3;
const SUGGEST_TIMEOUT_MS = 2500; // Discord drops autocomplete answers after 3s
const SUGGEST_CACHE_MS = 10 * 60 * 1000;
const SUGGEST_CACHE_MAX = 500;
const suggestCache = new Map<string, { at: number; choices: ApplicationCommandOptionChoiceData<string>[] }>();

async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const typed = interaction.options.getFocused().trim();
  const key = fold(typed);
  if (key.length < SUGGEST_MIN_CHARS || normalizeLink(typed)) return interaction.respond([]);
  const cached = suggestCache.get(key);
  if (cached && Date.now() - cached.at < SUGGEST_CACHE_MS) return interaction.respond(cached.choices);

  const node = pickNode(interaction.client);
  if (!node) return interaction.respond([]);
  const tracks = await Promise.race([
    suggest(id => node.rest.resolve(id), typed),
    new Promise<Track[]>(resolve => setTimeout(() => resolve([]), SUGGEST_TIMEOUT_MS))
  ]);
  const choices = tracks
    .filter(track => track.info.uri && track.info.uri.length <= 100)
    .map(track => ({
      name: `${track.info.title} · ${track.info.author} (${track.info.isStream ? 'live' : formatMs(track.info.length)})`.slice(0, 100),
      value: track.info.uri!
    }));
  if (choices.length) {
    if (suggestCache.size >= SUGGEST_CACHE_MAX) suggestCache.delete(suggestCache.keys().next().value!);
    suggestCache.set(key, { at: Date.now(), choices });
  }
  await interaction.respond(choices);
}

export const play: Command = {
  data: slash('play', 'cmd.play').addStringOption(option => option
    .setName('query')
    .setDescription(t('en', 'cmd.play.query'))
    .setDescriptionLocalizations(localizations('cmd.play.query'))
    .setRequired(true)
    .setAutocomplete(true)),

  autocomplete,

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { guildId, channelId } = interaction;
    const locale = userLocale(interaction);
    const query = interaction.options.getString('query', true);
    const state = getState(guildId);

    await ensurePlayer(interaction);
    state.textChannelId = channelId;
    if (state.queue.length >= MAX_QUEUE) return edit(interaction, 'common.queue_full', { max: MAX_QUEUE });

    const node = pickNode(interaction.client);
    if (!node) return edit(interaction, 'common.music_server_down');

    const { tracks, liveWarning } = await search(id => node.rest.resolve(id), query, MAX_QUEUE - state.queue.length, guildId);
    if (!tracks.length) return edit(interaction, 'play.no_results');

    // Re-check: the queue may have filled up while we were searching.
    const available = MAX_QUEUE - state.queue.length;
    if (available <= 0) return edit(interaction, 'common.queue_full', { max: MAX_QUEUE });
    const added = tracks.slice(0, available);
    state.queue.push(...added.map((track): QueueTrack => ({ ...track, ...requester(interaction) })));

    // Idle: playNext() below posts the card for the new track.
    if (state.current) await upsertController(guildId, state);

    const skipped = tracks.length - added.length;
    let reply = t(locale, 'play.added', { count: added.length });
    if (skipped > 0) reply += t(locale, 'play.skipped_full', { skipped, max: MAX_QUEUE });
    if (liveWarning) reply += `\n${t(locale, 'play.live_warning')}`;
    await interaction.editReply(reply);

    if (!state.current) await playNext(guildId);
  }
};
