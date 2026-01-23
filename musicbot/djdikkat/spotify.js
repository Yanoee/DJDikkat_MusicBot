/************************************************************
 * DJ DIKKAT - Music Bot
 * Spotify fallback resolver
 * Spotify -> YouTube search queries
 * Build 2.0.1.1
 * Author: Yanoee
 ************************************************************/

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || process.env.SPOTIFY_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || process.env.SPOTIFY_SECRET;

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';

let tokenCache = {
  accessToken: null,
  expiresAt: 0
};

function isSpotifyUrl(input) {
  if (!input) return false;
  return /^https?:\/\/(open|play)\.spotify\.com\//i.test(input);
}

function parseSpotifyUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const type = parts[0];
    const id = parts[1];
    if (!type || !id) return null;
    if (!['track', 'album', 'playlist'].includes(type)) return null;
    return { type, id };
  } catch {
    return null;
  }
}

async function getToken() {
  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAt > now + 30_000) {
    return tokenCache.accessToken;
  }

  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error("DISCORDUN API'SI AI TARAFINDAN SIKILDIGI ICIN SPOTIFY CALISMICAK BIR SONRA KI EMRE KADAR");
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials'
  });

  const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!res.ok) {
    throw new Error(`Spotify token error: ${res.status}`);
  }

  const data = await res.json();
  tokenCache.accessToken = data.access_token;
  tokenCache.expiresAt = Date.now() + (data.expires_in * 1000);
  return tokenCache.accessToken;
}

async function spotifyGet(path) {
  const token = await getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error(`Spotify API error: ${res.status}`);
  }
  return res.json();
}

function trackToQuery(track) {
  const name = track?.name || '';
  const artist = track?.artists?.[0]?.name || '';
  return `${name} ${artist}`.trim();
}

async function resolveSpotifyTracks(url, limit = 3) {
  const parsed = parseSpotifyUrl(url);
  if (!parsed) return [];

  if (parsed.type === 'track') {
    const track = await spotifyGet(`/tracks/${parsed.id}`);
    return [trackToQuery(track)].filter(Boolean);
  }

  if (parsed.type === 'album') {
    const album = await spotifyGet(`/albums/${parsed.id}`);
    const tracks = album?.tracks?.items || [];
    return tracks.slice(0, limit).map(trackToQuery).filter(Boolean);
  }

  if (parsed.type === 'playlist') {
    const out = [];
    let next = `/playlists/${parsed.id}/tracks?limit=100`;
    while (next && out.length < limit) {
      const page = await spotifyGet(next.replace(API_BASE, ''));
      const items = page?.items || [];
      for (const item of items) {
        const track = item?.track;
        const q = trackToQuery(track);
        if (q) out.push(q);
        if (out.length >= limit) break;
      }
      next = page?.next || null;
    }
    return out;
  }

  return [];
}

module.exports = {
  isSpotifyUrl,
  resolveSpotifyTracks
};
