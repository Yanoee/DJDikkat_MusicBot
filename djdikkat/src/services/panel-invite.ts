/************************************************************
 * DJ DIKKAT - Music Bot
 * Panel invites
 * DMs for the Panel access list: the invite (banner with the
 * server and the level, a one-time sign-up link to the animated
 * /auth/invite page) when an admin adds someone or someone gets
 * a role on the list, and a short note when an admin removes
 * them. At most 20 invites per server per hour.
 * Author: Yanoee
 ************************************************************/
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MediaGalleryBuilder, MessageFlags,
  PermissionFlagsBits, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder
} from 'discord.js';
import type { Guild, GuildMember, PartialGuildMember } from 'discord.js';
import { createClaim } from './claims.ts';
import { getPermissions, panelLevel } from './access.ts';
import { guildLocale } from './locale.ts';
import { renderInvite } from '../ui/banner-image.ts';
import { config } from '../config.ts';
import { t } from '../i18n/index.ts';
import { errMsg } from '../lib/errors.ts';

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const PER_HOUR = 20;
const IMAGE = 'invite.png';
const recent = new Map<string, number[]>();   // guildId → send times in the last hour

const text = (content: string) => new TextDisplayBuilder().setContent(content);

/** One more invite from this server this hour? */
function budget(guildId: string): boolean {
  const now = Date.now();
  const times = (recent.get(guildId) ?? []).filter(at => now - at < 3_600_000);
  if (times.length >= PER_HOUR) return false;
  recent.set(guildId, [...times, now]);
  return true;
}

/** The invite DM: banner, who gave access and what it opens, the sign-up button. */
export async function buildInvite(guild: Guild, level: 1 | 2, admin: string | null, url: string) {
  const locale = guildLocale(guild.id, guild);
  const banner = await renderInvite({
    kicker: t(locale, 'invite.img.kicker'), server: guild.name, badge: t(locale, `invite.img.level${level}`), level,
    iconUrl: guild.iconURL({ extension: 'png', size: 256 }), locale
  });
  const card = new ContainerBuilder().setAccentColor(level === 1 ? 0xc97425 : 0x4f97da)
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(item => item.setURL(`attachment://${IMAGE}`)))
    .addTextDisplayComponents(
      text(`## ${admin ? t(locale, 'invite.title', { admin }) : t(locale, 'invite.title_role')}\n${t(locale, level === 1 ? 'invite.body.full' : 'invite.body.dj', { server: guild.name })}`))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(locale, 'invite.btn')).setEmoji('🎧').setURL(url)))
    .addTextDisplayComponents(text(`-# ${t(locale, 'invite.fine', { server: guild.name })}`));
  return { components: [card], files: [new AttachmentBuilder(banner, { name: IMAGE })], flags: MessageFlags.IsComponentsV2 as const };
}

/** Sends the invite with a fresh one-time link. False when the DM can't be delivered or the hourly budget is used up. */
export async function sendPanelInvite(guild: Guild, userId: string, level: 1 | 2, admin: string | null): Promise<boolean> {
  if (!budget(guild.id)) return false;
  try {
    const user = await guild.client.users.fetch(userId);
    const { token } = await createClaim(user, guild, INVITE_TTL_MS);
    await user.send(await buildInvite(guild, level, admin, `${config.publicUrl}/auth/invite#${token}`));
    return true;
  } catch (err) {
    console.warn(`[INVITE] guild=${guild.id} user=${userId} ${errMsg(err)}`);
    return false;
  }
}

/** "Your panel access was removed", unless they still get in through a role or Manage Server. */
export async function sendAccessRemoved(guild: Guild, userId: string): Promise<void> {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member || panelLevel(member)) return;
  const locale = guildLocale(guild.id, guild);
  const card = new ContainerBuilder().setAccentColor(0x5e5a54)
    .addTextDisplayComponents(text(`### ${t(locale, 'invite.removed.title')}\n${t(locale, 'invite.removed.body', { server: guild.name })}`));
  await member.send({ components: [card], flags: MessageFlags.IsComponentsV2 }).catch(err => console.warn(`[INVITE] removed note guild=${guild.id} user=${userId} ${errMsg(err)}`));
}

/**
 * "Also give a Discord role" from the Panel access list. Only a role the admin could hand out in Discord
 * themselves (owner, or Manage Roles and the role below their highest), and the bot too. True when the
 * panel added it now; false when it wasn't allowed, failed, or they already had it (then removal won't take it).
 */
export async function giveRole(guild: Guild, admin: GuildMember, userId: string, roleId: string): Promise<boolean> {
  const role = guild.roles.cache.get(roleId);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!role || !member || role.managed || role.id === guild.id || !role.editable || member.roles.cache.has(role.id)) return false;
  const allowed = admin.id === guild.ownerId
    || (admin.permissions.has(PermissionFlagsBits.ManageRoles) && admin.roles.highest.comparePositionTo(role) > 0);
  if (!allowed) return false;
  return member.roles.add(role, `DJ DIKKAT panel access, given by ${admin.user.tag}`).then(() => true, err => {
    console.warn(`[ACCESS] give role guild=${guild.id} user=${userId} ${errMsg(err)}`);
    return false;
  });
}

/** Takes back a role the panel gave, when that person leaves the Panel access list. */
export async function takeRole(guild: Guild, userId: string, roleId: string): Promise<void> {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member?.roles.cache.has(roleId) || !guild.roles.cache.get(roleId)?.editable) return;
  await member.roles.remove(roleId, 'DJ DIKKAT panel access removed').catch(err => console.warn(`[ACCESS] take role guild=${guild.id} user=${userId} ${errMsg(err)}`));
}

/** Someone just got a role on the Panel access list and had no panel access before: invite them. */
export async function onPanelRoleGained(old: GuildMember | PartialGuildMember, member: GuildMember): Promise<void> {
  if (old.partial || member.user.bot) return;   // without the old roles there's no telling what's new
  const grants = getPermissions(member.guild.id).panel.filter(g => g.type === 'role');
  if (!grants.some(g => member.roles.cache.has(g.id) && !old.roles.cache.has(g.id))) return;
  if (panelLevel(old)) return;
  const level = panelLevel(member);
  if (level === 'full' || level === 'dj') await sendPanelInvite(member.guild, member.id, level === 'full' ? 1 : 2, null);
}
