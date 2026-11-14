/************************************************************
 * DJ DIKKAT - Music Bot
 * Radio jingles
 * Which station jingle the radio host plays: the server's own
 * (a YouTube / SoundCloud link, set with /radio jingle) when it
 * has one, else one of our three stock stingers, rotating per
 * server so the same one doesn't play twice in a row. The stock
 * ones are original synthesized WAVs that live on the NodeLink
 * box in local-music/jingles/ and load through NodeLink's local
 * source by absolute path (loadTracks routes any identifier that
 * starts with "/" to it; the path must sit inside its basePath,
 * /home/apps/nodelink/local-music/).
 * Author: Yanoee
 ************************************************************/
import type { Radio } from '../services/features.ts';

/** A server's own jingle is cut off after this, however long the link is. */
export const JINGLE_MAX_MS = 10_000;

const STOCK_DIR = '/home/apps/nodelink/local-music/jingles';
const STOCK = ['dj-classic.wav', 'dj-electro.wav', 'dj-cinematic.wav'] as const;

/** NodeLink identifiers of the stock jingles (absolute paths → NodeLink's local source). */
export function stockJingles(): string[] {
  return STOCK.map((file) => `${STOCK_DIR}/${file}`);
}

// Same host list as isJingleUrl in services/features.ts (what /radio and the panel accept), so a saved link is never dropped here.
const JINGLE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
  'soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com',
]);

/** True for an https YouTube / YouTube Music / SoundCloud link a server may use as its jingle. */
export function isJingleLink(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > 300 || /[\s\p{Cc}]/u.test(url)) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  // No credentials or odd ports: the link goes straight to NodeLink, keep it a plain public URL.
  return u.protocol === 'https:' && !u.username && !u.password && u.port === ''
    && JINGLE_HOSTS.has(u.hostname.toLowerCase()) && u.pathname.length > 1;
}

// Next stock index per server. Starts at a per-server offset so servers don't all open with the same one.
const nextStock = new Map<string, number>();

function startIndex(guildId: string): number {
  let h = 0;
  for (const ch of guildId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % STOCK.length;
}

/**
 * The jingle to play now for this server, or null when its radio has jingles off.
 * A valid own link wins; otherwise the next stock jingle (each call advances the rotation).
 */
export function jingleFor(guildId: string, radio: Pick<Radio, 'jingles' | 'jingleUrl'>): string | null {
  if (!radio.jingles) return null;
  if (radio.jingleUrl && isJingleLink(radio.jingleUrl)) return radio.jingleUrl;
  const i = nextStock.get(guildId) ?? startIndex(guildId);
  nextStock.set(guildId, (i + 1) % STOCK.length);
  return stockJingles()[i]!;
}
