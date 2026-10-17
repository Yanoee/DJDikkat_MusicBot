/************************************************************
 * DJ DIKKAT - Music Bot
 * Access rules
 * Per-guild "who may use what, where", set on the web panel.
 * One check serves slash commands, player buttons and voice
 * joins. Manage Server / Administrator always pass, so nobody
 * can lock the server's admins out.
 * Author: Yanoee
 ************************************************************/
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { Guild, GuildMember } from 'discord.js';
import { getGuildMemory, setGuildSettings } from './memory.ts';
import type { MessageKey, Vars } from '../i18n/index.ts';

/** Everything a rule can be set for. /language, /panel and /health stay Manage Server / Admin only. */
export const PERM_KEYS = ['play', 'pause', 'skip', 'stop', 'disconnect', 'loop', 'shuffle', 'clear', 'queue', 'history', 'stats'] as const;
export type PermKey = typeof PERM_KEYS[number];

export interface CommandRule {
  enabled: boolean;
  who: 'everyone' | 'dj' | 'roles'; // 'roles' with no roles = admins only
  roles: string[];
  channels: string[];               // [] = the server's music text channels
}

export interface GuildPermissions {
  djRoles: string[];
  textChannels: string[];  // [] = any channel
  voiceChannels: string[]; // [] = any voice channel
  commands: Partial<Record<PermKey, CommandRule>>;
}

export interface Denial { key: MessageKey; vars?: Vars }

const MAX_ROLES = 25;
const MAX_CHANNELS = 50;
const DEFAULT_RULE: CommandRule = { enabled: true, who: 'everyone', roles: [], channels: [] };

export const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
export const VOICE_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];

export function emptyPermissions(): GuildPermissions {
  return { djRoles: [], textChannels: [], voiceChannels: [], commands: {} };
}

export function getPermissions(guildId: string): GuildPermissions {
  return { ...emptyPermissions(), ...getGuildMemory(guildId).settings.permissions };
}

export function isManager(member: GuildMember): boolean {
  return member.permissions.has(PermissionFlagsBits.ManageGuild) || member.permissions.has(PermissionFlagsBits.Administrator);
}

const roleList = (ids: string[]) => ids.map(id => `<@&${id}>`).join(' ');
const channelList = (ids: string[]) => ids.map(id => `<#${id}>`).join(' ');

/**
 * Why this member may not use `key` here, or null when they may.
 * channelId is the text channel of a slash command; buttons pass null
 * (they live on the player card, wherever it is).
 */
export function denial(member: GuildMember, key: PermKey, channelId: string | null): Denial | null {
  if (isManager(member)) return null;
  const perms = getPermissions(member.guild.id);
  const rule = { ...DEFAULT_RULE, ...perms.commands[key] };
  if (!rule.enabled) return { key: 'perm.disabled' };

  const channels = rule.channels.length ? rule.channels : perms.textChannels;
  if (channelId && channels.length) {
    const channel = member.guild.channels.cache.get(channelId);
    const where = channel?.isThread() ? channel.parentId : channelId;
    if (!where || !channels.includes(where)) return { key: 'perm.channel', vars: { channels: channelList(channels) } };
  }

  const roles = rule.who === 'dj' ? perms.djRoles : rule.who === 'roles' ? rule.roles : null;
  if (rule.who === 'roles' && !roles?.length) return { key: 'perm.admins' };
  if (roles?.length && !roles.some(id => member.roles.cache.has(id))) return { key: 'perm.role', vars: { roles: roleList(roles) } };
  return null;
}

/** Why the bot may not be called into this voice channel by this member, or null. */
export function voiceDenial(member: GuildMember, voiceChannelId: string): Denial | null {
  if (isManager(member)) return null;
  const { voiceChannels } = getPermissions(member.guild.id);
  return voiceChannels.length && !voiceChannels.includes(voiceChannelId)
    ? { key: 'perm.voice', vars: { channels: channelList(voiceChannels) } }
    : null;
}

// ── Saving from the web panel ─────────────────────────────

const ids = (value: unknown, valid: (id: string) => boolean, max: number): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && valid(v)))].slice(0, max) : [];

/** Keeps only known keys and IDs that exist in this guild right now. */
export function sanitizePermissions(guild: Guild, input: unknown): GuildPermissions {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const isRole = (id: string) => id !== guild.id && guild.roles.cache.has(id);
  const isText = (id: string) => TEXT_TYPES.includes(guild.channels.cache.get(id)?.type as ChannelType);
  const isVoice = (id: string) => VOICE_TYPES.includes(guild.channels.cache.get(id)?.type as ChannelType);

  const commands: GuildPermissions['commands'] = {};
  const rawCommands = (raw.commands && typeof raw.commands === 'object' ? raw.commands : {}) as Record<string, unknown>;
  for (const key of PERM_KEYS) {
    const r = rawCommands[key];
    if (!r || typeof r !== 'object') continue;
    const rule = r as Record<string, unknown>;
    const who = rule.who === 'dj' || rule.who === 'roles' ? rule.who : 'everyone';
    const clean: CommandRule = {
      enabled: rule.enabled !== false,
      who,
      roles: who === 'roles' ? ids(rule.roles, isRole, MAX_ROLES) : [],
      channels: ids(rule.channels, isText, MAX_CHANNELS)
    };
    // Rules equal to the default aren't stored.
    if (!clean.enabled || clean.who !== 'everyone' || clean.channels.length) commands[key] = clean;
  }
  return {
    djRoles: ids(raw.djRoles, isRole, MAX_ROLES),
    textChannels: ids(raw.textChannels, isText, MAX_CHANNELS),
    voiceChannels: ids(raw.voiceChannels, isVoice, MAX_CHANNELS),
    commands
  };
}

export function savePermissions(guildId: string, perms: GuildPermissions): void {
  const empty = !perms.djRoles.length && !perms.textChannels.length && !perms.voiceChannels.length && !Object.keys(perms.commands).length;
  setGuildSettings(guildId, { permissions: empty ? null : perms });
}
