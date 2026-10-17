/************************************************************
 * DJ DIKKAT - Music Bot
 * Switchable features
 * Leave messages, auto-role and two AutoMod filters (links /
 * invites, bad words), each turned on from the web panel.
 * The filters are Discord AutoMod rules the bot creates, so
 * Discord blocks the messages itself, even when the bot is
 * offline, and the bot never has to read messages.
 * Author: Yanoee
 ************************************************************/
import { AutoModerationActionType, AutoModerationRuleEventType, AutoModerationRuleTriggerType, PermissionFlagsBits } from 'discord.js';
import type { Guild, GuildMember, PartialGuildMember } from 'discord.js';
import { getGuildMemory, setGuildSettings } from './memory.ts';
import { TEXT_TYPES } from './access.ts';
import { errMsg } from '../lib/errors.ts';

export interface GuildFeatures {
  leave: { enabled: boolean; channelId: string | null; text: string };
  autorole: { enabled: boolean; roles: string[] };
  links: { enabled: boolean; mode: 'invites' | 'all'; allow: string[]; ruleId: string | null };
  words: { enabled: boolean; words: string[]; presets: number[]; ruleId: string | null; presetRuleId: string | null };
  reminder: { enabled: boolean };   // the weekly "free, Patreon if you like" post
}

const MAX_AUTOROLES = 5;
const MAX_ALLOW = 50;
const MAX_WORDS = 500;
const PRESETS = [1, 2, 3]; // Discord's lists: profanity, sexual content, slurs
const INVITE_RE = '(discord\\.gg|discord(app)?\\.com/invite)/\\S+';
const LINK_RE = 'https?://\\S+';
const RULE_LINKS = 'DJ DIKKAT: links';
const RULE_WORDS = 'DJ DIKKAT: words';
const RULE_PRESET = 'DJ DIKKAT: word lists';

export const defaultFeatures = (): GuildFeatures => ({
  leave: { enabled: false, channelId: null, text: '' },
  autorole: { enabled: false, roles: [] },
  links: { enabled: false, mode: 'invites', allow: [], ruleId: null },
  words: { enabled: false, words: [], presets: [], ruleId: null, presetRuleId: null },
  reminder: { enabled: true }
});

export function getFeatures(guildId: string): GuildFeatures {
  const base = defaultFeatures();
  const saved = getGuildMemory(guildId).settings.features;
  if (!saved) return base;
  return {
    leave: { ...base.leave, ...saved.leave },
    autorole: { ...base.autorole, ...saved.autorole },
    links: { ...base.links, ...saved.links },
    words: { ...base.words, ...saved.words },
    reminder: { ...base.reminder, ...saved.reminder }
  };
}

/** What each feature needs from the bot's own permissions (missing ones are listed in the panel). */
export function featureNeeds(guild: Guild): Record<keyof GuildFeatures, string[]> {
  const me = guild.members.me;
  const has = (flag: bigint) => !!me?.permissions.has(flag);
  return {
    leave: [],
    autorole: has(PermissionFlagsBits.ManageRoles) ? [] : ['manage_roles'],
    links: has(PermissionFlagsBits.ManageGuild) ? [] : ['manage_guild'],
    words: has(PermissionFlagsBits.ManageGuild) ? [] : ['manage_guild'],
    reminder: []
  };
}

const list = (v: unknown, max: number, len: number) => Array.isArray(v)
  ? [...new Set(v.filter((s): s is string => typeof s === 'string').map(s => s.trim().toLowerCase().slice(0, len)).filter(Boolean))].slice(0, max)
  : [];

/** Keeps known fields; roles the bot can't hand out and channels that aren't text channels are dropped. */
export function sanitizeFeatures(guild: Guild, input: unknown, current: GuildFeatures): GuildFeatures {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, Record<string, unknown> | undefined>;
  const on = (k: keyof GuildFeatures) => raw[k]?.enabled === true;
  const leaveChannel = typeof raw.leave?.channelId === 'string' && TEXT_TYPES.includes(guild.channels.cache.get(raw.leave.channelId)?.type as never)
    ? raw.leave.channelId : null;
  const roles = Array.isArray(raw.autorole?.roles)
    ? raw.autorole.roles.filter((id): id is string => typeof id === 'string' && !!guild.roles.cache.get(id)?.editable && id !== guild.id).slice(0, MAX_AUTOROLES)
    : [];
  return {
    leave: { enabled: on('leave'), channelId: leaveChannel, text: typeof raw.leave?.text === 'string' ? raw.leave.text.slice(0, 1000) : '' },
    autorole: { enabled: on('autorole'), roles },
    links: {
      enabled: on('links'), mode: raw.links?.mode === 'all' ? 'all' : 'invites',
      allow: list(raw.links?.allow, MAX_ALLOW, 60).map(d => d.replace(/^https?:\/\//, '').replace(/\/.*$/, '')), ruleId: current.links.ruleId
    },
    words: {
      enabled: on('words'), words: list(raw.words?.words, MAX_WORDS, 60),
      presets: Array.isArray(raw.words?.presets) ? PRESETS.filter(p => (raw.words!.presets as unknown[]).includes(p)) : [],
      ruleId: current.words.ruleId, presetRuleId: current.words.presetRuleId
    },
    reminder: { enabled: raw.reminder ? on('reminder') : current.reminder.enabled }
  };
}

// ── AutoMod ───────────────────────────────────────────────

/** Creates, updates or removes one of our rules. Returns the rule ID to keep (null = none). */
async function syncRule(guild: Guild, ruleId: string | null, want: boolean, build: () => Parameters<Guild['autoModerationRules']['create']>[0]): Promise<string | null> {
  const rules = guild.autoModerationRules;
  const existing = ruleId ? await rules.fetch(ruleId).catch(() => null) : null;
  if (!want) {
    if (existing) await rules.delete(existing.id, 'Turned off in the DJ DIKKAT panel');
    return null;
  }
  const data = build();
  if (existing) return (await rules.edit(existing.id, data)).id;
  return (await rules.create(data)).id;
}

/**
 * Brings this server's AutoMod rules in line with the settings. Returns an error code for the
 * panel ('manage_guild', 'automod_full', 'automod_preset_taken') or null when everything is in place.
 */
async function syncAutomod(guild: Guild, f: GuildFeatures, blockedText: string): Promise<string | null> {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return f.links.enabled || f.words.enabled ? 'manage_guild' : null;
  }
  const block = [{ type: AutoModerationActionType.BlockMessage, metadata: { customMessage: blockedText.slice(0, 150) } }];
  const base = { eventType: AutoModerationRuleEventType.MessageSend, actions: block, enabled: true, reason: 'DJ DIKKAT panel' };
  try {
    f.links.ruleId = await syncRule(guild, f.links.ruleId, f.links.enabled, () => ({
      ...base, name: RULE_LINKS, triggerType: AutoModerationRuleTriggerType.Keyword,
      triggerMetadata: { regexPatterns: [f.links.mode === 'all' ? LINK_RE : INVITE_RE], allowList: f.links.allow.map(d => `*${d}*`) }
    }));
    f.words.ruleId = await syncRule(guild, f.words.ruleId, f.words.enabled && f.words.words.length > 0, () => ({
      ...base, name: RULE_WORDS, triggerType: AutoModerationRuleTriggerType.Keyword,
      triggerMetadata: { keywordFilter: f.words.words }
    }));
    f.words.presetRuleId = await syncRule(guild, f.words.presetRuleId, f.words.enabled && f.words.presets.length > 0, () => ({
      ...base, name: RULE_PRESET, triggerType: AutoModerationRuleTriggerType.KeywordPreset,
      triggerMetadata: { presets: f.words.presets }
    }));
    return null;
  } catch (err) {
    const msg = errMsg(err);
    console.warn(`[AUTOMOD] guild=${guild.id} sync failed: ${msg}`);
    if (/preset/i.test(msg)) return 'automod_preset_taken';
    if (/maximum|limit/i.test(msg)) return 'automod_full';
    return 'server';
  }
}

/** Saves the panel's settings and syncs AutoMod. The error code (if any) is for the panel; what worked is kept. */
export async function saveFeatures(guild: Guild, input: unknown, blockedText: string): Promise<{ features: GuildFeatures; error: string | null }> {
  const next = sanitizeFeatures(guild, input, getFeatures(guild.id));
  const error = await syncAutomod(guild, next, blockedText);
  setGuildSettings(guild.id, { features: next });
  return { features: next, error };
}

// ── Member events ─────────────────────────────────────────

/** Auto-role for a member who has passed Discord's membership screening. */
export async function giveAutoroles(member: GuildMember): Promise<void> {
  const { autorole } = getFeatures(member.guild.id);
  if (!autorole.enabled || member.pending || member.user.bot) return;
  const roles = autorole.roles.filter(id => member.guild.roles.cache.get(id)?.editable && !member.roles.cache.has(id));
  if (roles.length) await member.roles.add(roles, 'DJ DIKKAT auto-role').catch(err => console.warn(`[AUTOROLE] guild=${member.guild.id} ${errMsg(err)}`));
}

/** "X left the server". Names only, never pings. */
export async function onMemberLeave(member: GuildMember | PartialGuildMember): Promise<void> {
  const { leave } = getFeatures(member.guild.id);
  if (!leave.enabled || !leave.channelId || !leave.text.trim() || member.user?.bot) return;
  const channel = member.guild.channels.cache.get(leave.channelId);
  if (!channel?.isSendable()) return;
  const name = member.displayName ?? member.user?.username ?? 'Someone';
  const text = leave.text
    .replace(/\{user(\.name)?\}/g, name).replace(/\{user\.tag\}/g, member.user?.username ?? name)
    .replace(/\{server\}/g, member.guild.name).replace(/\{memberCount\}/g, String(member.guild.memberCount))
    .replace(/\{date\}/g, `<t:${Math.floor(Date.now() / 1000)}:D>`);
  await channel.send({ content: text, allowedMentions: { parse: [] } }).catch(err => console.warn(`[LEAVE] guild=${member.guild.id} ${errMsg(err)}`));
}
