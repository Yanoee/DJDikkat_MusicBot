/************************************************************
 * DJ DIKKAT - Music Bot
 * Radio host
 * A short spoken line over the start of a song ("That was X…
 * coming in right now: Y"), a greeting + jingle when a session
 * starts, trivia and milestones now and then. The voice is a
 * Flowery TTS track played as a NodeLink mix layer on top of
 * the song (POST /sessions/:id/players/:guild/mix) while the
 * music is turned down (PATCH volume, which NodeLink fades
 * over 1 s and which never touches the layer: layers are mixed
 * in after the player's volume). Lines: radio-lines.ts, facts:
 * trivia.ts, names: speakable.ts, jingles: jingles.ts.
 * Author: Yanoee
 ************************************************************/
import type { Player, Track } from 'shoukaku';
import { peekState } from './state.ts';
import type { GuildState } from './state.ts';
import { tracksOf } from './search.ts';
import { buildLine, isMilestone } from './radio-lines.ts';
import type { LineData, LineKind, SongRef } from './radio-lines.ts';
import { getFact } from './trivia.ts';
import { jingleFor, JINGLE_MAX_MS } from './jingles.ts';
import { upsertController } from '../ui/player-card.ts';
import { getRadio, setRadioFeature } from '../services/features.ts';
import type { Radio } from '../services/features.ts';
import { speakableName } from '../services/speakable.ts';
import { maintenanceBlocks } from '../services/config-store.ts';
import { guildLocaleVia } from '../services/locale.ts';
import { errMsg } from '../lib/errors.ts';
import type { Locale } from '../i18n/index.ts';
import type { QueueTrack } from '../lib/types.ts';

// ── Timing ──────────────────────────────────────────────────
const START_DELAY_MS = 1500;      // the line comes in this long after the song starts (over the crossfade / intro)
const NODE_WAIT_MS = 8000;        // NodeLink still loading the song's stream: wait this long for it, then let it go
const LATEST_START_MS = 20_000;   // never start talking later than this into a song
const MIN_SONG_MS = 60_000;       // shorter songs get no host (the line would cover half of it)
const RESOLVE_TIMEOUT_MS = 4000;  // NodeLink loadtracks for the TTS / jingle track
// Flowery renders on the first request and caches the result; the same
// request again answers in ~0.2–0.5 s. Andrew (Azure) takes 7–12 s cold and
// sometimes fails, Aykut (Cartesia) ~1.2 s. So lines are rendered ahead,
// during the previous song (prepareNext), and a line built on the spot only
// gets a short wait.
const WARM_LIVE_MS = 4000;        // a line built when its song starts
const WARM_FIRST_MS = 12_000;     // the greeting (nothing could be rendered ahead) and /radio test
const WARM_AHEAD_MS = 30_000;     // rendering ahead, during the previous song
const PREPARE_AFTER_MS = 15_000;  // render the next song's line once the current one has played this long
const MIX_START_TIMEOUT_MS = 5000; // POST /mix answers once Flowery's audio is flowing
const POLL_MS = 400;              // how often a playing layer is checked
const FIRST_SOUND_MS = 8000;      // a layer that hasn't played anything by then is dropped
const VOICE_MAX_MS = 25_000;      // hard stop for a line
const STOCK_JINGLE_MAX_MS = 5000; // stock jingles are 3.0–3.8 s (a server's own: JINGLE_MAX_MS, 10 s)
const VOICE_OVER_JINGLE_MS = 900; // the voice comes in over a stock jingle's dip (1.0–2.0 s)
const DUCK_LEAD_MS = 500;         // the music is on its way down before the voice comes in

// Music volume while the host talks (NodeLink player volume, 100 = normal).
const DUCK_VOLUME = 30;
// NodeLink applies a mix layer's volume twice (the layer's own PCM pipeline
// and the mixer), so it sounds like volume²: these give ~0.6 / 0.85 / 1.0.
const MIX_VOLUME: Record<Radio['volume'], number> = { quiet: 0.77, normal: 0.92, loud: 1 };

// Cadence (songs counted from the session's first one).
const TRIVIA_EVERY = 10;
const JINGLE_EVERY = 15;

// Flowery looks voices up BY NAME (lowercased); an id in ?voice= is not
// matched and silently becomes Flowery's default voice.
const VOICE: Record<Locale, string> = {
  en: 'Andrew',                         // Microsoft Azure, 3e7831ae-f785-51de-bbd0-510967e24e61
  tr: 'Aykut - Friendly Companion'      // Cartesia, 04291332-2f60-5566-bd7a-d926541e1412
};
const FLOWERY_UA = 'Mozilla/5.0 (compatible; RadioHost/1.0)';
const FLOWERY_ORIGIN = 'https://api.flowery.pw';

// ── Per-guild host state ────────────────────────────────────

/** What one host item says / plays. */
interface Item {
  song: number;               // session song number it belongs to
  kind: LineKind;
  jingle: boolean;
  text: string;
  voice: Promise<Voice | null>; // resolved + rendered TTS track, null = say nothing
}
interface Voice { encoded: string; source: 'flowery' | 'gtts' }
interface Plan { kind: LineKind | 'normal'; jingle: boolean }
interface Prepared { key: string; item: Item }

interface Host {
  songs: number;              // songs started this session
  greeted: boolean;
  lastTrivia: number;         // song numbers of the last trivia / jingle actually played
  lastJingle: number;
  lastLine: string;           // so the same line doesn't come twice in a row
  lastSpokenAt: number;
  gen: number;                // bumped by every cancel / new song: async work from before stops
  timer: NodeJS.Timeout | null;
  layers: { player: Player; id: string }[]; // playing now: one item's jingle and / or voice
  ducked: Player | null;      // the player we turned down
  volumeOps: Promise<void>;   // volume PATCHes, one after the other (see setVolume)
  prepared: Prepared | null;  // next song's line, rendered ahead
  preparing: string | null;   // key being prepared
}

const hosts = new Map<string, Host>();

function host(guildId: string): Host {
  let h = hosts.get(guildId);
  if (!h) {
    h = { songs: 0, greeted: false, lastTrivia: 0, lastJingle: 0, lastLine: '', lastSpokenAt: 0, gen: 0, timer: null, layers: [], ducked: null, volumeOps: Promise.resolve(), prepared: null, preparing: null };
    hosts.set(guildId, h);
  }
  return h;
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms).unref?.());

/** Resolves to null after `ms` instead of waiting longer. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(v => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
  });
}

// ── NodeLink mixer ──────────────────────────────────────────
// Shoukaku has no mixer calls; its REST fetch (auth, base URL, timeout) is
// protected in the types but plain in JS.
interface MixLayer { id: string; position: number }
type RestFetch = (o: { endpoint: string; options: { method?: string; headers?: Record<string, string>; body?: unknown } }) => Promise<unknown>;

function rest(player: Player): { fetch: RestFetch; sessionId: string | null } {
  const r = player.node.rest as unknown as { fetch: RestFetch; sessionId: string | null };
  return { fetch: r.fetch.bind(r), sessionId: r.sessionId };
}

const mixPath = (player: Player, guildId: string) => `/sessions/${rest(player).sessionId}/players/${guildId}/mix`;

async function mixCreate(player: Player, guildId: string, encoded: string, volume: number): Promise<string | null> {
  const res = await rest(player).fetch({
    endpoint: mixPath(player, guildId),
    options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { track: { encoded }, volume } }
  }) as { id?: unknown } | undefined;
  return typeof res?.id === 'string' ? res.id : null;
}

async function mixList(player: Player, guildId: string): Promise<MixLayer[] | null> {
  const res = await rest(player).fetch({ endpoint: mixPath(player, guildId), options: {} }).catch(() => null) as { mixes?: MixLayer[] } | null;
  return Array.isArray(res?.mixes) ? res.mixes : null;
}

/** Never throws; a layer that already ended is a 404, which is fine. */
function mixDelete(player: Player, guildId: string, id: string): Promise<void> {
  return rest(player).fetch({ endpoint: `${mixPath(player, guildId)}/${id}`, options: { method: 'DELETE' } })
    .then(() => {}, () => {});
}

// ── Ducking ─────────────────────────────────────────────────
// NodeLink's own `fading.ducking` reacts to people talking in voice (and the
// bot joins deafened), never to mix layers, so the radio turns the player's
// volume down itself. NodeLink keeps a player's volume for every song after,
// so it must always come back: on the line's end, cancel, and on a new song.

/**
 * The volume transitions.ts sends with its PATCH (every new player, every
 * /transitions change): normal, or undefined (= not sent) while the host
 * talks. A 30 from there could land after this file's own 100 and leave the
 * music down for good; a 100 landing mid-line only makes that line louder.
 */
export function musicVolume(guildId: string): number | undefined {
  return hosts.get(guildId)?.ducked ? undefined : 100;
}

/**
 * Sends the player's volume, queued behind the previous one: two PATCHes in
 * flight at once (a duck, then a skip's restore) can reach NodeLink in either
 * order, and a 30 landing last leaves every song after it quiet. update(…,
 * true) instead of setGlobalVolume: Shoukaku's plain update marks its player
 * unpaused, which a restore racing a pause would get wrong.
 */
function setVolume(guildId: string, h: Host, player: Player, volume: number, what: string): Promise<void> {
  const op = h.volumeOps.then(() => player.update({ volume }, true))
    .catch(err => console.warn(`[RADIO] guild=${guildId} ${what}: ${errMsg(err)}`));
  h.volumeOps = op;
  return op;
}

async function duck(guildId: string, h: Host, player: Player): Promise<void> {
  if (h.ducked === player) return;
  h.ducked = player;
  await setVolume(guildId, h, player, DUCK_VOLUME, 'duck failed');
}

function unduck(guildId: string, h: Host): void {
  const player = h.ducked;
  if (!player) return;
  h.ducked = null;
  // A player that's no longer ours (lost, disconnected) isn't touched: a new
  // one starts at 100 and transitions.ts sends musicVolume() to it.
  if (peekState(guildId)?.player !== player) return;
  void setVolume(guildId, h, player, 100, 'volume not restored');
}

// ── TTS ─────────────────────────────────────────────────────

async function resolveOne(player: Player, identifier: string): Promise<Track | null> {
  const res = await within(player.node.rest.resolve(identifier), RESOLVE_TIMEOUT_MS);
  return tracksOf(res ?? undefined)[0] ?? null;
}

/**
 * Asks Flowery for the exact audio NodeLink will ask for (the track's uri is
 * NodeLink's own Flowery URL), so it's rendered and cached by the time the
 * mix layer starts. True once the whole file came back.
 */
async function render(uri: string, ms: number): Promise<boolean> {
  let url: URL;
  try { url = new URL(uri); } catch { return false; }
  if (url.origin !== FLOWERY_ORIGIN) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': FLOWERY_UA, Accept: '*/*' }, signal: ctrl.signal });
    if (!res.ok) return false;
    const body = await res.arrayBuffer();
    return body.byteLength > 1000;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The line as a playable track: Flowery in the server's language, rendered
 * within `warmMs`; otherwise Google TTS for English (NodeLink's Google TTS
 * speaks one configured language, en-US, so Turkish lines don't fall back);
 * null = nothing to say.
 */
async function voiceFor(player: Player, text: string, locale: Locale, warmMs: number): Promise<Voice | null> {
  const flowery = await resolveOne(player, `ftts://${encodeURIComponent(text)}?voice=${encodeURIComponent(VOICE[locale])}`);
  if (flowery?.info.uri && await render(flowery.info.uri, warmMs)) return { encoded: flowery.encoded, source: 'flowery' };
  if (locale !== 'en') return null;
  const google = await resolveOne(player, `gtts:${text}`);
  return google ? { encoded: google.encoded, source: 'gtts' } : null;
}

// ── What to say ─────────────────────────────────────────────

/** What song number `n` gets, or null for nothing. */
function plan(n: number, h: Host, radio: Radio): Plan | null {
  if (!h.greeted) return { kind: 'greeting', jingle: radio.jingles };
  if (radio.every === 0) return null;   // only the session's first song
  const milestone = isMilestone(n);
  if (!milestone && (n - 1) % radio.every !== 0) return null;
  const jingle = radio.jingles && n - h.lastJingle >= JINGLE_EVERY;
  if (milestone) return { kind: 'milestone', jingle };
  if (radio.trivia && n - h.lastTrivia >= TRIVIA_EVERY) return { kind: 'trivia', jingle };
  // A jingle's song gets the station ID over it instead of a normal line.
  return { kind: jingle ? 'jingle_tag' : 'normal', jingle };
}

/** A song the host can talk over: long enough, not live. */
const talkable = (track: QueueTrack | null | undefined): track is QueueTrack =>
  !!track && !track.info.isStream && track.info.length >= MIN_SONG_MS;

/** The requester's server nickname as the host should say it; undefined = names are off, null = "a listener". */
function requesterName(state: GuildState, guildId: string, track: QueueTrack, radio: Radio): string | null | undefined {
  if (!radio.names) return undefined;
  if (track.autoplay || !track.requesterId) return null;
  const guild = state.client?.guilds.cache.get(guildId);
  const member = guild?.members.cache.get(track.requesterId);
  return speakableName(member?.displayName ?? track.requesterTag, guild);
}

function songRef(state: GuildState, guildId: string, track: QueueTrack, radio: Radio): SongRef {
  return { title: track.info.title, author: track.info.author, name: requesterName(state, guildId, track, radio) };
}

/** A normal line: who asked for it, what autoplay found, what was just on, or plain "up next". */
function normalKind(song: QueueTrack, prev: QueueTrack | null, radio: Radio): LineKind {
  if (song.autoplay) return 'autoplay';
  const roll = Math.random();
  if (radio.names && song.requesterId && roll < 0.4) return 'request';
  if (prev && roll < 0.75) return 'after';
  return 'next';
}

/**
 * Builds the item for `song` (song number `n`, `prev` played before it).
 * The TTS render starts right away; `warmMs` is how long it may take.
 */
async function buildItem(guildId: string, state: GuildState, player: Player, n: number, p: Plan, song: QueueTrack, prev: QueueTrack | null, warmMs: number): Promise<Item> {
  const radio = getRadio(guildId);
  const locale = guildLocaleVia(state.client, guildId);
  const h = host(guildId);
  const data: LineData = { song: songRef(state, guildId, song, radio), avoid: h.lastLine };
  if (prev) data.prev = songRef(state, guildId, prev, radio);
  if (song.autoplayFrom) data.seed = { title: song.autoplayFrom };
  let kind: LineKind = p.kind === 'normal' ? normalKind(song, prev, radio) : p.kind;
  if (kind === 'greeting') {
    const name = state.client?.guilds.cache.get(guildId)?.name;
    if (name) data.server = name;
  }
  if (kind === 'milestone') data.count = n;
  if (kind === 'trivia') {
    const fact = await getFact(song, locale).catch(() => null);
    if (fact) data.fact = fact;
    else kind = normalKind(song, prev, radio);
  }
  const text = buildLine(kind, data, locale);
  return { song: n, kind, jingle: p.jingle, text, voice: voiceFor(player, text, locale, warmMs).catch(() => null) };
}

// ── Playing an item ─────────────────────────────────────────

const stale = (h: Host, gen: number) => h.gen !== gen;

/** The guild's player still plays `track`, unpaused, with nothing changed since `gen`. */
function stillOn(guildId: string, h: Host, gen: number, player: Player, track: QueueTrack): boolean {
  const state = peekState(guildId);
  return !stale(h, gen) && !!state && state.player === player && state.current === track && !state.paused && !state.disconnecting;
}

/**
 * Waits until NodeLink really plays `track` (our playTrack answers before its
 * stream is up, and a layer added before that can be swept away by the
 * replace). Returns the song's position, or null when it never got there.
 */
async function nodeOnSong(guildId: string, h: Host, gen: number, player: Player, track: QueueTrack): Promise<number | null> {
  const until = Date.now() + NODE_WAIT_MS;
  while (stillOn(guildId, h, gen, player, track)) {
    const live = await player.node.rest.getPlayer(guildId).catch(() => null) as { track?: { encoded?: string } | null; paused?: boolean; state?: { position?: number } } | null;
    if (!stillOn(guildId, h, gen, player, track)) return null;
    const position = live?.state?.position;
    if (live?.track?.encoded === track.encoded && !live.paused && typeof position === 'number' && position >= 500) return position;
    if (Date.now() > until) return null;
    await delay(500);
  }
  return null;
}

/** Starts one mix layer; its id once NodeLink took it, null when it didn't (or things moved on meanwhile). */
async function startLayer(guildId: string, h: Host, gen: number, player: Player, encoded: string, volume: number): Promise<string | null> {
  const creating = mixCreate(player, guildId, encoded, volume).catch(err => {
    console.warn(`[RADIO] guild=${guildId} mix layer refused: ${errMsg(err)}`);
    return null;
  });
  const id = await within(creating, MIX_START_TIMEOUT_MS);
  if (!id || stale(h, gen)) {
    if (id) await mixDelete(player, guildId, id);
    // Timed out: if NodeLink still makes it, it's removed right then.
    else void creating.then(late => { if (late) return mixDelete(player, guildId, late); });
    return null;
  }
  h.layers.push({ player, id });
  return id;
}

/**
 * Waits for a layer to end (or `maxMs`, or a cancel) and removes it. NodeLink
 * reports no length for TTS / WAV tracks and Shoukaku drops its MixEndedEvent,
 * so the mix list is polled: gone = ended (NodeLink removes finished layers,
 * and all of them when the song ends); a position that stopped moving is the
 * end too (NodeLink can keep a finished layer whose last few ms never fill a
 * mixer frame).
 */
async function watchLayer(guildId: string, h: Host, gen: number, player: Player, id: string, maxMs: number): Promise<void> {
  const started = Date.now();
  let last = -1;
  let still = 0;
  try {
    while (!stale(h, gen)) {
      await delay(POLL_MS);
      if (stale(h, gen)) break;
      const layers = await mixList(player, guildId);
      if (stale(h, gen)) break;
      const elapsed = Date.now() - started;
      if (layers) {
        const layer = layers.find(l => l.id === id);
        if (!layer) break;
        if (layer.position > 0 && layer.position === last) { if (++still >= 2) break; } else still = 0;
        if (layer.position === 0 && elapsed > FIRST_SOUND_MS) break;
        last = layer.position;
      }
      if (elapsed > maxMs) break;
    }
  } finally {
    // cancelRadio already removed it when it took over.
    const i = h.layers.findIndex(l => l.id === id);
    if (i >= 0) {
      h.layers.splice(i, 1);
      await mixDelete(player, guildId, id);
    }
  }
}

/**
 * Plays the item over the song, music down meanwhile. With a jingle: a stock
 * one has a dip at 1–2 s made for the voice, so the voice comes in 0.9 s
 * after it starts, over it; a server's own jingle (unknown shape, up to 10 s)
 * plays first and the voice follows. These two are the only layers that ever
 * play together; an item never overlaps another (cancelRadio clears all).
 */
async function perform(guildId: string, h: Host, gen: number, player: Player, track: QueueTrack, item: Item, warmMs: number, onSpeak?: () => void): Promise<boolean> {
  const radio = getRadio(guildId);
  const volume = MIX_VOLUME[radio.volume];
  const ok = () => stillOn(guildId, h, gen, player, track);
  const watching: Promise<void>[] = [];
  try {
    const jingleId = item.jingle ? jingleFor(guildId, radio) : null;
    if (jingleId) {
      const stock = jingleId.startsWith('/');
      const jingle = await resolveOne(player, jingleId);
      if (jingle && ok()) {
        await duck(guildId, h, player);
        await delay(DUCK_LEAD_MS);
        const id = ok() ? await startLayer(guildId, h, gen, player, jingle.encoded, volume) : null;
        if (id) {
          h.lastJingle = item.song;
          const done = watchLayer(guildId, h, gen, player, id, stock ? STOCK_JINGLE_MAX_MS : JINGLE_MAX_MS);
          if (stock) {
            watching.push(done);
            await delay(VOICE_OVER_JINGLE_MS);
          } else await done;
        }
      }
    }
    const voice = await within(item.voice, warmMs);
    if (!voice || !ok()) return false;
    if (h.ducked !== player) {
      await duck(guildId, h, player);
      await delay(DUCK_LEAD_MS);
      if (!ok()) return false;
    }
    const id = await startLayer(guildId, h, gen, player, voice.encoded, volume);
    if (!id) return false;
    h.lastLine = item.text;
    h.lastSpokenAt = Date.now();
    if (item.kind === 'greeting') h.greeted = true;
    if (item.kind === 'trivia') h.lastTrivia = item.song;
    console.debug(`[RADIO] guild=${guildId} song=${item.song} ${item.kind}${item.jingle ? '+jingle' : ''} voice=${voice.source} "${item.text}"`);
    onSpeak?.();
    watching.push(watchLayer(guildId, h, gen, player, id, VOICE_MAX_MS));
    return true;
  } finally {
    await Promise.all(watching);
    if (!stale(h, gen)) unduck(guildId, h);
  }
}

/** The 1.5 s timer after a song started: say what this song gets. */
async function run(guildId: string, h: Host, gen: number, n: number, p: Plan): Promise<void> {
  const state = peekState(guildId);
  const player = state?.player;
  const track = state?.current;
  if (!state || !player || !talkable(track) || !stillOn(guildId, h, gen, player, track)) return;
  if (!getRadio(guildId).enabled || maintenanceBlocks('', guildId)) return;
  const position = await nodeOnSong(guildId, h, gen, player, track);
  if (position === null || position > LATEST_START_MS) return;
  // Rendered ahead during the previous song when it was the song we expected.
  const prev = state.played[1] ?? null;
  const ready = h.prepared?.key === prepKey(n, track, prev) ? h.prepared.item : null;
  h.prepared = null;
  const warmMs = ready ? WARM_LIVE_MS : p.kind === 'greeting' ? WARM_FIRST_MS : WARM_LIVE_MS;
  const item = ready ?? await buildItem(guildId, state, player, n, p, track, prev, warmMs);
  if (!stillOn(guildId, h, gen, player, track)) return;
  await perform(guildId, h, gen, player, track, item, warmMs);
}

// ── Rendering ahead ─────────────────────────────────────────

const prepKey = (n: number, song: QueueTrack, prev: QueueTrack | null) => `${n}:${song.encoded}:${prev?.encoded ?? ''}`;

/**
 * player.ts calls this on every player update (~2 s) with the song that plays
 * next: once the current song has played a while, the next song's line is
 * built and Flowery renders it, so it's instant when that song starts.
 */
export function radioTick(guildId: string, next: QueueTrack | null): void {
  const h = hosts.get(guildId);
  const state = peekState(guildId);
  if (!h || !state?.player || !state.current || state.paused || !talkable(next)) return;
  if (Date.now() - state.startedAt < PREPARE_AFTER_MS) return;
  const radio = getRadio(guildId);
  if (!radio.enabled || maintenanceBlocks('', guildId)) return;
  const n = h.songs + 1;
  const key = prepKey(n, next, state.current);
  if (h.prepared?.key === key || h.preparing === key) return;
  const p = plan(n, h, radio);
  if (!p) return;
  h.preparing = key;
  const player = state.player;
  void buildItem(guildId, state, player, n, p, next, state.current, WARM_AHEAD_MS).then(item => {
    if (h.preparing === key) h.prepared = { key, item };
  }).catch(err => console.warn(`[RADIO] guild=${guildId} prepare failed: ${errMsg(err)}`)).finally(() => {
    if (h.preparing === key) h.preparing = null;
  });
}

// ── Hooks for player.ts ─────────────────────────────────────

/** player.ts calls this whenever a new song really starts (markStarted / auto-advance). */
export function onSongStart(guildId: string): void {
  const h = host(guildId);
  cancelRadio(guildId);           // a line from the last song never runs into this one
  h.songs += 1;
  const radio = getRadio(guildId);
  if (!radio.enabled) return;
  const state = peekState(guildId);
  if (!talkable(state?.current) || maintenanceBlocks('', guildId)) return;
  const n = h.songs;
  const p = plan(n, h, radio);
  if (!p) return;
  const gen = h.gen;
  h.timer = setTimeout(() => {
    h.timer = null;
    run(guildId, h, gen, n, p).catch(err => console.warn(`[RADIO] guild=${guildId} line failed: ${errMsg(err)}`));
  }, START_DELAY_MS);
  h.timer.unref?.();
}

/** player.ts calls on skip / stop / pause / disconnect: cut any voice/jingle layer now. */
export function cancelRadio(guildId: string): void {
  const h = hosts.get(guildId);
  if (!h) return;
  h.gen += 1;
  if (h.timer) clearTimeout(h.timer);
  h.timer = null;
  for (const layer of h.layers.splice(0)) void mixDelete(layer.player, guildId, layer.id);
  unduck(guildId, h);
}

/** Session over (disconnect): counters start again with the next session. */
export function resetRadio(guildId: string): void {
  cancelRadio(guildId);
  hosts.delete(guildId);
}

/**
 * Playback came back after a restart: the session goes on, so no greeting.
 * (A kept player that a cut line left turned down gets its volume back from
 * applyTransitions, which sends musicVolume().)
 */
export function radioResumed(guildId: string, songsPlayed: number): void {
  const h = host(guildId);
  h.greeted = true;
  h.songs = Math.max(h.songs, songsPlayed);
}

// ── Settings / test ─────────────────────────────────────────

/** Save + card redraw. Used by /radio and the web panel. */
export async function setRadio(guildId: string, next: Partial<Radio>): Promise<Radio> {
  const saved = setRadioFeature(guildId, next);
  const h = hosts.get(guildId);
  // Volume / names / trivia may have changed what it says (a render still on its way is dropped too).
  if (h) { h.prepared = null; h.preparing = null; }
  if (!saved.enabled) cancelRadio(guildId);
  const state = peekState(guildId);
  if (state?.client) await upsertController(guildId, state);
  return saved;
}

/**
 * Speaks a sample line over the current song now, even while the radio is
 * off (so a server can hear it before switching it on). 'spoken' once the
 * voice started playing.
 */
export async function testRadio(guildId: string): Promise<'spoken' | 'not_playing' | 'failed'> {
  const state = peekState(guildId);
  const player = state?.player;
  const track = state?.current;
  if (!state || !player || !track || state.paused || state.disconnecting) return 'not_playing';
  if (maintenanceBlocks('', guildId)) return 'failed';
  cancelRadio(guildId);
  const h = host(guildId);
  const gen = h.gen;
  const n = Math.max(1, h.songs);
  const p: Plan = { kind: track.autoplay ? 'autoplay' : 'next', jingle: false };
  const item = await buildItem(guildId, state, player, n, p, track, state.played[1] ?? null, WARM_FIRST_MS);
  if (!stillOn(guildId, h, gen, player, track)) return 'not_playing';
  return new Promise(resolve => {
    perform(guildId, h, gen, player, track, item, WARM_FIRST_MS, () => resolve('spoken'))
      .then(spoke => { if (!spoke) resolve('failed'); }, () => resolve('failed'));
  });
}
