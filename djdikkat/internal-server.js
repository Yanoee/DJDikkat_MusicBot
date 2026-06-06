/************************************************************
 * DJ DIKKAT - Internal HTTP server
 * Localhost-only API so admin-api can trigger bot actions
 * Build 2.0.0
 * Author: Yanoee
 ************************************************************/
const http = require('http');
const { ActivityType } = require('discord.js');
const { sendCustomToAll, sendAnnouncement, sendOwnerWelcome } = require('./announcement');
const { cleanDms, scanAndCleanDms } = require('./dm-store');
const { getGuildMemory, resetGuildMemory, resetGuildHistory, resetGuildMessages, setGuildSettings } = require('./memory');
const { getState, getActiveVoiceCount, getActiveGuildIds } = require('./state');
const { getState: getMaintenanceState, enable: enableMaintenance, disable: disableMaintenance } = require('./maintenance');

const ACTIVITY_TYPES = {
  Playing:   ActivityType.Playing,
  Listening: ActivityType.Listening,
  Watching:  ActivityType.Watching,
  Competing: ActivityType.Competing
};

const ACTIVITY_NAMES = { 0: 'Playing', 2: 'Listening', 3: 'Watching', 5: 'Competing' };

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
        const guilds = [...client.guilds.cache.values()].map(g => {
          const state = getState(g.id);
          return {
            id: g.id, name: g.name, memberCount: g.memberCount,
            icon: g.iconURL({ size: 64 }) || null,
            joinedAt: g.joinedAt?.toISOString() || null,
            playing: !!state.current,
            paused: state.paused || false,
            currentTrack: state.current?.info?.title || null,
            voiceChannelId: state.voiceChannelId || null
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
        if (text && type && ACTIVITY_TYPES[type] !== undefined) {
          presenceData.activities = [{ name: text.trim(), type: ACTIVITY_TYPES[type] }];
        }
        await client.user.setPresence(presenceData);
        return send(200, { ok: true });
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

      // ── GET /maintenance ────────────────────────────────────────
      if (req.method === 'GET' && req.url === '/maintenance') {
        return send(200, getMaintenanceState());
      }

      // ── POST /maintenance/enable ─────────────────────────────────
      if (req.method === 'POST' && req.url === '/maintenance/enable') {
        const { message } = await readBody(req);
        await enableMaintenance(message);

        if (client.user) {
          client.user.setPresence({
            status: 'idle',
            activities: [{ name: '🔧 Under Maintenance', type: ActivityType.Playing }]
          });
        }

        const { disconnectGuild } = require('./player');
        const activeIds = getActiveGuildIds();
        for (const guildId of activeIds) {
          await disconnectGuild(guildId).catch(() => {});
        }

        console.warn(`⚠️  MAINTENANCE MODE ENABLED — disconnected ${activeIds.length} session(s)`);
        return send(200, { ok: true, disconnected: activeIds.length });
      }

      // ── POST /maintenance/disable ────────────────────────────────
      if (req.method === 'POST' && req.url === '/maintenance/disable') {
        await disableMaintenance();

        if (client.user) {
          client.user.setPresence({
            status: 'online',
            activities: [{ name: 'DJ DIKKAT', type: ActivityType.Playing }]
          });
        }

        console.log('✅ Maintenance mode disabled — bot is back online');
        return send(200, { ok: true });
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

module.exports = { startInternalServer };
