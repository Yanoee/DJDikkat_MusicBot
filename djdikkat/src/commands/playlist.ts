/************************************************************
 * DJ DIKKAT - Music Bot
 * /playlist
 * play: queues one of the server's web-panel playlists (up to
 * the free queue space, shuffled if asked). add: puts the song
 * that's playing into one. Names autocomplete as you type.
 * Author: Yanoee
 ************************************************************/
import { MessageFlags } from 'discord.js';
import type { AutocompleteInteraction, SlashCommandStringOption } from 'discord.js';
import { getState, enqueueRequested } from '../music/state.ts';
import { ensurePlayer, playNext, resolveLinks } from '../music/player.ts';
import { upsertController } from '../ui/player-card.ts';
import { addToPlaylist, findPlaylist, listPlaylists } from '../services/playlists.ts';
import { localizations, t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';
import type { QueueTrack } from '../lib/types.ts';
import { MAX_QUEUE, edit, requester, say, slash } from './shared.ts';
import type { Command } from './shared.ts';
import { syncNextTrack } from '../music/transitions.ts';

const nameOption = (key: MessageKey) => (option: SlashCommandStringOption) => option
  .setName('name')
  .setDescription(t('en', key))
  .setDescriptionLocalizations(localizations(key))
  .setRequired(true)
  .setAutocomplete(true);

async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.guildId) return interaction.respond([]);
  const lists = await listPlaylists(interaction.guildId, interaction.options.getFocused().trim().slice(0, 60));
  await interaction.respond(lists.map(p => ({ name: `${p.name} · ${p.tracks}`.slice(0, 100), value: String(p.id) })));
}

export const playlist: Command = {
  data: slash('playlist', 'cmd.playlist')
    .addSubcommand(sub => sub.setName('play')
      .setDescription(t('en', 'cmd.playlist.play'))
      .setDescriptionLocalizations(localizations('cmd.playlist.play'))
      .addStringOption(nameOption('cmd.playlist.name'))
      .addBooleanOption(option => option.setName('shuffle')
        .setDescription(t('en', 'cmd.playlist.shuffle'))
        .setDescriptionLocalizations(localizations('cmd.playlist.shuffle'))))
    .addSubcommand(sub => sub.setName('add')
      .setDescription(t('en', 'cmd.playlist.add'))
      .setDescriptionLocalizations(localizations('cmd.playlist.add'))
      .addStringOption(nameOption('cmd.playlist.name'))),

  autocomplete,

  async execute(interaction) {
    const { guildId } = interaction;
    const state = getState(guildId);
    const found = await findPlaylist(guildId, interaction.options.getString('name', true));
    if (!found) return say(interaction, 'playlist.not_found');

    if (interaction.options.getSubcommand() === 'add') {
      if (!state.current) return say(interaction, 'common.nothing_playing');
      const result = await addToPlaylist(guildId, found.id, interaction.user.id, state.current);
      return say(interaction, `playlist.${result}`, { name: found.name, max: 200 });
    }

    if (!found.uris.length) return say(interaction, 'playlist.empty', { name: found.name });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await ensurePlayer(interaction);
    state.textChannelId = interaction.channelId;
    const room = MAX_QUEUE - state.queue.length;
    if (room <= 0) return edit(interaction, 'common.queue_full', { max: MAX_QUEUE });

    const uris = [...found.uris];
    if (interaction.options.getBoolean('shuffle')) {
      for (let i = uris.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [uris[i], uris[j]] = [uris[j]!, uris[i]!];
      }
    }
    const tracks = await resolveLinks(interaction.client, uris.slice(0, room));
    if (!tracks.length) return edit(interaction, 'play.no_results');
    const added = tracks.slice(0, MAX_QUEUE - state.queue.length);
    enqueueRequested(state, added.map((track): QueueTrack => ({ ...track, ...requester(interaction) })));
    if (state.current) {
      void syncNextTrack(guildId); // the queue may have a new next song: crossfade into it
      await upsertController(guildId, state);
    }
    await edit(interaction, 'playlist.queued', { count: added.length, name: found.name });
    if (!state.current) await playNext(guildId);
  }
};
