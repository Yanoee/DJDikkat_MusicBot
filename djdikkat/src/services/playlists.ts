/************************************************************
 * DJ DIKKAT - Music Bot
 * Playlists
 * The server playlists made in the web panel (tables
 * playlists / playlist_tracks, owned by the website), read and
 * extended from Discord: /playlist and the queue view's
 * "Add to playlist". Same rules as the website: 200 songs,
 * a link is in a playlist at most once.
 * Author: Yanoee
 ************************************************************/
import type { Track } from 'shoukaku';
import * as db from './db.ts';

export const TRACKS_PER_PLAYLIST = 200;

export interface PlaylistInfo { id: number; name: string; tracks: number }

/** Up to 25 of the server's playlists (Discord's limit for choices), names containing `typed` first. */
export async function listPlaylists(guildId: string, typed = ''): Promise<PlaylistInfo[]> {
  const rows = await db.query<{ id: number; name: string; tracks: number }[]>(
    `SELECT p.id, p.name, COUNT(t.id) AS tracks FROM playlists p LEFT JOIN playlist_tracks t ON t.playlist_id = p.id
     WHERE p.guild_id = ? AND p.name LIKE ? GROUP BY p.id ORDER BY p.updated_at DESC LIMIT 25`,
    [guildId, `%${typed.replace(/[\\%_]/g, m => `\\${m}`)}%`]
  );
  return rows.map(r => ({ id: Number(r.id), name: r.name, tracks: Number(r.tracks) }));
}

/** A playlist by id or exact name (autocomplete sends the id), with its song links in order. */
export async function findPlaylist(guildId: string, idOrName: string): Promise<{ id: number; name: string; uris: string[] } | null> {
  const [p] = await db.query<{ id: number; name: string }[]>(
    'SELECT id, name FROM playlists WHERE guild_id = ? AND (id = ? OR name = ?) LIMIT 1',
    [guildId, /^\d+$/.test(idOrName) ? Number(idOrName) : -1, idOrName]
  );
  if (!p) return null;
  const rows = await db.query<{ uri: string }[]>('SELECT uri FROM playlist_tracks WHERE playlist_id = ? ORDER BY pos', [p.id]);
  return { id: Number(p.id), name: p.name, uris: rows.map(r => r.uri) };
}

/** Appends one song (the one playing) to a playlist of this server. */
export async function addToPlaylist(guildId: string, playlistId: number, userId: string, track: Track): Promise<'added' | 'duplicate' | 'full' | 'missing'> {
  const [p] = await db.query<{ id: number }[]>('SELECT id FROM playlists WHERE id = ? AND guild_id = ?', [playlistId, guildId]);
  if (!p) return 'missing';
  const uri = track.info.uri;
  if (!uri) return 'missing';
  const rows = await db.query<{ uri: string }[]>('SELECT uri FROM playlist_tracks WHERE playlist_id = ?', [playlistId]);
  if (rows.some(r => r.uri === uri)) return 'duplicate';
  if (rows.length >= TRACKS_PER_PLAYLIST) return 'full';
  const artwork = track.info.artworkUrl?.startsWith('https://') ? track.info.artworkUrl.slice(0, 1024) : null;
  await db.query(
    `INSERT INTO playlist_tracks (playlist_id, pos, title, artist, uri, duration_ms, artwork, added_by, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [playlistId, rows.length, track.info.title.slice(0, 255), track.info.author?.slice(0, 255) || null, uri.slice(0, 1024),
      track.info.isStream ? null : track.info.length, artwork, userId]
  );
  await db.query('UPDATE playlists SET updated_at = UTC_TIMESTAMP() WHERE id = ?', [playlistId]);
  return 'added';
}
