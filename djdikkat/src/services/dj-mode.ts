/************************************************************
 * DJ DIKKAT - Music Bot
 * DJ mode rollout
 * The one-time switch of existing servers to Normal mode (a
 * DJ role for the disruptive controls), then one DM per
 * server admin: what changed, how to undo it, and their free
 * web panel. Only servers that never saved their own rules
 * are switched; the rest are listed as "kept".
 * Owner only: POST /dj-mode with dryRun, or confirm "DJ".
 * Slow on purpose (1 step per second); admins already DMed
 * are remembered, so a second run never DMs twice.
 * Author: Yanoee
 ************************************************************/
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, SeparatorBuilder, SeparatorSpacingSize,
  StringSelectMenuBuilder, TextDisplayBuilder
} from 'discord.js';
import type { Client, Guild } from 'discord.js';
import { PermissionFlagsBits } from 'discord.js';
import { enableDjMode } from './access.ts';
import { getGuildMemory } from './memory.ts';
import { guildLocale } from './locale.ts';
import { getConfig, setConfig } from './config-store.ts';
import { guildAdminId } from './announcement.ts';
import { createClaim, hasUsedPanel } from './claims.ts';
import { config } from '../config.ts';
import { LOCALES, t } from '../i18n/index.ts';
import type { Locale } from '../i18n/index.ts';
import { errMsg } from '../lib/errors.ts';

const STEP_MS = 1000;
const ACCENT = 0x3b82c4;
const FLAGS: Record<Locale, string> = { en: '🇬🇧', tr: '🇹🇷' };
// ponytail: the language picker's customId carries the server IDs (100 chars max), so it redraws up to 4 servers; add a stored list if an admin ever has more.
const PICKER_SERVERS = 4;
const ACTIVATION_TTL_MS = 24 * 60 * 60 * 1000;   // like the launch DM: one use, a day; /panel gives a new one
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** role: DJ role ready / can't be made / server keeps its own rules. activateUrl: one-time panel switch-on link (admins new to the panel). */
export interface DjServer { guild: Guild; role: RoleStatus; activateUrl?: string | null }
type RoleStatus = 'ready' | 'missing' | 'kept';
const ROLE_CODE: Record<RoleStatus, string> = { ready: 'r', missing: 'm', kept: 'k' };

const status = { running: false, servers: 0, roles: 0, noRole: 0, kept: 0, admins: 0, sent: 0, failed: 0, activations: 0, finishedAt: null as string | null };
export const djModeStatus = () => status;

const untouched = (client: Client<true>) => [...client.guilds.cache.values()].filter(g => !getGuildMemory(g.id).settings.permissions);
const djRoleReady = (guild: Guild) =>
  guild.roles.cache.some(r => !r.managed && r.name.toLowerCase() === 'dj') || !!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles);
const roleStatus = (guild: Guild): RoleStatus =>
  getGuildMemory(guild.id).settings.permissions ? 'kept' : djRoleReady(guild) ? 'ready' : 'missing';

/** What a run would change, without changing anything. */
export function djModePlan(client: Client<true>) {
  const servers = untouched(client).map(g => ({ id: g.id, name: g.name, members: g.memberCount, role: djRoleReady(g) }));
  return { servers: servers.length, withRole: servers.filter(s => s.role).length, kept: client.guilds.cache.size - servers.length, list: servers };
}

/** The admin DM: DJ role per server, how to undo it, and the free web panel (switch-on links for newcomers). */
export function buildDjNotice(servers: DjServer[], locale: Locale) {
  const site = config.publicUrl;
  const text = (content: string) => new TextDisplayBuilder().setContent(content);
  const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
  const activate = servers.some(s => s.activateUrl);
  const list = servers.map(s => `- **${s.guild.name}**: ${t(locale, `djmode.dm.role_${s.role}`)}`).join('\n');
  const buttons = servers.slice(0, 5).map(s => s.activateUrl
    ? new ButtonBuilder().setStyle(ButtonStyle.Link).setEmoji('🔑').setLabel(t(locale, 'launch.dm.activate', { server: s.guild.name.slice(0, 50) })).setURL(s.activateUrl)
    : new ButtonBuilder().setStyle(ButtonStyle.Link).setEmoji('🎛️')
      .setLabel(servers.length > 1 ? s.guild.name.slice(0, 80) : t(locale, 'djmode.dm.btn')).setURL(`${site}/dashboard/${s.guild.id}/permissions`));
  const card = new ContainerBuilder().setAccentColor(ACCENT)
    .addTextDisplayComponents(text(`## ${t(locale, 'djmode.dm.title')}\n${t(locale, 'djmode.dm.intro')}`))
    .addSeparatorComponents(line())
    .addTextDisplayComponents(
      text(t(locale, 'djmode.dm.rules')),
      text(`### ${t(locale, 'djmode.dm.servers')}\n${list}`),
      text(t(locale, 'djmode.dm.undo')),
      text(`### ${t(locale, 'djmode.dm.panel.head')}\n${t(locale, activate ? 'djmode.dm.panel.activate' : 'djmode.dm.panel.open')}`)
    )
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons));
  if (activate) card.addTextDisplayComponents(text(`-# ${t(locale, 'launch.dm.fine_print')}`));
  if (servers.length <= PICKER_SERVERS) {
    card.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(`djmode:lang:${servers.map(s => s.guild.id + ROLE_CODE[s.role]).join(',')}`).addOptions(LOCALES.map(l => ({
        label: t(l, `language.name.${l}`), value: l, emoji: FLAGS[l], default: l === locale
      })))));
  }
  return { components: [card], flags: MessageFlags.IsComponentsV2 as const };
}

/**
 * The notice again (language picker): servers from the picker's customId ("<id><r|m|k>,…"),
 * switch-on links taken back from the message's own link buttons, in the same order.
 */
export function djServers(client: Client, ids: string[], linkUrls: string[]): DjServer[] {
  const codes = Object.fromEntries(Object.entries(ROLE_CODE).map(([k, v]) => [v, k as RoleStatus]));
  return ids.flatMap((raw, i) => {
    const guild = client.guilds.cache.get(raw.slice(0, -1));
    const role = codes[raw.slice(-1)];
    if (!guild || !role) return [];
    const url = linkUrls[i];
    return [{ guild, role, activateUrl: url?.includes('/auth/activate#') ? url : null }];
  });
}

/** The admin DM for one server, sent to one user (the owner checking it). Changes nothing. */
export async function sendDjPreview(client: Client<true>, guildId: string, userId: string): Promise<string> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return 'not_in_guild';
  const user = await client.users.fetch(userId);
  await user.send(buildDjNotice([{ guild, role: roleStatus(guild) }], guildLocale(guild.id, guild)));
  return 'sent';
}

export function startDjMode(client: Client<true>): boolean {
  if (status.running) return false;
  Object.assign(status, { running: true, servers: 0, roles: 0, noRole: 0, kept: 0, admins: 0, sent: 0, failed: 0, activations: 0, finishedAt: null });
  run(client).catch(err => console.error(`[DJMODE] stopped: ${errMsg(err)}`))
    .finally(() => { status.running = false; status.finishedAt = new Date().toISOString(); });
  return true;
}

async function run(client: Client<true>): Promise<void> {
  const byAdmin = new Map<string, DjServer[]>();
  // 1. Every server: Normal mode where no rules were saved (the DM goes out right after), "kept" elsewhere.
  for (const guild of client.guilds.cache.values()) {
    let role: RoleStatus = 'kept';
    if (!getGuildMemory(guild.id).settings.permissions) {
      const res = await enableDjMode(guild).catch(err => { console.warn(`[DJMODE] guild=${guild.id} failed: ${errMsg(err)}`); return null; });
      if (!res?.applied) continue;
      status.servers++;
      if (res.roleId) status.roles++; else status.noRole++;
      role = res.roleId ? 'ready' : 'missing';
      console.log(`[DJMODE] guild=${guild.id} normal mode, role=${res.roleId ?? 'none'}${res.created ? ' (created)' : ''}`);
      await sleep(STEP_MS);
    } else status.kept++;
    const adminId = await guildAdminId(guild).catch(() => guild.ownerId);
    if (!byAdmin.has(adminId)) byAdmin.set(adminId, []);
    byAdmin.get(adminId)!.push({ guild, role });
  }

  // 2. One DM per admin, for all of their servers; switch-on links for admins who never used the panel
  const dmed = new Set(getConfig('djDmed') ?? []);
  const admins = [...byAdmin].filter(([id]) => !dmed.has(id));
  status.admins = admins.length;
  for (const [adminId, servers] of admins) {
    try {
      const user = await client.users.fetch(adminId);
      if (config.internal.panelSecret && !await hasUsedPanel(adminId)) {
        for (const s of servers.slice(0, 5)) {
          s.activateUrl = `${config.publicUrl}/auth/activate#${(await createClaim(user, s.guild, ACTIVATION_TTL_MS)).token}`;
          status.activations++;
        }
      }
      await user.send(buildDjNotice(servers, guildLocale(servers[0]!.guild.id, servers[0]!.guild)));
      status.sent++;
    } catch (err) {
      status.failed++;
      console.warn(`[DJMODE] admin=${adminId} DM failed: ${errMsg(err)}`);
    }
    dmed.add(adminId);
    setConfig('djDmed', [...dmed]);
    await sleep(STEP_MS);
  }
}
