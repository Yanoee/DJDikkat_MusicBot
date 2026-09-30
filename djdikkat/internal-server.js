/************************************************************
 * DJ DIKKAT - Internal HTTP server
 * Localhost-only API so admin-api can trigger bot actions
 * Build 5.0.0
 * Author: Yanoee
 ************************************************************/
const http = require('http');
const { ActivityType } = require('discord.js');
const { sendCustomToAll, sendAnnouncement, sendOwnerWelcome } = require('./announcement');
const { cleanDms, scanAndCleanDms } = require('./dm-store');
const { getGuildMemory, getGuildMessagesRaw, resetGuildMemory, resetGuildHistory, resetGuildMessages, setGuildSettings } = require('./memory');
const { getGuildStatsRaw } = require('./stats');
const { peekState, getActiveVoiceCount, getCommandCooldownMs, setCommandCooldownMs } = require('./state');
const { clearLogFile, getLogLevel, setLogLevel } = require('./logger');
const { getMaintenance, setMaintenance } = require('./runtime-flags');
const { deployCommands, getButtonCooldownMs, setButtonCooldownMs } = require('./commands');
const { getConfig, setConfig } = require('./config-store');

const ACTIVITY_TYPES = {
  Playing:   ActivityType.Playing,
  Listening: ActivityType.Listening,
  Watching:  ActivityType.Watching,
  Competing: ActivityType.Competing
};

const ACTIVITY_NAMES = { 0: 'Playing', 2: 'Listening', 3: 'Watching', 5: 'Competing' };

const MAINTENANCE_PRESENCE = {
  status: 'idle', // Discord's yellow/away status
  activities: [{ name: '🔨 Under Maintenance', type: ActivityType.Playing }]
};

// Presence to show at startup: the maintenance card if maintenance is on,
// else whatever an admin last set, else null (caller uses its default).
function startupPresence() {
  if (getMaintenance().enabled) return MAINTENANCE_PRESENCE;
  const p = getConfig('presence');
  if (!p) return null;
  const data = { status: p.status || 'online', activities: [] };
  if (p.text && p.type && ACTIVITY_TYPES[p.type] !== undefined) {
    data.activities = [{ name: p.text, type: ACTIVITY_TYPES[p.type] }];
  }
  return data;
}

// client.user.setPresence() is synchronous in discord.js v14 (returns the
// ClientPresence, not a Promise). Guarded so a bad presence payload can't
// abort whatever the caller does next.
function applyPresence(client, data) {
  try {
    client.user.setPresence(data);
  } catch (err) {
    console.warn(`[PRESENCE] Could not set presence: ${err.message}`);
  }
}

function readBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => { raw += c.toString(); });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

function startInternalServer(client, port = 3001) {
  const server = http.createServer((req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    const handle = async () => {
      // ── GET /guilds ──────────────────────────────────────────
      if (req.method === 'GET' && req.url === '/guilds') {
        const { getRecoveryStats } = require('./player');
        const recoveryStats = getRecoveryStats();
        const guilds = [...client.guilds.cache.values()].map(g => {
          const state = peekState(g.id);
          return {
            id: g.id, name: g.name, memberCount: g.memberCount,
            icon: g.iconURL({ size: 64 }) || null,
            joinedAt: g.joinedAt?.toISOString() || null,
            playing: !!state?.current,
            paused: state?.paused || false,
            currentTrack: state?.current?.info?.title || null,
            voiceChannelId: state?.voiceChannelId || null,
            recoveryAttempts1h: recoveryStats[g.id] || 0
          };
        }).sort((a, b) => a.name.localeCompare(b.name));
        return send(200, { guilds, total: guilds.length });
      }

      if (req.method === 'GET' && req.url === '/stats') {
        return send(200, {
          activeVoice: getActiveVoiceCount(),
          totalGuilds: client.guilds.cache.size
        });
      }

      // ── GET /presence ────────────────────────────────────────
      if (req.method === 'GET' && req.url === '/presence') {
        const presence = client.user?.presence;
        const activity = presence?.activities?.[0];
        return send(200, {
          status:       presence?.status || 'online',
          activityType: activity ? (ACTIVITY_NAMES[activity.type] || null) : null,
          activityName: activity?.name || null
        });
      }

      // ── POST /presence ───────────────────────────────────────
      if (req.method === 'POST' && req.url === '/presence') {
        const { type, text, status } = await readBody(req);
        const presenceData = { status: status || 'online', activities: [] };
        const hasActivity  = text && type && ACTIVITY_TYPES[type] !== undefined;
        if (hasActivity) {
          presenceData.activities = [{ name: text.trim(), type: ACTIVITY_TYPES[type] }];
        }
        client.user.setPresence(presenceData);
        setConfig('presence', {
          status: presenceData.status,
          type:   hasActivity ? type : null,
          text:   hasActivity ? text.trim() : null
        });
        return send(200, { ok: true });
      }

      // ── GET/POST /maintenance ─────────────────────────────────
      // While maintenance mode is on, the presence that was live right before it
      // is kept in bot_config 'savedPresence', so switching it off restores the
      // exact old title card instead of resetting to some generic default — even
      // across a restart mid-maintenance.
      if (req.method === 'GET' && req.url === '/maintenance') {
        return send(200, getMaintenance());
      }
      if (req.method === 'POST' && req.url === '/maintenance') {
        const { enabled, message } = await readBody(req);
        const was = getMaintenance().enabled;
        const now = !!enabled;

        if (now && !was) {
          // Turning on: snapshot whatever's live right now, then switch to
          // the maintenance presence (idle = Discord's yellow/away status).
          const presence = client.user?.presence;
          const activity = presence?.activities?.[0];
          setConfig('savedPresence', {
            status: presence?.status && presence.status !== 'offline' ? presence.status : 'online',
            type: activity ? (ACTIVITY_NAMES[activity.type] || null) : null,
            text: activity?.name || null
          });
          applyPresence(client, MAINTENANCE_PRESENCE);
        } else if (!now && was) {
          // Turning off: restore exactly what was captured. If there's
          // nothing saved, leave presence alone rather than guessing.
          const savedPresence = getConfig('savedPresence');
          if (savedPresence) {
            const presenceData = { status: savedPresence.status, activities: [] };
            if (savedPresence.text && savedPresence.type && ACTIVITY_TYPES[savedPresence.type] !== undefined) {
              presenceData.activities = [{ name: savedPresence.text, type: ACTIVITY_TYPES[savedPresence.type] }];
            }
            applyPresence(client, presenceData);
          }
          setConfig('savedPresence', null);
        }

        const result = setMaintenance(enabled, message);
        setConfig('maintenance', result);
        return send(200, result);
      }

      // ── POST /deploy-commands ─────────────────────────────────
      if (req.method === 'POST' && req.url === '/deploy-commands') {
        try {
          await deployCommands(client);
          return send(200, { ok: true });
        } catch (err) {
          return send(500, { ok: false, error: err.message || 'Deploy failed' });
        }
      }

      // ── GET/POST /cooldowns ────────────────────────────────────
      if (req.method === 'GET' && req.url === '/cooldowns') {
        return send(200, {
          commandCooldownMs: getCommandCooldownMs(),
          buttonCooldownMs: getButtonCooldownMs()
        });
      }
      if (req.method === 'POST' && req.url === '/cooldowns') {
        const { commandCooldownMs, buttonCooldownMs } = await readBody(req);
        if (commandCooldownMs !== undefined) setCommandCooldownMs(commandCooldownMs);
        if (buttonCooldownMs !== undefined) setButtonCooldownMs(buttonCooldownMs);
        const cooldowns = {
          commandCooldownMs: getCommandCooldownMs(),
          buttonCooldownMs: getButtonCooldownMs()
        };
        setConfig('cooldowns', cooldowns);
        return send(200, cooldowns);
      }

      // ── GET/POST /log-level ────────────────────────────────────
      if (req.method === 'GET' && req.url === '/log-level') {
        return send(200, { level: getLogLevel() });
      }
      if (req.method === 'POST' && req.url === '/log-level') {
        const { level } = await readBody(req);
        const now = setLogLevel(level);
        setConfig('logLevel', now);
        return send(200, { level: now });
      }

      // ── POST /logs/bot/clear ─────────────────────────────────
      if (req.method === 'POST' && req.url === '/logs/bot/clear') {
        const ok = clearLogFile();
        return send(ok ? 200 : 500, { ok });
      }

      // ── POST /clean-dms ──────────────────────────────────────
      if (req.method === 'POST' && req.url === '/clean-dms') {
        const result = await cleanDms(client);
        return send(200, result);
      }

      // ── POST /scan-clean-dms ─────────────────────────────────
      if (req.method === 'POST' && req.url === '/scan-clean-dms') {
        const result = await scanAndCleanDms(client);
        return send(200, result);
      }

      // ── POST /welcome-all ────────────────────────────────────
      if (req.method === 'POST' && req.url === '/welcome-all') {
        let sent = 0, failed = 0;
        for (const guild of client.guilds.cache.values()) {
          try { await sendOwnerWelcome(guild, client); sent++; }
          catch { failed++; }
        }
        return send(200, { sent, failed, total: client.guilds.cache.size });
      }

      // ── POST /announce ───────────────────────────────────────
      if (req.method === 'POST' && req.url === '/announce') {
        const payload = await readBody(req);
        if (!payload.message || payload.message.trim().length < 2) return send(400, { error: 'Message required' });
        if (payload.message.length > 4000) return send(400, { error: 'Message too long' });
        const results = await sendCustomToAll(client, payload);
        return send(200, { ok: true, ...results });
      }

      // ── Guild routes: /guild/:id/* ───────────────────────────
      const m = req.url.match(/^\/guild\/(\d+)(\/[a-z-]*)$/);
      if (m) {
        const guildId = m[1];
        const sub     = m[2];

        if (req.method === 'GET' && sub === '/settings') {
          const mem = getGuildMemory(guildId);
          return send(200, { settings: mem?.settings || {} });
        }

        // Pinned announcement channel (null = automatic: last command channel).
        if (req.method === 'POST' && sub === '/settings') {
          const { announceChannelId } = await readBody(req);
          if (announceChannelId !== undefined) {
            if (announceChannelId && !/^\d{17,20}$/.test(String(announceChannelId))) {
              return send(400, { error: 'Invalid channel ID' });
            }
            await setGuildSettings(guildId, { announceChannelId: announceChannelId || null });
          }
          return send(200, { settings: getGuildMemory(guildId).settings });
        }

        // Text channels the bot can post in — for the admin panel's channel picker.
        if (req.method === 'GET' && sub === '/channels') {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return send(404, { error: 'Bot is not in this server' });
          const me = guild.members.me;
          const channels = [...guild.channels.cache.values()]
            .filter(c => c.isTextBased?.() && !c.isThread?.() && !c.isVoiceBased?.())
            .map(c => ({
              id: c.id,
              name: c.name,
              position: c.rawPosition ?? 0,
              canSend: !!(me && c.permissionsFor(me)?.has(['ViewChannel', 'SendMessages']))
            }))
            .sort((a, b) => a.position - b.position);
          return send(200, { channels });
        }

        if (req.method === 'GET' && sub === '/data') {
          return send(200, {
            memory: getGuildMemory(guildId),
            stats: getGuildStatsRaw(guildId),
            messages: getGuildMessagesRaw(guildId)
          });
        }

        if (req.method === 'POST' && sub === '/reset-memory') {
          await resetGuildMemory(guildId);
          return send(200, { ok: true });
        }

        if (req.method === 'POST' && sub === '/reset-history') {
          await resetGuildHistory(guildId);
          return send(200, { ok: true });
        }

        if (req.method === 'POST' && sub === '/reset-messages') {
          await resetGuildMessages(guildId);
          return send(200, { ok: true });
        }

        if (req.method === 'POST' && sub === '/nuke-messages') {
          await resetGuildMessages(guildId);

          const guild = client.guilds.cache.get(guildId);
          let deleted = 0, failed = 0;

          if (guild) {
            const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
            const now = Date.now();

            for (const channel of guild.channels.cache.values()) {
              if (!channel.isTextBased?.() || channel.isThread?.()) continue;
              try {
                const perms = channel.permissionsFor(guild.members.me);
                if (!perms?.has('ViewChannel') || !perms?.has('ReadMessageHistory')) continue;

                const msgs = await channel.messages.fetch({ limit: 100 }).catch(() => null);
                if (!msgs || !msgs.size) continue;

                const botMsgs = [...msgs.values()].filter(m => m.author?.id === client.user?.id);
                const recent  = botMsgs.filter(m => now - m.createdTimestamp < TWO_WEEKS_MS);
                const old     = botMsgs.filter(m => now - m.createdTimestamp >= TWO_WEEKS_MS);

                if (recent.length > 1) {
                  const r = await channel.bulkDelete(recent, true).catch(() => null);
                  if (r) deleted += r.size;
                } else if (recent.length === 1) {
                  const ok = await recent[0].delete().then(() => true).catch(() => false);
                  if (ok) deleted++; else failed++;
                }

                for (const msg of old) {
                  const ok = await msg.delete().then(() => true).catch(() => false);
                  if (ok) deleted++; else failed++;
                }
              } catch { failed++; }
            }
          }

          return send(200, { ok: true, deleted, failed });
        }

        if (req.method === 'POST' && sub === '/disconnect') {
          const { disconnectGuild } = require('./player');
          await disconnectGuild(guildId);
          return send(200, { ok: true });
        }

        if (req.method === 'POST' && sub === '/announce') {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return send(404, { error: 'Guild not in cache' });
          await setGuildSettings(guildId, { lastAnnouncementAt: null });
          const ok = await sendAnnouncement(guild, client);
          return send(200, { ok });
        }

        if (req.method === 'POST' && sub === '/welcome') {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return send(404, { error: 'Guild not in cache' });
          await sendOwnerWelcome(guild, client);
          return send(200, { ok: true });
        }
      }

      send(404, { error: 'Not found' });
    };

    handle().catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Internal error' }));
    });
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`✅ Internal server listening on 127.0.0.1:${port}`);
  });

  server.on('error', err => console.error('[INTERNAL SERVER]', err.message));

  return server;
}

module.exports = { startInternalServer, startupPresence };
