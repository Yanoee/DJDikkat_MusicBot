/************************************************************
 * DJ DIKKAT - Music Bot
 * Command helpers
 * The Command shape plus replies, voice gate and DMs shared by
 * the slash commands and the player-card buttons.
 * Author: Yanoee
 ************************************************************/
import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type {
  AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction, RepliableInteraction, SlashCommandOptionsOnlyBuilder
} from 'discord.js';
import { getState } from '../music/state.ts';
import type { GuildState } from '../music/state.ts';
import { trackDm } from '../services/dm-store.ts';
import { localizations, t, toLocale } from '../i18n/index.ts';
import type { Locale, MessageKey, Vars } from '../i18n/index.ts';

export const MAX_QUEUE = 25;
export const PAGE_SIZE = 10;
export const STATS_AUTO_DELETE_MS = 3 * 60 * 1000;

export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction<'cached'>): Promise<unknown>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<unknown>;
}

/** A guild-only slash command whose description is localized from the catalogs. */
export function slash(name: string, description: MessageKey): SlashCommandBuilder {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(t('en', description))
    .setDescriptionLocalizations(localizations(description))
    .setContexts(InteractionContextType.Guild);
}

export const ephemeral = (content: string) => ({ content, flags: MessageFlags.Ephemeral } as const);

/** The invoking user's language; every ephemeral reply uses it. */
export const userLocale = (interaction: { locale: string }): Locale => toLocale(interaction.locale);

/** Ephemeral reply in the user's language (follow-up once the interaction is acknowledged). */
export function say(interaction: RepliableInteraction, key: MessageKey, vars?: Vars) {
  const payload = ephemeral(t(userLocale(interaction), key, vars));
  return interaction.deferred || interaction.replied ? interaction.followUp(payload) : interaction.reply(payload);
}

/** Replaces a deferred reply's "thinking…" with a message in the user's language. */
export function edit(interaction: RepliableInteraction, key: MessageKey, vars?: Vars) {
  return interaction.editReply(t(userLocale(interaction), key, vars));
}

export function requester(interaction: RepliableInteraction) {
  return { requesterId: interaction.user.id, requesterTag: interaction.user.tag };
}

export function canManageGuild(interaction: RepliableInteraction): boolean {
  const perms = interaction.memberPermissions;
  return !!perms && (perms.has(PermissionFlagsBits.ManageGuild) || perms.has(PermissionFlagsBits.Administrator));
}

/** Voice gate for playback controls; replies and returns false when the user can't control. */
export async function canControlPlayback(
  interaction: ChatInputCommandInteraction<'cached'> | ButtonInteraction<'cached'>, state: GuildState
): Promise<boolean> {
  const memberChannelId = interaction.member.voice.channelId;
  if (!state.voiceChannelId) {
    if (memberChannelId) return true;
    await say(interaction, 'voice.join_first');
    return false;
  }
  if (!memberChannelId) {
    await say(interaction, 'voice.join_mine');
    return false;
  }
  if (memberChannelId !== state.voiceChannelId) {
    await say(interaction, 'voice.wrong_channel', { channel: state.voiceChannelId });
    return false;
  }
  return true;
}

/** Guild state if the user may control playback (and remembers this channel for the card), else null. */
export async function playbackState(interaction: ChatInputCommandInteraction<'cached'>): Promise<GuildState | null> {
  const state = getState(interaction.guildId);
  if (!await canControlPlayback(interaction, state)) return null;
  state.textChannelId = interaction.channelId;
  return state;
}

/** DMs the user and confirms in the deferred reply. */
export async function sendDm(
  interaction: ChatInputCommandInteraction, payload: Parameters<ChatInputCommandInteraction['user']['send']>[0],
  type: string, done: MessageKey
) {
  try {
    const sent = await interaction.user.send(payload);
    await trackDm(sent.channel.id, sent.id, type).catch(() => {});
    return edit(interaction, done);
  } catch {
    return edit(interaction, 'common.dm_failed');
  }
}
