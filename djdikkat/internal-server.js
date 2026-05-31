/************************************************************
 * DJ DIKKAT - Internal HTTP server
 * Localhost-only API so admin-api can trigger bot actions
 * Build 2.0.0
 * Author: Yanoee
 ************************************************************/
const http = require('http');
const { ActivityType } = require('discord.js');
const { sendCustomToAll, sendAnnouncement } = require('./announcement');
const { getGuildMemory, resetGuildMemory, resetGuildHistory, setGuildSettings } = require('./memory');
const { getState, getActiveVoiceCount } = require('./state');

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

        if (req.method === 'POST' && sub === '/reset-memory') {
          await resetGuildMemory(guildId);
          return send(200, { ok: true });
        }

        if (req.method === 'POST' && sub === '/reset-history') {
          await resetGuildHistory(guildId);
          return send(200, { ok: true });
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
