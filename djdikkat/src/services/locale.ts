/************************************************************
 * DJ DIKKAT - Music Bot
 * Guild language
 * Which language a guild's public messages use.
 * Author: Yanoee
 ************************************************************/
import type { Client, Guild } from 'discord.js';
import { getGuildMemory, setGuildSettings } from './memory.ts';
import { isLocale, toLocale } from '../i18n/index.ts';
import type { Locale } from '../i18n/index.ts';

/** The /language choice, else the Discord server's own language. */
export function guildLocale(guildId: string, guild?: Guild | null): Locale {
  const chosen = getGuildMemory(guildId).settings.locale;
  return isLocale(chosen) ? chosen : toLocale(guild?.preferredLocale);
}

/** guildLocale() when only a client is at hand (player card, timers). */
export function guildLocaleVia(client: Client | null, guildId: string): Locale {
  return guildLocale(guildId, client?.guilds.cache.get(guildId));
}

/** null = follow the Discord server setting again. */
export function setGuildLocale(guildId: string, locale: Locale | null): void {
  setGuildSettings(guildId, { locale });
}
