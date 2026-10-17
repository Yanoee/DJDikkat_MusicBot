/************************************************************
 * DJ DIKKAT - Music Bot
 * Buttons
 * Player-card controls, pagers and DM housekeeping buttons.
 * Author: Yanoee
 ************************************************************/
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import { getState, clampCooldownMs } from '../music/state.ts';
import type { GuildState } from '../music/state.ts';
import {
  pickNode, ensurePlayer, playNext, togglePause, toggleLoopMode, stopTrack, stopPlayback, clearQueue, disconnectGuild
} from '../music/player.ts';
import { tracksOf } from '../music/search.ts';
import { resetGuildMemory, resetGuildHistory, resetGuildMessages, clearStatsMessage } from '../services/memory.ts';
import { maintenanceMessage, maintenanceBlocks } from '../services/config-store.ts';
import { upsertController } from '../ui/player-card.ts';
import { buildQueueMessage } from '../ui/queue-card.ts';
import { buildHistoryMessage } from '../ui/history-card.ts';
import { UserError } from '../lib/errors.ts';
import { t } from '../i18n/index.ts';
import type { MessageKey, Vars } from '../i18n/index.ts';
import { canControlPlayback, ephemeral, requester, say, userLocale } from '../commands/shared.ts';
import { denial } from '../services/access.ts';
import type { PermKey } from '../services/access.ts';

/** Player-card button → the rule that governs it. */
const BUTTON_PERM: Record<string, PermKey> = {
  toggle: 'pause', skip: 'skip', stop: 'stop', disconnect: 'disconnect', clearqueue: 'clear',
  queue: 'queue', loop: 'loop', shuffle: 'shuffle', replay: 'play'
};

let BUTTON_COOLDOWN_MS = 5000;
const BUTTON_COOLDOWN_PRUNE_LIMIT = 500;

export function getButtonCooldownMs(): number { return BUTTON_COOLDOWN_MS; }
export function setButtonCooldownMs(ms: unknown): number {
  return BUTTON_COOLDOWN_MS = clampCooldownMs(ms, BUTTON_COOLDOWN_MS);
}

/** Seconds left on this user's button cooldown, or 0 (and starts a new window). */
function getButtonCooldownRemaining(state: GuildState, userId: string): number {
  const now = Date.now();
  if (state.buttonCooldowns.size >= BUTTON_COOLDOWN_PRUNE_LIMIT) {
    for (const [id, until] of state.buttonCooldowns) if (until <= now) state.buttonCooldowns.delete(id);
  }
  const until = state.buttonCooldowns.get(userId) ?? 0;
  if (until > now) return Math.ceil((until - now) / 1000);
  state.buttonCooldowns.set(userId, now + BUTTON_COOLDOWN_MS);
  return 0;
}

async function dismiss(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate().catch(() => {});
  await interaction.message.delete().catch(() => {});
}

const nextPage = (pageText: string | undefined, action: string) => (parseInt(pageText ?? '', 10) || 1) + (action === 'next' ? 1 : -1);

export async function handleButton(interaction: ButtonInteraction): Promise<unknown> {
  const parts = interaction.customId.split(':');
  const [prefix, action = '', guildId = ''] = parts;
  const locale = userLocale(interaction);
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;

  // DM / housekeeping buttons — keep working during maintenance
  switch (prefix) {
    case 'dmremove': // dmremove:<kind>:<userId>
      if (parts[2] !== interaction.user.id) return say(interaction, 'common.not_your_message');
      return dismiss(interaction);

    case 'memreset': { // memreset:<scope>:<guildId>:<userId>
      if (parts[3] !== interaction.user.id) return say(interaction, 'common.not_your_message');
      if (action === 'history') await resetGuildHistory(guildId);
      else if (action === 'messages') await resetGuildMessages(guildId);
      else await Promise.all([resetGuildMemory(guildId), resetGuildMessages(guildId)]);
      return dismiss(interaction);
    }

    case 'announce': // announce:remove:<guildId>
      if (!isAdmin && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return say(interaction, 'common.admins_only');
      return dismiss(interaction);

    case 'statsremove': // statsremove:<guildId>
      if (!isAdmin) return say(interaction, 'common.admins_only');
      clearStatsMessage(action);
      return dismiss(interaction);

    case 'setup': // setup:start — the setup card's "Get started"
      return say(interaction, 'setup.start.reply');

    case 'history': // history:<prev|next>:<guildId>:<page>:<userId>
      if (parts[4] !== interaction.user.id) return say(interaction, 'common.not_your_message');
      return interaction.update(buildHistoryMessage(guildId, nextPage(parts[3], action), interaction.user.id, locale)).catch(() => {});
  }

  if (!interaction.inCachedGuild()) return;

  if (prefix === 'queuepage') { // queuepage:<prev|next>:<guildId>:<page>:<userId>
    if (parts[4] !== interaction.user.id) return say(interaction, 'common.not_your_message');
    const state = getState(guildId);
    if (!await canControlPlayback(interaction, state)) return;
    return interaction.update(buildQueueMessage(guildId, state, nextPage(parts[3], action), interaction.user.id, locale)).catch(() => {});
  }

  if (prefix !== 'music') return;

  // Only the playback-control buttons are gated by maintenance.
  if (maintenanceBlocks(interaction.user.id, interaction.guildId)) return interaction.reply(ephemeral(maintenanceMessage(locale)));

  const permKey = BUTTON_PERM[action];
  const denied = permKey && denial(interaction.member, permKey, null);
  if (denied) return say(interaction, denied.key, denied.vars);

  const state = getState(guildId);
  if (!await canControlPlayback(interaction, state)) return;
  const cd = getButtonCooldownRemaining(state, interaction.user.id);
  if (cd > 0) return say(interaction, 'common.slow_down', { seconds: cd });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const followUp = (key: MessageKey, vars?: Vars) => interaction.followUp(ephemeral(t(locale, key, vars)));

  if (action === 'disconnect') {
    await followUp('disconnect.done');
    return disconnectGuild(guildId);
  }
  if (action === 'stop') {
    await stopPlayback(guildId);
    return followUp('stop.done');
  }

  state.textChannelId = interaction.channelId;

  switch (action) {
    case 'toggle': {
      const paused = await togglePause(guildId); // also refreshes the card
      return followUp(paused == null ? 'common.nothing_playing' : paused ? 'pause.paused' : 'pause.resumed');
    }
    case 'skip':
      if (!state.current) return followUp('common.nothing_playing');
      await stopTrack(guildId); // the 'stopped' end event advances + reposts the card
      return followUp('skip.done');

    case 'clearqueue':
      await clearQueue(guildId); // also refreshes the card
      return followUp('queue.cleared');

    case 'queue':
      await upsertController(guildId, state);
      return interaction.editReply(buildQueueMessage(guildId, state, 1, interaction.user.id, locale));

    case 'loop': {
      if (!state.current) return followUp('common.nothing_playing');
      const mode = await toggleLoopMode(guildId);
      return followUp(mode === 'track' ? 'loop.track' : mode === 'queue' ? 'loop.queue' : 'loop.off');
    }

    case 'shuffle': {
      const q = state.queue;
      if (!q.length) return followUp('queue.empty');
      for (let i = q.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [q[i], q[j]] = [q[j]!, q[i]!];
      }
      await upsertController(guildId, state);
      return followUp('queue.shuffled');
    }

    case 'replay': {
      const last = state.lastPlayed;
      if (!last?.uri && !last?.title) return followUp('replay.nothing');
      try {
        await ensurePlayer(interaction);
      } catch (err) {
        if (err instanceof UserError) return followUp(err.key, err.vars);
        throw err;
      }
      const node = pickNode(interaction.client);
      if (!node) return followUp('common.music_server_down');
      const [track] = tracksOf(await node.rest.resolve(last.uri || `ytsearch:${last.title}`));
      if (!track) return followUp('replay.not_found');
      state.queue.unshift({ ...track, ...requester(interaction) });
      if (state.current) await upsertController(guildId, state);
      else await playNext(guildId);
      return followUp('replay.done');
    }
  }
}
