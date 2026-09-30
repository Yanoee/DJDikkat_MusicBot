/************************************************************
 * DJ DIKKAT - Music Bot
 * Config store
 * Admin-set runtime settings persisted in the bot_config table
 * so they survive restarts. Values are JSON; the cache keeps
 * reads synchronous.
 * Build 5.2.0
 * Author: Yanoee
 ************************************************************/
import * as db from './db.ts';
import type { Maintenance } from './runtime-flags.ts';

export interface PresenceConfig {
  status: string;
  type: string | null;
  text: string | null;
}

/** Every key the bot stores, and its value shape. */
export interface ConfigMap {
  maintenance: Maintenance;
  cooldowns: { commandCooldownMs: number; buttonCooldownMs: number };
  logLevel: string;
  presence: PresenceConfig;
  savedPresence: PresenceConfig; // presence to restore when maintenance ends
}
type Key = keyof ConfigMap;

const cache = new Map<Key, unknown>();

export async function loadAll(): Promise<number> {
  cache.clear();
  for (const r of await db.query<{ name: Key; value: string }[]>('SELECT name, value FROM bot_config')) {
    try { cache.set(r.name, JSON.parse(r.value)); } catch {}
  }
  return cache.size;
}

export function getConfig<K extends Key>(name: K): ConfigMap[K] | null {
  return (cache.get(name) as ConfigMap[K] | undefined) ?? null;
}

/** null removes the setting. */
export function setConfig<K extends Key>(name: K, value: ConfigMap[K] | null): void {
  if (value === null) {
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
