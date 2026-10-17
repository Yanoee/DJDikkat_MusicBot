/************************************************************
 * DJ DIKKAT - Music Bot
 * Launch
 * The one-time v6 launch: a post in every server's channel,
 * then one DM per server admin (whoever added the bot, else
 * the owner) with activation links for the web panel.
 * Only runs when the owner asks for it (POST /launch with
 * confirm "LAUNCH"). Slow on purpose (1 message per second),
 * and each server / admin is marked done in the DB, so a
 * restart or a second run never sends anything twice.
 * Author: Yanoee
 ************************************************************/
import type { Client, Guild } from 'discord.js';
import * as db from './db.ts';
import { getGuildMemory } from './memory.ts';
import { guildLocale } from './locale.ts';
import { getConfig, setConfig } from './config-store.ts';
import { findAnnouncementChannel, guildAdminId } from './announcement.ts';
import { createClaim, hasUsedPanel } from './claims.ts';
import { buildLaunchDm, buildLaunchPost } from '../ui/launch-card.ts';
import type { AdminServer } from '../ui/launch-card.ts';
import { config } from '../config.ts';
import { errMsg } from '../lib/errors.ts';

const STEP_MS = 1000;
const ACTIVATION_TTL_MS = 24 * 60 * 60 * 1000;   // a day: admins read the launch DM late; one use, and /panel gives a new one

export interface LaunchStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  servers: { total: number; posted: number; noChannel: number; failed: number };
  admins: { total: number; sent: number; failed: number; activations: number };
  stopRequested: boolean;
}

const fresh = (): LaunchStatus => ({
  running: false, startedAt: null, finishedAt: null, stopRequested: false,
  servers: { total: 0, posted: 0, noChannel: 0, failed: 0 }, admins: { total: 0, sent: 0, failed: 0, activations: 0 }
});
let status: LaunchStatus = fresh();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const launchStatus = () => status;

async function launchedGuildIds(): Promise<Set<string>> {
  const rows = await db.query<{ guild_id: string }[]>('SELECT guild_id FROM guilds WHERE launched_at IS NOT NULL');
  return new Set(rows.map(r => r.guild_id));
}

/** What a run would do right now, without sending anything (uses known inviters / owners, no audit-log calls). */
export async function launchPlan(client: Client<true>) {
  const done = await launchedGuildIds();
  const dmed = new Set(getConfig('launchDmed') ?? []);
  const todo = [...client.guilds.cache.values()].filter(g => !done.has(g.id));
  const admins = new Set(todo.map(g => getGuildMemory(g.id).settings.inviterId ?? g.ownerId));
  return {
    serversLeft: todo.length,
    serversDone: done.size,
    withChannel: todo.filter(g => findAnnouncementChannel(g, getGuildMemory(g.id).settings)).length,
    adminsLeft: [...admins].filter(id => !dmed.has(id)).length
  };
}

/** Runs the launch in the background. Returns false if one is already running. */
export function startLaunch(client: Client<true>): boolean {
  if (status.running) return false;
  status = { ...fresh(), running: true, startedAt: new Date().toISOString() };
  run(client).catch(err => console.error('[LAUNCH] stopped by an error:', err)).finally(() => {
    status.running = false;
    status.finishedAt = new Date().toISOString();
    console.log(`[LAUNCH] finished: ${JSON.stringify(status)}`);
  });
  return true;
}

/**
 * Preview for the owner: the channel post in one channel and/or the admin DM to one user, for one server.
 * Uses the real messages (and a real activation link when asked) but marks nothing as launched.
 */
export async function sendLaunchPreview(client: Client<true>, opts: { guildId: string; channelId?: string; userId?: string; activate?: boolean; postToUser?: boolean }) {
  const guild = client.guilds.cache.get(opts.guildId);
  if (!guild) return { error: 'not_in_guild' };
  const out: { post?: string; dm?: string } = {};
  const locale = guildLocale(guild.id, guild);
  if (opts.channelId) {
    const channel = guild.channels.cache.get(opts.channelId);
    out.post = channel?.isSendable() ? await channel.send(await buildLaunchPost(guild, locale)).then(() => 'sent', err => errMsg(err)) : 'no such channel';
  }
  if (opts.userId) {
    try {
      const user = await client.users.fetch(opts.userId);
      const activateUrl = opts.activate !== false
        ? `${config.publicUrl}/auth/activate#${(await createClaim(user, guild, ACTIVATION_TTL_MS)).token}` : null;
      if (opts.postToUser) await user.send(await buildLaunchPost(guild, locale));
      await user.send(await buildLaunchDm([{ guild, activateUrl }], locale));
      out.dm = 'sent';
    } catch (err) {
      out.dm = errMsg(err);
    }
  }
  return out;
}

export function stopLaunch(): void {
  status.stopRequested = true;
}

async function run(client: Client<true>): Promise<void> {
  const done = await launchedGuildIds();
  const guilds = [...client.guilds.cache.values()].filter(g => !done.has(g.id));
  status.servers.total = guilds.length;
  const byAdmin = new Map<string, Guild[]>();

  // 1. Channel posts
  for (const guild of guilds) {
    if (status.stopRequested) return;
    const adminId = await guildAdminId(guild).catch(() => guild.ownerId);
    if (!byAdmin.has(adminId)) byAdmin.set(adminId, []);
    byAdmin.get(adminId)!.push(guild);
    const channel = findAnnouncementChannel(guild, getGuildMemory(guild.id).settings);
    if (!channel) {
      status.servers.noChannel++;
    } else {
      try {
        await channel.send(await buildLaunchPost(guild, guildLocale(guild.id, guild)));
        status.servers.posted++;
      } catch (err) {
        status.servers.failed++;
        console.warn(`[LAUNCH] guild=${guild.id} post failed: ${errMsg(err)}`);
      }
    }
    await db.query('UPDATE guilds SET launched_at = UTC_TIMESTAMP(3) WHERE guild_id = ?', [guild.id]);
    await sleep(STEP_MS);
  }

  // 2. One DM per admin, for all of their servers
  const dmed = new Set(getConfig('launchDmed') ?? []);
  const admins = [...byAdmin].filter(([id]) => !dmed.has(id));
  status.admins.total = admins.length;
  for (const [adminId, servers] of admins) {
    if (status.stopRequested) return;
    try {
      const user = await client.users.fetch(adminId);
      const newcomer = !await hasUsedPanel(adminId);
      const list: AdminServer[] = [];
      for (const guild of servers) {
        const activateUrl = newcomer && config.internal.panelSecret
          ? `${config.publicUrl}/auth/activate#${(await createClaim(user, guild, ACTIVATION_TTL_MS)).token}` : null;
        if (activateUrl) status.admins.activations++;
        list.push({ guild, activateUrl });
      }
      await user.send(await buildLaunchDm(list, guildLocale(servers[0]!.id, servers[0])));
      status.admins.sent++;
    } catch (err) {
      status.admins.failed++;
      console.warn(`[LAUNCH] admin=${adminId} DM failed: ${errMsg(err)}`);
    }
    dmed.add(adminId);
    setConfig('launchDmed', [...dmed]);
    await sleep(STEP_MS);
  }
}
