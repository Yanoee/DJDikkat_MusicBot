/************************************************************
 * DJ DIKKAT - Internal HTTP server
 * Localhost-only API so admin-api can trigger bot actions
 * Build 1.0.0
 * Author: Yanoee
 ************************************************************/
const http = require('http');
const { sendCustomToAll } = require('./announcement');

function startInternalServer(client, port = 3001) {
  const server = http.createServer((req, res) => {
    const send = (status, data) => {
      const body = JSON.stringify(data);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    };

    if (req.method === 'POST' && req.url === '/announce') {
      let raw = '';
      req.on('data', chunk => { raw += chunk.toString(); });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(raw);
          if (!payload.message || payload.message.trim().length < 2) {
            return send(400, { error: 'Message is required' });
          }
          if (payload.message.length > 4000) {
            return send(400, { error: 'Message too long (max 4000 chars)' });
          }
          const results = await sendCustomToAll(client, payload);
          send(200, { ok: true, ...results });
        } catch (err) {
          send(500, { error: err.message || 'Internal error' });
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/guilds') {
      const guilds = [...client.guilds.cache.values()].map(g => ({
        id:          g.id,
        name:        g.name,
        memberCount: g.memberCount,
        icon:        g.iconURL({ size: 64 }) || null,
        joinedAt:    g.joinedAt ? g.joinedAt.toISOString() : null
      })).sort((a, b) => a.name.localeCompare(b.name));
      return send(200, { guilds, total: guilds.length });
    }

    send(404, { error: 'Not found' });
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`✅ Internal server listening on 127.0.0.1:${port}`);
  });

  server.on('error', err => {
    console.error('[INTERNAL SERVER]', err.message);
  });

  return server;
}

module.exports = { startInternalServer };
