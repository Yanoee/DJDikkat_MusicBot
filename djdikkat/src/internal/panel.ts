/************************************************************
 * DJ DIKKAT - Music Bot
 * Panel API
 * Localhost routes for the website's server panel (/panel/*),
 * authenticated with WEB_BOT_PANEL_SECRET. Every action carries
 * the acting Discord user and re-checks their LIVE panel level
 * (Manage Server / Administrator, or a role / person on the
 * server's Panel access list) — the website's session is never
 * trusted on its own.
 * Author: Yanoee
 ************************************************************/
import { GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import type { Client, Guild, GuildBasedChannel, GuildMember } from 'discord.js';
import type { Track } from 'shoukaku';
import { getState, peekState, getActiveVoiceCount } from '../music/state.ts';
import type { GuildState } from '../music/state.ts';
import {
  pickNode, ensurePlayer, playNext, togglePause, toggleLoopMode, stopTrack, stopPlayback, clearQueue
} from '../music/player.ts';
import { search, tracksOf } from '../music/search.ts';
import { getGuildMemory, setGuildSettings } from '../services/memory.ts';
import { totalPlays } from '../services/stats.ts';
import { setGuildLocale } from '../services/locale.ts';
import { getMaintenance, maintenanceBlocks } from '../services/config-store.ts';
import { guildLocale } from '../services/locale.ts';
import { PANEL_RANK, TEXT_TYPES, VOICE_TYPES, getPermissions, panelLevel, sanitizePanel, sanitizePermissions, savePermissions } from '../services/access.ts';
import type { PanelGrant, PanelLevel } from '../services/access.ts';
import { giveRole, sendAccessRemoved, sendPanelInvite, takeRole } from '../services/panel-invite.ts';
import { getWelcome, renderCard, sanitizeWelcome, saveWelcome, sendGreeting, welcomeProblem } from '../services/greeting.ts';
import { featureNeeds, getFeatures, saveFeatures } from '../services/features.ts';
import { t } from '../i18n/index.ts';
import { buildSetupCard } from '../ui/setup-card.ts';
import { upsertController } from '../ui/player-card.ts';
import { renderNowPlaying } from '../ui/np-image.ts';
import { UserError, logError } from '../lib/errors.ts';
import { isLocale } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';
import type { QueueTrack } from '../lib/types.ts';

type Body = Record<string, unknown>;
type Reply = [status: number, data: unknown];

const MAX_QUEUE = 25;
const MEMBER_LIST = 1000;   // members shown in the Panel access picker; bigger servers search by name
const RESOLVE_CONCURRENCY = 5;
const str = (v: unknown, max = 300) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v) ? v : -1;
/** #rrggbb (lower case), null to reset, undefined if it's neither. */
const cardAccent = (v: unknown) => v === null ? null : typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined;

/** UserError keys → language-neutral codes the website translates. */
const ERROR_CODES: Partial<Record<MessageKey, string>> = {
  'voice.join_first': 'not_in_voice',
  'voice.join_mine': 'not_in_voice',
  'voice.busy_elsewhere': 'busy_elsewhere',
  'common.music_server_down': 'bot_offline'
};


function loopMode(state: GuildState): 'off' | 'track' | 'queue' {
  return state.loopCurrent ? 'track' : state.loopQueue ? 'queue' : 'off';
}

const trackView = (track: QueueTrack) => ({
  title: track.info.title,
  author: track.info.author,
  uri: track.info.uri ?? null,
  artwork: track.info.artworkUrl ?? null,
  lengthMs: track.info.isStream ? 0 : track.info.length,
  requester: track.requesterTag
});

/** Maintenance blocks every web action, like it blocks commands (owners and the test server pass).
 *  `message` is the admin's custom text only; the website has its own translated default. */
function maintenanceFor(userId: string, guildId: string) {
  return maintenanceBlocks(userId, guildId) ? { message: getMaintenance().message || null } : null;
}

// What the bot needs in a channel, as codes the website translates.
const TEXT_NEEDS = [[PermissionFlagsBits.ViewChannel, 'view'], [PermissionFlagsBits.SendMessages, 'send'], [PermissionFlagsBits.EmbedLinks, 'embed']] as const;
const VOICE_NEEDS = [[PermissionFlagsBits.ViewChannel, 'view'], [PermissionFlagsBits.Connect, 'connect'], [PermissionFlagsBits.Speak, 'speak']] as const;

/** Roles, channels and saved settings for the panel's Permissions / Welcome / Stats pages. */
function metaView(client: Client, guild: Guild, viewerId: string) {
  const me = guild.members.me;
  const channels = (types: readonly number[], needs: typeof TEXT_NEEDS | typeof VOICE_NEEDS) =>
    [...guild.channels.cache.values()]
      .filter((c): c is Exclude<GuildBasedChannel, { isThread(): true }> & { rawPosition: number } => types.includes(c.type) && !c.isThread())
      .sort((a, b) => ((a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1)) || a.rawPosition - b.rawPosition)
      .map(c => ({
        id: c.id, name: c.name, category: c.parent?.name ?? null,
        missing: me ? needs.filter(([flag]) => !c.permissionsFor(me).has(flag)).map(([, code]) => code) : []
      }));
  return {
    name: guild.name,
    icon: guild.iconURL({ size: 128 }),
    memberCount: guild.memberCount,
    roles: guild.roles.cache.filter(r => r.id !== guild.id && !r.managed).sort((a, b) => b.position - a.position)
      .map(r => ({ id: r.id, name: r.name, color: r.color ? r.hexColor : null, assignable: r.editable })),
    systemChannelId: guild.systemChannelId,
    // Server-wide bot permissions the panel can ask the admin to grant ("Fix permissions").
    botPerms: {
      viewAuditLog: !!me?.permissions.has(PermissionFlagsBits.ViewAuditLog),
      attachFiles: !!me?.permissions.has(PermissionFlagsBits.AttachFiles),
      manageRoles: !!me?.permissions.has(PermissionFlagsBits.ManageRoles),
      manageGuild: !!me?.permissions.has(PermissionFlagsBits.ManageGuild)
    },
    features: getFeatures(guild.id),
    featureNeeds: featureNeeds(guild),
    text: channels(TEXT_TYPES, TEXT_NEEDS),
    voice: channels(VOICE_TYPES, VOICE_NEEDS),
    membersIntent: client.options.intents.has(GatewayIntentBits.GuildMembers),
    locale: guildLocale(guild.id, guild),
    permissions: getPermissions(guild.id),
    welcome: getWelcome(guild.id),
    cardAccent: getGuildMemory(guild.id).settings.cardAccent,
    maintenance: maintenanceFor(viewerId, guild.id)
  };
}

function stateView(guild: Guild, viewerId = '') {
  const state = peekState(guild.id);
  const channel = state?.voiceChannelId ? guild.channels.cache.get(state.voiceChannelId) : undefined;
  return {
    inGuild: true,
    maintenance: maintenanceFor(viewerId, guild.id),
    // Maintenance is on but this viewer passes (owner or test server): the panel says so.
    maintenanceBypass: getMaintenance().enabled && !maintenanceBlocks(viewerId, guild.id),
    locale: getGuildMemory(guild.id).settings.locale,
    voiceChannel: channel?.isVoiceBased()
      ? { id: channel.id, name: channel.name, listeners: channel.members.filter(m => !m.user.bot).size }
      : null,
    current: state?.current ? { ...trackView(state.current), positionMs: state.player?.position ?? 0 } : null,
    paused: state?.paused ?? false,
    loop: state ? loopMode(state) : 'off',
    queue: (state?.queue ?? []).map(trackView),
    lastPlayed: state?.lastPlayed ?? null
  };
}

/** Resolves links to tracks (playlist play / requeue), a few at a time. */
async function resolveAll(client: Client, uris: string[]): Promise<Track[]> {
  const node = pickNode(client);
  if (!node) throw new UserError('common.music_server_down');
  const out: Track[] = [];
  for (let i = 0; i < uris.length; i += RESOLVE_CONCURRENCY) {
    const batch = await Promise.all(uris.slice(i, i + RESOLVE_CONCURRENCY)
      .map(uri => node.rest.resolve(uri).then(tracksOf, () => [])));
    for (const tracks of batch) if (tracks[0]) out.push(tracks[0]);
  }
  return out;
}

export function buildPanelRoutes(client: Client<true>) {
  /** The acting member and their panel level, if it's at least `need` right now. */
  async function actor(guild: Guild, body: Body, need: PanelLevel): Promise<{ member: GuildMember; level: PanelLevel } | null> {
    const userId = str(body.userId, 20);
    if (!/^\d{17,20}$/.test(userId)) return null;
    const member = await guild.members.fetch(userId).catch(() => null);
    const level = member ? panelLevel(member) : null;
    return member && level && PANEL_RANK[level] >= PANEL_RANK[need] ? { member, level } : null;
  }

  /** Player for a web action that needs one: the existing one, else join the actor's voice channel. */
  async function playerFor(guild: Guild, member: GuildMember, state: GuildState): Promise<void> {
    if (state.player) return;
    await ensurePlayer({ guildId: guild.id, guild, user: member.user, client });
    state.textChannelId ??= getGuildMemory(guild.id).settings.defaultTextChannelId;
  }

  async function enqueue(guild: Guild, member: GuildMember, state: GuildState, tracks: Track[]): Promise<number> {
    const room = MAX_QUEUE - state.queue.length;
    const added = tracks.slice(0, Math.max(0, room));
    state.queue.push(...added.map((t): QueueTrack => ({ ...t, requesterId: member.id, requesterTag: member.user.tag })));
    if (state.current) await upsertController(guild.id, state);
    else if (added.length) await playNext(guild.id);
    return added.length;
  }

  async function act(guild: Guild, member: GuildMember, body: Body): Promise<Reply> {
    const action = str(body.action, 20);
    const state = getState(guild.id);
    state.webActor = { name: member.displayName, at: Date.now() };
    const done = (extra: object = {}): Reply => [200, { ok: true, ...extra, state: stateView(guild, member.id) }];

    switch (action) {
      case 'pause':
      case 'resume': {
        if (!state.current) return [409, { error: 'nothing_playing' }];
        if (state.paused !== (action === 'pause')) await togglePause(guild.id);
        return done();
      }
      case 'skip':
        if (!state.current) return [409, { error: 'nothing_playing' }];
        await stopTrack(guild.id);
        return done();
      case 'stop':
        await stopPlayback(guild.id);
        return done();
      case 'clear':
        await clearQueue(guild.id);
        return done();
      case 'loop':
        if (!state.current) return [409, { error: 'nothing_playing' }];
        await toggleLoopMode(guild.id);
        return done();
      case 'seek': {
        const cur = state.current;
        if (!cur || !state.player) return [409, { error: 'nothing_playing' }];
        if (cur.info.isStream || !cur.info.isSeekable) return [400, { error: 'invalid' }];
        const ms = int(body.position);
        if (ms < 0 || ms > cur.info.length) return [400, { error: 'invalid' }];
        await state.player.seekTo(ms);
        return done();
      }
      case 'shuffle': {
        const q = state.queue;
        for (let i = q.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [q[i], q[j]] = [q[j]!, q[i]!];
        }
        await upsertController(guild.id, state);
        return done();
      }
      case 'remove': {
        const pos = int(body.position);
        if (pos < 0 || pos >= state.queue.length) return [400, { error: 'invalid' }];
        state.queue.splice(pos, 1);
        await upsertController(guild.id, state);
        return done();
      }
      case 'move': {
        const from = int(body.from);
        const to = int(body.to);
        if (from < 0 || to < 0 || from >= state.queue.length || to >= state.queue.length) return [400, { error: 'invalid' }];
        const [track] = state.queue.splice(from, 1);
        state.queue.splice(to, 0, track!);
        await upsertController(guild.id, state);
        return done();
      }
      case 'jump': { // play this queued track now: to the front, then skip like the Skip button
        const pos = int(body.position);
        if (pos < 0 || pos >= state.queue.length) return [400, { error: 'invalid' }];
        const [track] = state.queue.splice(pos, 1);
        state.queue.unshift(track!);
        if (state.current) await stopTrack(guild.id);
        else await playNext(guild.id);
        return done();
      }
      case 'add': {
        const query = str(body.query, 300);
        if (query.length < 2) return [400, { error: 'invalid' }];
        if (state.queue.length >= MAX_QUEUE) return [409, { error: 'queue_full' }];
        await playerFor(guild, member, state);
        const node = pickNode(client);
        if (!node) return [503, { error: 'bot_offline' }];
        const { tracks } = await search(id => node.rest.resolve(id), query, MAX_QUEUE - state.queue.length, guild.id);
        if (!tracks.length) return [404, { error: 'no_results' }];
        return done({ added: await enqueue(guild, member, state, tracks) });
      }
      case 'playlist':
      case 'requeue': {
        const items = Array.isArray(body.uris) ? body.uris.map(u => str(u, 1024)).filter(u => /^https?:\/\//.test(u)) : [];
        if (!items.length) return [400, { error: 'invalid' }];
        if (state.queue.length >= MAX_QUEUE) return [409, { error: 'queue_full' }];
        await playerFor(guild, member, state);
        const tracks = await resolveAll(client, items.slice(0, MAX_QUEUE - state.queue.length));
        if (!tracks.length) return [404, { error: 'no_results' }];
        return done({ added: await enqueue(guild, member, state, tracks) });
      }
      case 'locale': {
        const locale = str(body.locale, 5);
        setGuildLocale(guild.id, isLocale(locale) ? locale : null);
        if (state.current || state.player) await upsertController(guild.id, state);
        return done();
      }
    }
    return [400, { error: 'invalid' }];
  }

  /** Settings from the Permissions and Welcome pages (panel level 1 or admin; not blocked by maintenance). */
  async function configure(guild: Guild, member: GuildMember, level: PanelLevel, body: Body): Promise<Reply> {
    switch (str(body.op, 20)) {
      case 'permissions': {
        const perms = sanitizePermissions(guild, body.data);
        const invites: { id: string; name: string; ok: boolean | null; role: boolean | null }[] = [];
        let removed: PanelGrant[] = [];
        // The Panel access list is Manage Server only, so level 1 can't hand out access.
        if (level === 'admin') {
          const before = new Map(perms.panel.filter(g => g.type === 'user').map(g => [g.id, g]));
          const rawPanel = (body.data as Body | undefined)?.panel;
          perms.panel = await sanitizePanel(guild, rawPanel);
          // New people: the optional Discord role, then the invite DM (admins already have access).
          // People already listed keep their invite status and the role the panel gave them.
          // ponytail: roles and invites go out one by one inside the save request; fine for a few at a time.
          for (const g of perms.panel) {
            if (g.type !== 'user') continue;
            const prev = before.get(g.id);
            if (prev) { Object.assign(g, { invite: prev.invite, role: prev.role }); continue; }
            const asked = (Array.isArray(rawPanel) ? rawPanel as (Body | null)[] : []).find(r => r?.type === 'user' && r.id === g.id)?.giveRole;
            const roleOk = typeof asked === 'string' ? await giveRole(guild, member, g.id, asked) : null;
            if (roleOk) g.role = asked as string;
            const target = guild.members.cache.get(g.id);
            const ok = target && panelLevel(target) === 'admin' ? null : await sendPanelInvite(guild, g.id, g.level, member.displayName);
            if (ok !== null) g.invite = ok ? 'sent' : 'failed';
            invites.push({ id: g.id, name: g.name ?? g.id, ok, role: roleOk });
          }
          const kept = new Set(perms.panel.map(g => g.id));
          removed = [...before.values()].filter(g => !kept.has(g.id));
        }
        savePermissions(guild.id, perms);
        for (const g of removed) {
          if (g.role) await takeRole(guild, g.id, g.role);
          await sendAccessRemoved(guild, g.id);
        }
        return [200, { ok: true, permissions: getPermissions(guild.id), invites }];
      }
      case 'invite': { // "Send again" for one person on the Panel access list
        if (level !== 'admin') return [403, { error: 'forbidden' }];
        const perms = getPermissions(guild.id);
        const grant = perms.panel.find(g => g.type === 'user' && g.id === str(body.target, 20));
        if (!grant) return [404, { error: 'not_found' }];
        const ok = await sendPanelInvite(guild, grant.id, grant.level, member.displayName);
        grant.invite = ok ? 'sent' : 'failed';
        savePermissions(guild.id, perms);
        return [200, { ok, permissions: getPermissions(guild.id) }];
      }
      case 'welcome': {
        const welcome = sanitizeWelcome(guild, body.data);
        const problem = welcome.enabled ? welcomeProblem(welcome, guild) : null;
        if (problem) return [400, { error: problem }];
        saveWelcome(guild.id, welcome);
        return [200, { ok: true, welcome: getWelcome(guild.id) }];
      }
      case 'card': { // the player card's colour; null = back to the site blue
        const accent = cardAccent(body.accent);
        if (accent === undefined) return [400, { error: 'invalid' }];
        setGuildSettings(guild.id, { cardAccent: accent });
        const state = peekState(guild.id);
        if (state?.player) await upsertController(guild.id, state);
        return [200, { ok: true, cardAccent: accent }];
      }
      case 'card-preview': { // the card in that colour: the song playing now, else a sample
        const accent = cardAccent(body.accent);
        if (accent === undefined) return [400, { error: 'invalid' }];
        const locale = guildLocale(guild.id, guild);
        const info = peekState(guild.id)?.current?.info;
        const png = await renderNowPlaying({
          title: info?.title ?? 'Straight Outta Şanlıurfa', artist: info ? info.author : 'DJ Dikkat',
          artworkUrl: info ? info.artworkUrl ?? null : guild.client.user.displayAvatarURL({ extension: 'png', size: 256 }),
          positionMs: info ? peekState(guild.id)?.player?.position ?? 0 : 99000, lengthMs: info ? (info.isStream ? 0 : info.length) : 245000,
          paused: false, label: t(locale, 'card.img.playing'), liveLabel: t(locale, 'card.live'), source: info?.sourceName ?? 'Spotify',
          accent, locale
        });
        return [200, { image: `data:image/png;base64,${png.toString('base64')}` }];
      }
      case 'welcome-preview': { // the image card as the admin would see it, drawn for the admin
        const png = await renderCard(sanitizeWelcome(guild, body.data), member);
        return [200, { image: `data:image/png;base64,${png.toString('base64')}` }];
      }
      case 'features': {
        const { features, error } = await saveFeatures(guild, body.data, t(guildLocale(guild.id, guild), 'automod.blocked'));
        return [200, { ok: !error, error, features, featureNeeds: featureNeeds(guild) }];
      }
      case 'welcome-test': { // the editor's current (unsaved) message, as if the admin just joined
        const failed = await sendGreeting(sanitizeWelcome(guild, body.data), member);
        return failed ? [409, { error: failed }] : [200, { ok: true }];
      }
      case 'setup-post': {
        const channel = guild.channels.cache.get(str(body.channelId, 20));
        if (!channel || !TEXT_TYPES.includes(channel.type) || !channel.isSendable()) return [400, { error: 'welcome_channel' }];
        const sent = await channel.send(buildSetupCard(guild, guildLocale(guild.id, guild))).catch(() => null);
        return sent ? [200, { ok: true }] : [409, { error: 'cannot_send' }];
      }
    }
    return [400, { error: 'invalid' }];
  }

  return async (method: string, url: string, body: Body): Promise<Reply | null> => {
    const [path = '', query = ''] = url.split('?');
    if (method === 'GET' && path === '/panel/status') {
      return [200, { guilds: client.guilds.cache.size, active: getActiveVoiceCount(), played: totalPlays() }];
    }
    // Which of these guilds the bot is in (a user's manageable servers), plus the other
    // servers of the user where the Panel access list lets them in (login), with their level.
    if (method === 'POST' && path === '/panel/guilds') {
      const list = (v: unknown) => Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string').slice(0, 200) : [];
      const view = (g: Guild, level: PanelLevel) => {
        const state = peekState(g.id);
        return { id: g.id, name: g.name, icon: g.iconURL({ size: 64 }), playing: !!state?.current, track: state?.current?.info.title ?? null, level };
      };
      const guilds = list(body.ids).map(id => client.guilds.cache.get(id)).filter((g): g is Guild => !!g).map(g => view(g, 'admin'));
      const userId = str(body.userId, 20);
      if (/^\d{17,20}$/.test(userId)) {
        for (const g of list(body.granted).map(id => client.guilds.cache.get(id))) {
          if (!g || !getPermissions(g.id).panel.length) continue;
          const member = await g.members.fetch(userId).catch(() => null);
          const level = member ? panelLevel(member) : null;
          if (level) guilds.push(view(g, level));
        }
      }
      return [200, { guilds }];
    }

    const m = path.match(/^\/panel\/guild\/(\d{17,20})\/(state|action|member|meta|config|avatars|members)$/);
    if (!m) return null;
    const guild = client.guilds.cache.get(m[1]!);
    if (!guild) return [404, { error: 'not_in_guild' }];

    const viewer = new URLSearchParams(query).get('user') ?? '';
    if (method === 'GET' && m[2] === 'state') return [200, stateView(guild, viewer)];
    if (method === 'GET' && m[2] === 'meta') return [200, metaView(client, guild, viewer)];
    // Profile photos for the Stats page's top listeners (server avatar, else account avatar, else Discord's default).
    if (method === 'GET' && m[2] === 'avatars') {
      const ids = (new URLSearchParams(query).get('ids') ?? '').split(',').filter(id => /^\d{17,20}$/.test(id)).slice(0, 10);
      const avatars = await Promise.all(ids.map(async id => {
        const who = guild.members.cache.get(id) ?? client.users.cache.get(id) ?? await client.users.fetch(id).catch(() => null);
        return [id, who?.displayAvatarURL({ size: 64 }) ?? null];
      }));
      return [200, { avatars: Object.fromEntries(avatars) }];
    }
    // Members for the Panel access list (the website only lets admins call it): the server's
    // members straight from Discord (first 1000), or a name search for bigger servers.
    if (method === 'GET' && m[2] === 'members') {
      const q = (new URLSearchParams(query).get('q') ?? '').trim().slice(0, 32);
      const found = q.length >= 2
        ? await guild.members.search({ query: q, limit: 25 }).catch(() => null)
        : await guild.members.list({ limit: MEMBER_LIST }).catch(() => null);
      const members = [...(found?.values() ?? [])].filter(mb => !mb.user.bot)
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .map(mb => ({
          id: mb.id, name: mb.displayName, username: mb.user.username, avatar: mb.displayAvatarURL({ size: 64 }),
          roles: mb.roles.cache.filter(r => r.id !== guild.id).sort((a, b) => b.position - a.position).map(r => r.id).slice(0, 4),
          admin: panelLevel(mb) === 'admin'
        }));
      return [200, { members, more: !q && (found?.size ?? 0) >= MEMBER_LIST }];
    }

    if (method === 'POST' && m[2] === 'config') {
      const who = await actor(guild, body, 'full');
      if (!who) return [403, { error: 'forbidden' }];
      try {
        return await configure(guild, who.member, who.level, body);
      } catch (err) {
        const appErr = logError(err, { guildId: guild.id, during: `panel config ${str(body.op, 20)}` });
        return [500, { error: 'server', ref: appErr.ref }];
      }
    }

    if (method === 'POST' && m[2] === 'member') {
      const who = await actor(guild, body, 'dj');
      return [200, { canManage: !!who, level: who?.level ?? null }];
    }

    if (method === 'POST' && m[2] === 'action') {
      const who = await actor(guild, body, 'dj');
      // The server language lives on the Settings tab: level 1 and up.
      if (!who || (body.action === 'locale' && who.level === 'dj')) return [403, { error: 'forbidden' }];
      const { member } = who;
      const blocked = maintenanceFor(member.id, guild.id);
      if (blocked) return [423, { error: 'maintenance', ...blocked, state: stateView(guild, member.id) }];
      try {
        return await act(guild, member, body);
      } catch (err) {
        if (err instanceof UserError) return [409, { error: ERROR_CODES[err.key] ?? 'no_results' }];
        const appErr = logError(err, { guildId: guild.id, during: `panel ${str(body.action, 20)}` });
        return [500, { error: 'server', ref: appErr.ref }];
      }
    }
    return [405, { error: 'invalid' }];
  };
}
