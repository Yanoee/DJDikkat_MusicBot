/************************************************************
 * DJ DIKKAT - Music Bot
 * Playback commands
 * /pause /skip /stop /disconnect /queue — all need the caller
 * in the bot's voice channel.
 * Author: Yanoee
 ************************************************************/
import { MessageFlags } from 'discord.js';
import { togglePause, stopTrack, stopPlayback, disconnectGuild } from '../music/player.ts';
import { upsertController } from '../ui/player-card.ts';
import { buildQueueMessage } from '../ui/queue-card.ts';
import { slash, say, playbackState, userLocale } from './shared.ts';
import type { Command } from './shared.ts';

export const pause: Command = {
  data: slash('pause', 'cmd.pause'),
  async execute(interaction) {
    if (!await playbackState(interaction)) return;
    const paused = await togglePause(interaction.guildId); // also refreshes the card
    return say(interaction, paused == null ? 'common.nothing_playing' : paused ? 'pause.paused' : 'pause.resumed');
  }
};

export const skip: Command = {
  data: slash('skip', 'cmd.skip'),
  async execute(interaction) {
    const state = await playbackState(interaction);
    if (!state) return;
    if (!state.current) return say(interaction, 'common.nothing_playing');
    await stopTrack(interaction.guildId); // the 'stopped' end event advances + reposts the card
    return say(interaction, 'skip.done');
  }
};

export const stop: Command = {
  data: slash('stop', 'cmd.stop'),
  async execute(interaction) {
    if (!await playbackState(interaction)) return;
    await stopPlayback(interaction.guildId);
    return say(interaction, 'stop.done');
  }
};

export const disconnect: Command = {
  data: slash('disconnect', 'cmd.disconnect'),
  async execute(interaction) {
    if (!await playbackState(interaction)) return;
    await say(interaction, 'disconnect.done');
    return disconnectGuild(interaction.guildId);
  }
};

export const queue: Command = {
  data: slash('queue', 'cmd.queue'),
  async execute(interaction) {
    const state = await playbackState(interaction);
    if (!state) return;
    await upsertController(interaction.guildId, state);
    const message = buildQueueMessage(interaction.guildId, state, 1, interaction.user.id, userLocale(interaction));
    return interaction.reply({ ...message, flags: MessageFlags.Ephemeral });
  }
};
