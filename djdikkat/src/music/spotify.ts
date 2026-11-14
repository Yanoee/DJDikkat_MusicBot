/************************************************************
 * DJ DIKKAT - Music Bot
 * Spotify resolver
 * Spotify URL -> title, artist and duration for the search engine
 * Author: Yanoee
 ************************************************************/
import { AppError, UserError, errMsg } from '../lib/errors.ts';
import { config } from '../config.ts';

interface SpotifyTrack { name?: string; type?: string; is_local?: boolean; artists?: { name?: string }[]; duration_ms?: number }
/** What the search engine needs to find a Spotify track on YouTube. */
export interface SpotifyTrackSpec { title: string; artist: string; durationMs?: number }
interface Page<T> { items?: (T | null)[]; next?: string | null }
// Spotify's 2026 API renames a playlist entry's `track` to `item`; read both
// so a switch-over on their side doesn't empty every playlist import.
interface PlaylistItem { track?: SpotifyTrack | boolean | null; item?: SpotifyTrack | null }
export type SpotifyLinkType = 'track' | 'album' | 'playlist' | 'artist';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE  = 'https://api.spotify.com/v1';
const TIMEOUT   = 12_000;          // per HTTP request
const DEADLINE  = 30_000;          // no new retry starts after this much time on one call
const TOKEN_MARGIN = 60_000;       // refresh this long before the token expires
const MAX_ATTEMPTS = 3;            // 5xx / network / timeout: first try + 2 retries
const BACKOFF = [500, 1_500];      // wait before retry 1, 2 (plus a little jitter)
const MAX_429_WAIT = 5_000;        // wait out a Retry-After up to this; longer → tell the user
const MAX_429_RETRIES = 2;
// /play and the panel ask for at most the queue's free room (25), so these
// are only a safety net — never walk a 10 000-song playlist page by page.
const MAX_TRACKS = 100;
const MAX_EXTRA_PAGES = 3;         // `next` links followed after the first page
const DEFAULT_MARKET = 'TR';       // artist top tracks need one; the bot's home market

const ID_RE = /^[A-Za-z0-9]{1,64}$/;

export function isSpotifyUrl(input: string): boolean {
  return /^https?:\/\/((open|play)\.spotify\.com|spotify\.(app\.)?link)\//i.test(input);
}

/**
 * open/play.spotify.com link → type + id (+ market from an /intl-xx/ prefix).
 * Pure; exported for tests. Query strings (?si=…, ?highlight=…) are ignored.
 */
export function parseSpotifyUrl(url: string): { type: SpotifyLinkType; id: string; market?: string } | null {
  try {
    const u = new URL(url);
    if (!/^(open|play)\.spotify\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    let i = 0;
    let market: string | undefined;
    const intl = parts[i]?.match(/^intl-([a-z]{2})(?:[-_][a-z]+)?$/i); // /intl-tr/track/{id}, /intl-pt-br/…
    if (intl) { market = intl[1]!.toUpperCase(); i += 1; }
    if (parts[i] === 'embed') i += 1;                              // /embed/track/{id}
    if (parts[i] === 'user' && parts[i + 2] === 'playlist') i += 2; // /user/{u}/playlist/{id}
    const type = parts[i];
    const id = parts[i + 1];
    // The id lands in an API path, so only base62 gets through.
    if (!id || !ID_RE.test(id) || (type !== 'track' && type !== 'album' && type !== 'playlist' && type !== 'artist')) return null;
    return market ? { type, id, market } : { type, id };
  } catch {
    return null;
  }
}

/**
 * A playable song for the search engine, or null for what can't be found on
 * YouTube: removed entries (null), podcast episodes, local files (they have no
 * Spotify id and usually junk names). Availability in a market is NOT checked
 * — the song plays from YouTube, so a Spotify region lock doesn't matter.
 */
export function toSpec(t: SpotifyTrack | null | undefined): SpotifyTrackSpec | null {
  if (!t?.name?.trim() || t.is_local || (t.type && t.type !== 'track')) return null;
  return { title: t.name, artist: t.artists?.[0]?.name ?? '', durationMs: t.duration_ms };
}

const MAX_HOPS = 5;

/**
 * Follows a short link (spotify.link, on.soundcloud.com, …) one redirect at a
 * time and returns the first URL on a `targets` host, without fetching it.
 * Every hop must be plain https on a `shortHosts` / `targets` host, so a
 * redirect can't point the server at an internal or arbitrary address. Null
 * for anything else (other host, too many hops, no redirect, network error).
 */
export async function followShortLink(
  start: URL | string, shortHosts: ReadonlySet<string>, targets: ReadonlySet<string>,
  fetchFn: typeof fetch = fetch, timeoutMs = 8_000
): Promise<URL | null> {
  const signal = AbortSignal.timeout(timeoutMs);
  let url: URL;
  try { url = new URL(start); } catch { return null; }
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (targets.has(host)) return url;
    if (!shortHosts.has(host) || hop === MAX_HOPS) return null;
    try {
      const res = await fetchFn(url, { redirect: 'manual', signal });
      await res.body?.cancel().catch(() => {});
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) return null;
      url = new URL(location, url);
    } catch {
      return null;
    }
  }
  return null;
}

const SPOTIFY_SHORT = new Set(['spotify.link', 'spotify.app.link']);
const SPOTIFY_PAGES = new Set(['open.spotify.com', 'play.spotify.com']);

export interface SpotifyDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  credentials: () => { clientId: string; clientSecret: string };
}

const defaultDeps: SpotifyDeps = {
  fetch: (input, init) => fetch(input, init),
  sleep: ms => new Promise(done => setTimeout(done, ms)),
  now: () => Date.now(),
  credentials: () => config.spotify
};

/** HTTP status, or 0 for a network error / timeout. */
class HttpFailure extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(status: number, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Retry-After is seconds (or an HTTP date); missing/garbage → null. */
function retryAfterMs(res: Response, now: number): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * A Spotify client with its own token. The bot uses one shared instance;
 * tests build their own with a fake fetch.
 */
export function createSpotifyClient(overrides: Partial<SpotifyDeps> = {}) {
  const deps: SpotifyDeps = { ...defaultDeps, ...overrides };
  let token: { value: string; expiresAt: number } | null = null;
  let tokenRequest: Promise<string> | null = null;
  // After a long 429 Spotify keeps extending the ban if we keep knocking,
  // so until it's over requests fail here without touching the network.
  let blockedUntil = 0;

  const rateLimited = (waitMs: number): UserError => {
    blockedUntil = Math.max(blockedUntil, deps.now() + waitMs);
    console.warn(`[SPOTIFY] rate limited for ${Math.ceil(waitMs / 1000)}s`);
    return new UserError('search.spotify_busy');
  };

  /**
   * One request with the retry policy: 5xx / network / timeout → bounded
   * backoff; 429 → wait out a short Retry-After, a long one becomes a
   * UserError right away instead of a hanging /play. Other statuses throw
   * HttpFailure for the caller (401 handling needs the token logic).
   */
  async function send(url: string, init: () => RequestInit): Promise<Response> {
    const started = deps.now();
    let attempt = 0;
    let waits429 = 0;
    for (;;) {
      if (blockedUntil > deps.now()) throw rateLimited(blockedUntil - deps.now());
      let failure: HttpFailure;
      try {
        const res = await deps.fetch(url, { ...init(), signal: AbortSignal.timeout(TIMEOUT) });
        if (res.ok) return res;
        await res.body?.cancel().catch(() => {});
        failure = new HttpFailure(res.status, `HTTP ${res.status}`, res.status === 429 ? retryAfterMs(res, deps.now()) : null);
      } catch (err) {
        failure = new HttpFailure(0, errMsg(err));
      }
      const elapsed = deps.now() - started;

      if (failure.status === 429) {
        const wait = failure.retryAfterMs ?? 1_000;
        if (wait > MAX_429_WAIT || waits429 >= MAX_429_RETRIES || elapsed + wait > DEADLINE) throw rateLimited(wait);
        waits429 += 1;
        await deps.sleep(wait);
        continue;
      }
      const transient = failure.status === 0 || failure.status >= 500;
      attempt += 1;
      const backoff = (BACKOFF[attempt - 1] ?? 0) + Math.floor(Math.random() * 250);
      if (!transient || attempt >= MAX_ATTEMPTS || elapsed + backoff > DEADLINE) throw failure;
      console.debug(`[SPOTIFY] ${failure.message} on ${url.split('?')[0]}, retry ${attempt}`);
      await deps.sleep(backoff);
    }
  }

  async function fetchToken(): Promise<string> {
    const { clientId, clientSecret } = deps.credentials();
    if (!clientId || !clientSecret) {
      throw new AppError('SPOTIFY_ERROR', 'Spotify credentials are not configured');
    }
    let res: Response;
    try {
      res = await send(TOKEN_URL, () => ({
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' })
      }));
    } catch (err) {
      if (!(err instanceof HttpFailure)) throw err;
      const hint = err.status === 400 || err.status === 401 ? ' — check client id/secret' : '';
      throw new AppError('SPOTIFY_ERROR', `Spotify token request failed (${err.message})${hint}`, { status: err.status });
    }
    const data = await res.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new AppError('SPOTIFY_ERROR', 'Spotify token response had no access_token');
    token = { value: data.access_token, expiresAt: deps.now() + (data.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  /** A valid token; parallel callers share one in-flight token request. */
  function getToken(fresh = false): Promise<string> {
    if (!fresh && token && token.expiresAt > deps.now() + TOKEN_MARGIN) return Promise.resolve(token.value);
    if (fresh) token = null;
    tokenRequest ??= fetchToken().finally(() => { tokenRequest = null; });
    return tokenRequest;
  }

  /** GET an API path (or a full `next` link). One retry with a new token on 401. */
  async function get<T>(path: string): Promise<T> {
    const url = path.startsWith('https://') ? path : `${API_BASE}${path}`;
    // Never send the bearer token anywhere but the API (a `next` link is data from the response).
    if (!url.startsWith(`${API_BASE}/`)) throw new AppError('SPOTIFY_ERROR', 'Refusing a non-API Spotify URL', { path });
    let tok = await getToken();
    for (let renewed = false; ; renewed = true) {
      try {
        const res = await send(url, () => ({ headers: { Authorization: `Bearer ${tok}` } }));
        return await res.json() as T;
      } catch (err) {
        if (!(err instanceof HttpFailure)) throw err;
        if (err.status === 401 && !renewed) {
          // Revoked or expired early (clock skew, Spotify restart): one fresh try.
          const stale = tok;
          tok = token && token.value !== stale ? token.value : await getToken(true);
          continue;
        }
        throw new AppError('SPOTIFY_ERROR', `Spotify API request failed (${err.message})`, { status: err.status, path: url.replace(API_BASE, '') });
      }
    }
  }

  /** Collects up to `limit` tracks from a paginated list, following at most MAX_EXTRA_PAGES `next` links. */
  async function collect<T>(first: Page<T> | undefined, map: (item: T) => SpotifyTrackSpec | null, limit: number): Promise<SpotifyTrackSpec[]> {
    const out: SpotifyTrackSpec[] = [];
    let page = first;
    for (let pages = 0; page && out.length < limit; pages += 1) {
      for (const item of page.items ?? []) {
        const spec = item == null ? null : map(item);
        if (spec) out.push(spec);
      }
      page = page.next && out.length < limit && pages < MAX_EXTRA_PAGES ? await get<Page<T>>(page.next) : undefined;
    }
    return out.slice(0, limit);
  }

  /** The HTTP status of a failed API call (`get`); undefined for anything else, the token request included. */
  const apiStatus = (err: unknown): unknown =>
    err instanceof AppError && err.context.path !== undefined ? err.context.status : undefined;

  /**
   * A 404/400 on a track/album/artist/playlist id = it doesn't exist (any more) → no tracks.
   * Not for the token request: its 400 is bad credentials, which must reach the log.
   */
  const missingAsEmpty = (err: unknown): null => {
    const status = apiStatus(err);
    if (status === 404 || status === 400) return null;
    throw err;
  };

  /** Resolves a Spotify track/album/playlist/artist URL to up to `limit` tracks. */
  async function resolve(url: string, limit = 3): Promise<SpotifyTrackSpec[]> {
    limit = Math.max(1, Math.min(MAX_TRACKS, Math.floor(limit) || 1));
    let parsed = parseSpotifyUrl(url);
    if (!parsed && /^https?:\/\/spotify\.(?:app\.)?link\//i.test(url)) {
      const target = await followShortLink(url.replace(/^http:/i, 'https:'), SPOTIFY_SHORT, SPOTIFY_PAGES, deps.fetch, 10_000);
      if (target) parsed = parseSpotifyUrl(target.href);
      console.debug(`[SPOTIFY] short link resolved to: ${target?.href ?? 'nothing usable'}`);
    }
    if (!parsed) {
      console.debug(`[SPOTIFY] could not parse URL: ${url}`);
      return [];
    }
    console.debug(`[SPOTIFY] parsed as type=${parsed.type} id=${parsed.id}`);

    if (parsed.type === 'track') {
      const spec = toSpec(await get<SpotifyTrack>(`/tracks/${parsed.id}`).catch(missingAsEmpty));
      return spec ? [spec] : [];
    }
    if (parsed.type === 'album') {
      const album = await get<{ tracks?: Page<SpotifyTrack> }>(`/albums/${parsed.id}`).catch(missingAsEmpty);
      return collect(album?.tracks, toSpec, limit);
    }
    if (parsed.type === 'artist') {
      const market = parsed.market ?? DEFAULT_MARKET;
      const res = await get<{ tracks?: SpotifyTrack[] }>(`/artists/${parsed.id}/top-tracks?market=${market}`).catch(missingAsEmpty);
      return (res?.tracks ?? []).map(toSpec).filter(s => s !== null).slice(0, limit);
    }
    const first = await get<Page<PlaylistItem>>(`/playlists/${parsed.id}/tracks?limit=100`).catch(err => {
      // Spotify hides its own editorial playlists (Today's Top Hits, …) from
      // third-party apps since late 2024 — a 404 there isn't worth retrying.
      if (apiStatus(err) === 404) throw new UserError('search.spotify_closed');
      return missingAsEmpty(err); // 400: not a playlist id
    });
    // Whichever of the two is the track object (an API that keeps `track` as a flag beside `item` included).
    const entry = (t: unknown): SpotifyTrack | null => (t && typeof t === 'object' ? t as SpotifyTrack : null);
    return collect(first ?? undefined, item => toSpec(entry(item.item) ?? entry(item.track)), limit);
  }

  return { resolve, get, getToken };
}

const client = createSpotifyClient();

/** Resolves a Spotify track/album/playlist/artist URL to up to `limit` tracks. */
export function resolveSpotifyTracks(url: string, limit = 3): Promise<SpotifyTrackSpec[]> {
  return client.resolve(url, limit);
}
