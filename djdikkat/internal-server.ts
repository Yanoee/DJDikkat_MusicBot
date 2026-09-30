/************************************************************
 * DJ DIKKAT - Internal HTTP server
 * Localhost-only API so admin-api can trigger bot actions
 * Build 5.1.0
 * Author: Yanoee
 ************************************************************/
import http from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { ActivityType, PermissionFlagsBits } from 'discord.js';
import type { Client, PresenceData, PresenceStatusData } from 'discord.js';
import { sendCustomToAll, sendAnnouncement, sendOwnerWelcome } from './announcement.ts';
import { cleanDms, scanAndCleanDms } from './dm-store.ts';
import { getGuildMemory, getGuildMessagesRaw, resetGuildMemory, resetGuildHistory, resetGuildMessages, setGuildSettings } from './memory.ts';
import { getGuildStatsRaw } from './stats.ts';
import { peekState, getActiveVoiceCount, getCommandCooldownMs, setCommandCooldownMs } from './state.ts';
import { clearLogFile, getLogLevel, setLogLevel } from './logger.ts';
import { getMaintenance, setMaintenance } from './runtime-flags.ts';
import { deployCommands, getButtonCooldownMs, setButtonCooldownMs } from './commands.ts';
import { disconnectGuild, getRecoveryStats } from './player.ts';
import { getConfig, setConfig } from './config-store.ts';
import type { PresenceConfig } from './config-store.ts';
import { errMsg } from './errors.ts';

type Body = Record<string, unknown>;
type Reply = [status: number, data: unknown];

const ACTIVITY_TYPES: Record<string, ActivityType> = {
  Playing:   ActivityType.Playing,
  Listening: ActivityType.Listening,
  Watching:  ActivityType.Watching,
  Competing: ActivityType.Competing
};
const ACTIVITY_NAMES: Partial<Record<ActivityType, string>> = Object.fromEntries(
  Object.entries(ACTIVITY_TYPES).map(([name, type]) => [type, name]));

const MAINTENANCE_PRESENCE: PresenceData = {
  status: 'idle', // Discord's yellow/away status
  activities: [{ name: '🔨 Under Maintenance', type: ActivityType.Playing }]
};
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

const str = (v: unknown) => typeof v === 'string' ? v.trim() : '';

function toPresenceData(p: PresenceConfig): PresenceData {
  const type = p.type ? ACTIVITY_TYPES[p.type] : undefined;
  return {
    status: (p.status || 'online') as PresenceStatusData,
    activities: p.text && type !== undefined ? [{ name: p.text, type }] : []
  };
}

/** What's live right now, in the stored config shape. */
function currentPresence(client: Client<true>): PresenceConfig {
  const { status, activities: [activity] } = client.user.presence;
  return {
    status: status !== 'offline' ? status : 'online',
    type: activity ? ACTIVITY_NAMES[activity.type] ?? null : null,
    text: activity?.name ?? null
  };
}

// Presence to show at startup: the maintenance card if maintenance is on,
// else whatever an admin last set, else null (caller uses its default).
export function startupPresence(): PresenceData | null {
  if (getMaintenance().enabled) return MAINTENANCE_PRESENCE;
  const p = getConfig('presence');
  return p ? toPresenceData(p) : null;
}

// Guarded so a bad presence payload can't abort whatever the caller does next.
function applyPresence(client: Client<true>, data: PresenceData): void {
  try { client.user.setPresence(data); } catch (err) { console.warn(`[PRESENCE] Could not set presence: ${errMsg(err)}`); }
}

async function readBody(req: IncomingMessage): Promise<Body> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    const body: unknown = JSON.parse(raw);
    return body && typeof body === 'object' ? body as Body : {};
  } catch { return {}; }
}

/** Deletes the bot's messages among the last 100 of every readable text channel. */
async function nukeMessages(client: Client<true>, guildId: string) {
  await resetGuildMessages(guildId);
  const guild = client.guilds.cache.get(guildId);
  const me = guild?.members.me;
  let deleted = 0, failed = 0;
  if (!guild || !me) return { ok: true, deleted, failed };

  const now = Date.now();
  for (const channel of guild.channels.cache.values()) {
    if (!channel.isTextBased() || channel.isThread()) continue;
    try {
      if (!channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) continue;
      const msgs = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      const mine = [...(msgs?.values() ?? [])].filter(m => m.author.id === client.user.id);
      const recent = mine.filter(m => now - m.createdTimestamp < TWO_WEEKS_MS);
      // bulkDelete only takes 2+ messages younger than two weeks
      const single = recent.length > 1 ? mine.filter(m => !recent.includes(m)) : mine;
      if (recent.length > 1) deleted += (await channel.bulkDelete(recent, true).catch(() => null))?.size ?? 0;
      for (const msg of single) {
        if (await msg.delete().then(() => true, () => false)) deleted++; else failed++;
      }
    } catch { failed++; }
  }
  return { ok: true, deleted, failed };
}

function buildRoutes(client: Client<true>) {
  const cooldowns = () => ({ commandCooldownMs: getCommandCooldownMs(), buttonCooldownMs: getButtonCooldownMs() });
  const cachedGuild = (id: string) => client.guilds.cache.get(id);

  const routes: Record<string, (body: Body) => Promise<Reply> | Reply> = {
    'GET /guilds': () => {
      const recovery = getRecoveryStats();
      const guilds = [...client.guilds.cache.values()].map(g => {
        const state = peekState(g.id);
        return {
          id: g.id, name: g.name, memberCount: g.memberCount,
          icon: g.iconURL({ size: 64 }),
          joinedAt: g.joinedAt.toISOString(),
          playing: !!state?.current,
          paused: state?.paused ?? false,
          currentTrack: state?.current?.info.title ?? null,
          voiceChannelId: state?.voiceChannelId ?? null,
          recoveryAttempts1h: recovery[g.id] ?? 0
        };
      }).sort((a, b) => a.name.localeCompare(b.name));
      return [200, { guilds, total: guilds.length }];
    },

    'GET /stats': () => [200, { activeVoice: getActiveVoiceCount(), totalGuilds: client.guilds.cache.size }],

    'GET /presence': () => {
      const p = currentPresence(client);
      return [200, { status: client.user.presence.status, activityType: p.type, activityName: p.text }];
    },
    'POST /presence': ({ type, text, status }) => {
      const t = str(text);
      const hasActivity = !!t && typeof type === 'string' && type in ACTIVITY_TYPES;
      const config: PresenceConfig = { status: str(status) || 'online', type: hasActivity ? type : null, text: hasActivity ? t : null };
      client.user.setPresence(toPresenceData(config));
      setConfig('presence', config);
      return [200, { ok: true }];
    },

    // While maintenance is on, the presence that was live right before it is
    // kept in 'savedPresence', so switching it off restores the exact old
    // card — even across a restart mid-maintenance.
    'GET /maintenance': () => [200, getMaintenance()],
    'POST /maintenance': ({ enabled, message }) => {
      const was = getMaintenance().enabled;
      if (enabled && !was) {
        setConfig('savedPresence', currentPresence(client));
        applyPresence(client, MAINTENANCE_PRESENCE);
      } else if (!enabled && was) {
        // Nothing saved → leave presence alone rather than guessing.
        const saved = getConfig('savedPresence');
        if (saved) applyPresence(client, toPresenceData(saved));
        setConfig('savedPresence', null);
      }
      const result = setMaintenance(enabled, message);
      setConfig('maintenance', result);
      return [200, result];
    },

    'POST /deploy-commands': async () => {
      try {
        await deployCommands(client);
        return [200, { ok: true }];
      } catch (err) {
        return [500, { ok: false, error: errMsg(err) }];
      }
    },

    'GET /cooldowns': () => [200, cooldowns()],
    'POST /cooldowns': ({ commandCooldownMs, buttonCooldownMs }) => {
      if (commandCooldownMs !== undefined) setCommandCooldownMs(commandCooldownMs);
      if (buttonCooldownMs !== undefined) setButtonCooldownMs(buttonCooldownMs);
      const now = cooldowns();
      setConfig('cooldowns', now);
      return [200, now];
    },

    'GET /log-level': () => [200, { level: getLogLevel() }],
    'POST /log-level': ({ level }) => {
      const now = setLogLevel(level);
      setConfig('logLevel', now);
      return [200, { level: now }];
    },

    'POST /logs/bot/clear': () => {
      const ok = clearLogFile();
      return [ok ? 200 : 500, { ok }];
    },
    'POST /clean-dms': async () => [200, await cleanDms(client)],
    'POST /scan-clean-dms': async () => [200, await scanAndCleanDms(client)],

    'POST /welcome-all': async () => {
      // sendOwnerWelcome swallows its own DM failures
      for (const guild of client.guilds.cache.values()) await sendOwnerWelcome(guild);
      return [200, { sent: client.guilds.cache.size, failed: 0, total: client.guilds.cache.size }];
    },

    'POST /announce': async ({ title, message, color, footer }) => {
      const msg = str(message);
      if (msg.length < 2) return [400, { error: 'Message required' }];
      if (msg.length > 4000) return [400, { error: 'Message too long' }];
      const results = await sendCustomToAll(client, {
        message: msg, title: str(title), footer: str(footer), color: typeof color === 'number' ? color : undefined
      });
      return [200, { ok: true, ...results }];
    }
  };

  const guildRoutes: Record<string, (guildId: string, body: Body) => Promise<Reply> | Reply> = {
    // Pinned announcement channel (null = automatic: last command channel).
    'POST /settings': (guildId, { announceChannelId }) => {
      if (announceChannelId !== undefined) {
        if (announceChannelId && !/^\d{17,20}$/.test(String(announceChannelId))) return [400, { error: 'Invalid channel ID' }];
        setGuildSettings(guildId, { announceChannelId: announceChannelId ? String(announceChannelId) : null });
      }
      return [200, { settings: getGuildMemory(guildId).settings }];
    },

    // Text channels the bot can post in — for the admin panel's channel picker.
    'GET /channels': guildId => {
      const guild = cachedGuild(guildId);
      if (!guild) return [404, { error: 'Bot is not in this server' }];
      const me = guild.members.me;
      const channels = [...guild.channels.cache.values()]
        .filter(c => c.isTextBased() && !c.isThread() && !c.isVoiceBased())
        .map(c => ({
          id: c.id,
          name: c.name,
          position: 'rawPosition' in c ? c.rawPosition : 0,
          canSend: !!me && c.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
        }))
        .sort((a, b) => a.position - b.position);
      return [200, { channels }];
    },

    'GET /data': guildId => [200, {
      memory: getGuildMemory(guildId),
      stats: getGuildStatsRaw(guildId),
      messages: getGuildMessagesRaw(guildId)
    }],

    'POST /reset-memory': async guildId => { await resetGuildMemory(guildId); return [200, { ok: true }]; },
    'POST /reset-history': async guildId => { await resetGuildHistory(guildId); return [200, { ok: true }]; },
    'POST /nuke-messages': async guildId => [200, await nukeMessages(client, guildId)],
    'POST /disconnect': async guildId => { await disconnectGuild(guildId); return [200, { ok: true }]; },

    'POST /announce': async guildId => {
      const guild = cachedGuild(guildId);
      if (!guild) return [404, { error: 'Guild not in cache' }];
      setGuildSettings(guildId, { lastAnnouncementAt: null });
      return [200, { ok: await sendAnnouncement(guild) }];
    },
    'POST /welcome': async guildId => {
      const guild = cachedGuild(guildId);
      if (!guild) return [404, { error: 'Guild not in cache' }];
      await sendOwnerWelcome(guild);
      return [200, { ok: true }];
    }
  };

  return async (req: IncomingMessage): Promise<Reply> => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const body = method === 'POST' ? await readBody(req) : {};
    const route = routes[`${method} ${url}`];
    if (route) return route(body);
    const m = url.match(/^\/guild\/(\d+)(\/[a-z-]+)$/);
    const guildRoute = m && guildRoutes[`${method} ${m[2]}`];
    if (guildRoute) return guildRoute(m[1]!, body);
    return [404, { error: 'Not found' }];
  };
}

export function startInternalServer(client: Client<true>, port = 3001): Server {
  const handle = buildRoutes(client);
  const server = http.createServer((req, res) => {
    handle(req)
      .catch((err): Reply => [500, { error: errMsg(err) || 'Internal error' }])
      .then(([status, data]) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      });
  });
  server.listen(port, '127.0.0.1', () => console.log(`✅ Internal server listening on 127.0.0.1:${port}`));
  server.on('error', err => console.error('[INTERNAL SERVER]', err.message));
  return server;
}
