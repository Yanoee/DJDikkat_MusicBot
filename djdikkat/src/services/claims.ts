/************************************************************
 * DJ DIKKAT - Music Bot
 * Panel login links
 * One-time tokens for the web panel (/panel and the launch
 * activation links). The token travels in the URL fragment
 * (never sent to the server or logged); only its SHA-256 is
 * stored, with an expiry. The website claims it once.
 * Author: Yanoee
 ************************************************************/
import { createHash, randomBytes } from 'node:crypto';
import type { Guild, User } from 'discord.js';
import * as db from './db.ts';

/** Creates a single-use login token for this user on this server. */
export async function createClaim(user: User, guild: Guild, ttlMs: number): Promise<{ token: string; expires: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + ttlMs);
  await db.query('DELETE FROM panel_claims WHERE expires_at < UTC_TIMESTAMP(3) - INTERVAL 1 DAY');
  await db.query(
    `INSERT INTO panel_claims (token_hash, user_id, user_name, avatar, guild_id, guild_name, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [createHash('sha256').update(token).digest('hex'), user.id, (user.globalName ?? user.username).slice(0, 100),
     user.avatar, guild.id, guild.name.slice(0, 100), expires]
  );
  return { token, expires };
}

/** True once this user has ever signed in to the panel. */
export async function hasUsedPanel(userId: string): Promise<boolean> {
  const rows = await db.query<{ n: number }[]>("SELECT 1 AS n FROM panel_audit WHERE user_id = ? AND action = 'login' LIMIT 1", [userId]);
  return rows.length > 0;
}
