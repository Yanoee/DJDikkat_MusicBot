/************************************************************
 * DJ DIKKAT - Music Bot
 * Config store
 * Admin-set runtime settings persisted in the bot_config table
 * so they survive restarts. Values are JSON; the cache keeps
 * reads synchronous.
 * Author: Yanoee
 ************************************************************/
import * as db from './db.ts';
import { config } from '../config.ts';
import { t } from '../i18n/index.ts';
import type { Locale } from '../i18n/index.ts';

export interface Maintenance {
  enabled: boolean;
  message: string; // '' = the translated default
}

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
  launchDmed: string[];          // admins who already got the v6 launch DM
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

// ── Maintenance switch (admin panel) ──────────────────────

const DEFAULT_MAINTENANCE: Maintenance = { enabled: false, message: '' };

export function getMaintenance(): Maintenance {
  return { ...DEFAULT_MAINTENANCE, ...getConfig('maintenance') };
}

/** True when maintenance keeps this user out (owners and the test server pass). */
export function maintenanceBlocks(userId: string, guildId: string | null): boolean {
  return getMaintenance().enabled && !config.ownerIds.includes(userId) && guildId !== config.testGuildId;
}

/** What users see while maintenance is on: the admin's message, else the default in their language. */
export function maintenanceMessage(locale: Locale): string {
  return getMaintenance().message || t(locale, 'maintenance.default');
}

/** Sets and persists the switch; a blank message keeps the current one. */
export function setMaintenance(enabled: unknown, message?: unknown): Maintenance {
  const next: Maintenance = {
    enabled: !!enabled,
    message: typeof message === 'string' && message.trim() ? message.trim().slice(0, 300) : getMaintenance().message
  };
  setConfig('maintenance', next);
  return next;
}
