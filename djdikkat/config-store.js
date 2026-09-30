/************************************************************
 * DJ DIKKAT - Music Bot
 * Config store
 * Admin-set runtime settings persisted in the bot_config table
 * so they survive restarts (maintenance, cooldowns, log level,
 * presence). Values are JSON; the cache keeps reads synchronous.
 * Build 5.0.0
 * Author: Yanoee
 ************************************************************/

const db = require('./db');

const cache = new Map();

async function loadAll() {
  cache.clear();
  for (const r of await db.query('SELECT name, value FROM bot_config')) {
    try { cache.set(r.name, JSON.parse(r.value)); } catch {}
  }
  return cache.size;
}

function getConfig(name, fallback = null) {
  return cache.has(name) ? cache.get(name) : fallback;
}

// null removes the setting.
function setConfig(name, value) {
  if (value === null || value === undefined) {
    cache.delete(name);
    db.background(db.query('DELETE FROM bot_config WHERE name = ?', [name]), `clear config ${name}`);
    return;
  }
  cache.set(name, value);
  db.background(db.query(
    'INSERT INTO bot_config (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [name, JSON.stringify(value)]
  ), `save config ${name}`);
}

module.exports = { loadAll, getConfig, setConfig };
