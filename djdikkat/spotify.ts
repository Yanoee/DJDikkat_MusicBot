/************************************************************
 * DJ DIKKAT - Music Bot
 * Spotify resolver
 * Spotify URL -> title, artist and duration for the search engine
 * Build 5.2.0
 * Author: Yanoee
 ************************************************************/
import { AppError, ErrorCodes, errMsg } from './errors.ts';

interface SpotifyTrack { name?: string; artists?: { name?: string }[]; duration_ms?: number }
/** What the search engine needs to find a Spotify track on YouTube. */
export interface SpotifyTrackSpec { title: string; artist: string; durationMs?: number }
interface Page<T> { items?: T[]; next?: string | null }

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE  = 'https://api.spotify.com/v1';
const TIMEOUT   = 12_000;

let token: { value: string; expiresAt: number } | null = null;

export function isSpotifyUrl(input: string): boolean {
  return /^https?:\/\/((open|play)\.spotify\.com|spotify\.link)\//i.test(input);
}

function parseSpotifyUrl(url: string): { type: 'track' | 'album' | 'playlist'; id: string } | null {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    let i = 0;
    if (parts[i] && /^intl-/i.test(parts[i]!)) i += 1;           // /intl-tr/track/{id}
    if (parts[i] === 'embed') i += 1;                              // /embed/track/{id}
    if (parts[i] === 'user' && parts[i + 2] === 'playlist') i += 2; // /user/{u}/playlist/{id}
    const type = parts[i];
    const id = parts[i + 1];
    if (!id || (type !== 'track' && type !== 'album' && type !== 'playlist')) return null;
    return { type, id };
  } catch {
    return null;
  }
}

async function getToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 30_000) return token.value;
  const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } = process.env;
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new AppError(ErrorCodes.SPOTIFY_ERROR, 'Spotify credentials are not configured');
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(TIMEOUT)
  });
  if (!res.ok) {
    throw new AppError(ErrorCodes.SPOTIFY_ERROR, `Spotify token request failed (HTTP ${res.status}) — check client id/secret`, { status: res.status });
  }
  const data = await res.json() as { access_token: string; expires_in: number };
  token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return token.value;
}

async function spotifyGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path.replace(API_BASE, '')}`, {
    headers: { Authorization: `Bearer ${await getToken()}` },
    signal: AbortSignal.timeout(TIMEOUT)
  });
  if (!res.ok) {
    throw new AppError(ErrorCodes.SPOTIFY_ERROR, `Spotify API request failed (HTTP ${res.status})`, { status: res.status, path });
  }
  return res.json() as Promise<T>;
}

const toSpec = (t: SpotifyTrack | null | undefined): SpotifyTrackSpec | null =>
  t?.name ? { title: t.name, artist: t.artists?.[0]?.name ?? '', durationMs: t.duration_ms } : null;

/** Collects up to `limit` tracks from a paginated list, following `next` links. */
async function collect<T>(first: Page<T> | undefined, map: (item: T) => SpotifyTrackSpec | null, limit: number): Promise<SpotifyTrackSpec[]> {
  const out: SpotifyTrackSpec[] = [];
  let page = first;
  while (page && out.length < limit) {
    for (const item of page.items ?? []) {
      const spec = map(item);
      if (spec) out.push(spec);
    }
    page = page.next && out.length < limit ? await spotifyGet<Page<T>>(page.next) : undefined;
  }
  return out.slice(0, limit);
}

/** Resolves a Spotify track/album/playlist URL to up to `limit` tracks. */
export async function resolveSpotifyTracks(url: string, limit = 3): Promise<SpotifyTrackSpec[]> {
  let parsed = parseSpotifyUrl(url);
  if (!parsed && /^https?:\/\/spotify\.link\//i.test(url)) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
      parsed = parseSpotifyUrl(res.url);
      console.debug(`[SPOTIFY] short link resolved to: ${res.url}`);
    } catch (err) {
      console.debug(`[SPOTIFY] short link resolution failed: ${errMsg(err)}`);
    }
  }
  if (!parsed) {
    console.debug(`[SPOTIFY] could not parse URL: ${url}`);
    return [];
  }
  console.debug(`[SPOTIFY] parsed as type=${parsed.type} id=${parsed.id}`);

  if (parsed.type === 'track') {
    const spec = toSpec(await spotifyGet<SpotifyTrack>(`/tracks/${parsed.id}`));
    return spec ? [spec] : [];
  }
  if (parsed.type === 'album') {
    const album = await spotifyGet<{ tracks?: Page<SpotifyTrack> }>(`/albums/${parsed.id}`);
    return collect(album.tracks, toSpec, limit);
  }
  const first = await spotifyGet<Page<{ track?: SpotifyTrack }>>(`/playlists/${parsed.id}/tracks?limit=100`);
  return collect(first, item => toSpec(item.track), limit);
}
