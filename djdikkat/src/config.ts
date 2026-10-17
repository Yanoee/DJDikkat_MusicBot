/************************************************************
 * DJ DIKKAT - Music Bot
 * Config
 * The only module that reads process.env. Values come from
 * the shared .env file (systemd EnvironmentFile).
 * Author: Yanoee
 ************************************************************/
import { join } from 'node:path';

const env = process.env;
/** Required settings that are absent; index.ts refuses to start if any are. */
export const missingSettings: string[] = [];

function required(name: string): string {
  const value = env[name]?.trim();
  if (!value) missingSettings.push(name);
  return value ?? '';
}

const optional = (name: string, fallback: string) => env[name]?.trim() || fallback;
const int = (name: string, fallback: number) => parseInt(optional(name, String(fallback)), 10);

const appsDir = optional('COMMON_APPS_DIR', join(import.meta.dirname, '..', '..'));
const logDir = optional('COMMON_LOG_DIR', join(appsDir, 'logger'));

export const config = {
  publicUrl: required('COMMON_PUBLIC_URL'),
  links: {
    patreon: required('COMMON_PATREON_URL'),
    github: required('COMMON_GITHUB_URL'),
    topgg: required('COMMON_TOPGG_URL')
  },

  discordToken: required('BOT_DISCORD_TOKEN'),
  deployCommands: optional('BOT_DEPLOY_COMMANDS', 'false') === 'true',
  // Maintenance doesn't apply to these users, nor to anyone in the test server.
  ownerIds: optional('BOT_OWNER_IDS', optional('BOT_OWNER_ID', '')).split(',').map(s => s.trim()).filter(Boolean),
  testGuildId: optional('BOT_TEST_GUILD_ID', ''),

  nodelink: {
    host: required('BOT_NODELINK_HOST'),
    port: required('BOT_NODELINK_PORT'),
    password: required('BOT_NODELINK_PASS'),
    secure: optional('BOT_NODELINK_SECURE', 'false') === 'true'
  },
  spotify: {
    clientId: optional('BOT_SPOTIFY_ID', ''),
    clientSecret: optional('BOT_SPOTIFY_SECRET', '')
  },
  db: {
    host: optional('COMMON_DB_HOST', '127.0.0.1'),
    port: int('COMMON_DB_PORT', 3306),
    name: optional('COMMON_DB_NAME', 'djdikkat'),
    user: required('BOT_DB_USER'),
    password: required('BOT_DB_PASS')
  },
  internal: {
    port: int('COMMON_BOT_INTERNAL_PORT', 3001),
    adminSecret: required('OPS_BOT_ADMIN_SECRET'),
    panelSecret: optional('WEB_BOT_PANEL_SECRET', '')
  },
  paths: {
    schema: join(appsDir, 'database', 'schema', 'bot.sql'),
    logFile: join(logDir, 'bot', 'bot.log')
  }
};
