/************************************************************
 * DJ DIKKAT - Music Bot
 * Command router
 * Slash commands and button interactions
 * Build 5.1.0
 * Author: Yanoee
 ************************************************************/
import {
  SlashCommandBuilder, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, InteractionContextType
} from 'discord.js';
import type { ButtonInteraction, ChatInputCommandInteraction, Client, Interaction, RepliableInteraction } from 'discord.js';
import { LoadType } from 'shoukaku';
import type { LavalinkResponse, Node, Track } from 'shoukaku';
import { getState, peekState, checkCooldown } from './state.ts';
import type { GuildState } from './state.ts';
import { upsertController, truncateQueueTitle, deleteMessage } from './ui.ts';
import {
  pickNode, ensurePlayer, playNext, togglePause, toggleLoopMode, stopTrack, stopPlayback, clearQueue, disconnectGuild
} from './player.ts';
import { getStatsMeta } from './stats.ts';
import { buildStatsChannelMessage } from './stats_ui.ts';
import { buildHealthMessage } from './health.ts';
import {
  getHistoryPage, setGuildSettings, resetGuildMemory, resetGuildHistory, resetGuildMessages,
  setStatsMessage, getStatsMessage, clearStatsMessage
} from './memory.ts';
import { isSpotifyUrl, resolveSpotifyTracks } from './spotify.ts';
import { sendAnnouncement } from './announcement.ts';
import { trackDm } from './dm-store.ts';
import { getMaintenance } from './runtime-flags.ts';
import { UserError, logError, errMsg } from './errors.ts';
import type { QueueTrack } from './types.ts';

let BUTTON_COOLDOWN_MS = 5000;
const BUTTON_COOLDOWN_PRUNE_LIMIT = 500;
const PAGE_SIZE = 10;
const MAX_QUEUE = 25;
const STATS_AUTO_DELETE_MS = 3 * 60 * 1000;

const ephemeral = (content: string) => ({ content, flags: MessageFlags.Ephemeral } as const);
const NOTHING_PLAYING = ephemeral('🔇 Nothing is playing');
const NOT_YOURS = ephemeral('❌ Not your message');
const ADMINS_ONLY = ephemeral('⛔ Admins only.');
const queueFull = () => `❌ Queue is full (${MAX_QUEUE} tracks max). Skip or clear some tracks first.`;

export function getButtonCooldownMs(): number { return BUTTON_COOLDOWN_MS; }
export function setButtonCooldownMs(ms: unknown): number {
  if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) BUTTON_COOLDOWN_MS = Math.min(ms, 60000);
  return BUTTON_COOLDOWN_MS;
}

/** Seconds left on this user's button cooldown, or 0 (and starts a new window). */
function getButtonCooldownRemaining(state: GuildState, userId: string): number {
  const now = Date.now();
  if (state.buttonCooldowns.size >= BUTTON_COOLDOWN_PRUNE_LIMIT) {
    for (const [id, until] of state.buttonCooldowns) if (until <= now) state.buttonCooldowns.delete(id);
  }
  const until = state.buttonCooldowns.get(userId) ?? 0;
  if (until > now) return Math.ceil((until - now) / 1000);
  state.buttonCooldowns.set(userId, now + BUTTON_COOLDOWN_MS);
  return 0;
}

const who = (t: { userId?: string | null; userTag?: string | null }) => t.userId ? `<@${t.userId}>` : (t.userTag || 'Unknown');

function pagerRow(prefix: string, guildId: string, page: number, totalPages: number, userId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}:prev:${guildId}:${page}:${userId}`).setLabel('Prev').setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`${prefix}:next:${guildId}:${page}:${userId}`).setLabel('Next').setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages)
  );
}

function buildHistoryMessage(guildId: string, page: number, userId: string) {
  const data = getHistoryPage(guildId, page, PAGE_SIZE);
  const lines = data.entries.map((e, i) =>
    `${(data.page - 1) * PAGE_SIZE + i + 1}. ${e.url ? `[${e.title}](${e.url})` : e.title} — ${who(e)}`);
  const embed = new EmbedBuilder()
    .setTitle('📜 Play History')
    .setColor(0x2b6cb0)
    .setDescription(lines.join('\n') || '—')
    .setFooter({ text: `Page ${data.page} / ${data.totalPages}` });
  const row = pagerRow('history', guildId, data.page, data.totalPages, userId).addComponents(
    new ButtonBuilder().setCustomId(`dmremove:history:${userId}`).setLabel('Remove').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
  );
  return { embeds: [embed], components: [row] };
}

function buildQueueMessage(guildId: string, state: GuildState, page: number, userId: string) {
  const total = state.queue.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * PAGE_SIZE;
  const list = state.queue.slice(start, start + PAGE_SIZE).map((t, i) => {
    const title = truncateQueueTitle(t.info.title);
    return `${start + i + 1}. ${t.info.uri ? `[${title}](${t.info.uri})` : title} || ${who({ userId: t.requesterId, userTag: t.requesterTag })}`;
  }).join('\n') || '—';

  let description = `🎶 **Now Playing:** ${truncateQueueTitle(state.current?.info.title ?? 'Nothing playing')}\n\n📜 **Up next:**\n${list}`;
  if (description.length > 4000) description = `${description.slice(0, 3997)}...`;

  const embed = new EmbedBuilder()
    .setTitle('📜 Queue')
    .setColor(0x2b6cb0)
    .setDescription(description)
    .setFooter({ text: `Page ${safePage}/${totalPages} • ${total} track(s)` });
  return { content: '', embeds: [embed], components: [pagerRow('queuepage', guildId, safePage, totalPages, userId)] };
}

// ================= SLASH COMMAND DEFINITIONS =================

const slashCommands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('🎵 Play music (search / YouTube / Spotify / SoundCloud)')
    .addStringOption(o => o.setName('query').setDescription('Search text, YouTube, Spotify or SoundCloud URL').setRequired(true)),
  new SlashCommandBuilder().setName('pause').setDescription('⏯️ Pause / Resume'),
  new SlashCommandBuilder().setName('skip').setDescription('⏭️ Skip current track'),
  new SlashCommandBuilder().setName('queue').setDescription('📜 Show queue'),
  new SlashCommandBuilder().setName('health').setDescription('🩺 Show bot health'),
  new SlashCommandBuilder().setName('stats').setDescription('📊 Show music stats'),
  new SlashCommandBuilder().setName('history').setDescription('📜 Show play history'),
  new SlashCommandBuilder().setName('disconnect').setDescription('❎ Disconnect bot'),
  new SlashCommandBuilder().setName('stop').setDescription('⏹️ Stop playback (stay in voice)')
].map(c => c.setContexts(InteractionContextType.Guild).toJSON());

export async function deployCommands(client: Client<true>): Promise<void> {
  await client.application.commands.set(slashCommands);
  console.log('✅ Slash commands deployed');
}

function replyEphemeral(interaction: RepliableInteraction, content: string) {
  return interaction.deferred || interaction.replied
    ? interaction.followUp(ephemeral(content))
    : interaction.reply(ephemeral(content));
}

// ================= SEARCH =================

function tracksOf(res: LavalinkResponse | undefined): Track[] {
  if (!res) return [];
  switch (res.loadType) {
    case LoadType.TRACK:    return [res.data];
    case LoadType.SEARCH:   return res.data;
    case LoadType.PLAYLIST: return res.data.tracks;
    default:                return [];
  }
}

const NEGATIVE_KEYWORDS = ['cover', 'remix', 'karaoke', 'reaction', 'nightcore', 'slowed', 'reverb', 'parody', 'instrumental'];

function scoreTrack(track: Track, queryWords: string[], queryLower: string): number {
  const title = track.info.title.toLowerCase();
  const author = track.info.author.toLowerCase();
  const durationSec = track.info.length / 1000;
  let score = 0;
  for (const word of queryWords) {
    if (title.includes(word)) score += 3;
    if (word.length >= 3 && author.includes(word)) score += 5;
  }
  if (durationSec >= 90 && durationSec <= 600) score += 2;
  if (/official|audio|lyrics/.test(title)) score += 1;
  for (const kw of NEGATIVE_KEYWORDS) if (title.includes(kw) && !queryLower.includes(kw)) score -= 4;
  return score;
}

function pickBestTrack(candidates: Track[], query: string): { track: Track | null; score: number } {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length >= 2);
  let best: Track | null = null;
  let bestScore = -Infinity;
  for (const track of candidates) {
    const score = scoreTrack(track, queryWords, queryLower);
    console.debug(`[SEARCH] "${query}" candidate: "${track.info.title}" score=${score}`);
    if (score > bestScore) { best = track; bestScore = score; }
  }
  if (best) console.debug(`[SEARCH] "${query}" picked: "${best.info.title}" score=${bestScore}`);
  return { track: best, score: bestScore };
}

/** Resolves a /play query to tracks. `room` = how many the queue can still take. */
async function searchTracks(node: Node, query: string, room: number, guildId: string): Promise<{ tracks: Track[]; liveWarning: boolean }> {
  const resolve = async (identifier: string) => tracksOf(await node.rest.resolve(identifier));

  if (isSpotifyUrl(query)) {
    let queries: string[];
    try {
      queries = await resolveSpotifyTracks(query, room);
    } catch (err) {
      const appErr = logError(err, { guildId });
      throw new UserError(`❌ Spotify error (ref: ${appErr.ref}). Try again in a moment, or paste a direct YouTube link instead.`);
    }
    if (!queries.length) throw new UserError('❌ No Spotify tracks found');
    const tracks: Track[] = [];
    for (const q of queries) {
      const first = (await resolve(`ytmsearch:${q}`))[0] ?? (await resolve(`ytsearch:${q}`))[0];
      if (first) tracks.push(first);
    }
    return { tracks, liveWarning: false };
  }

  if (query.startsWith('http')) return { tracks: await resolve(query), liveWarning: false };

  // Top candidates from ytmsearch: raw query + "official audio" variant in parallel
  const [primary, enhanced] = await Promise.all([resolve(`ytmsearch:${query}`), resolve(`ytmsearch:${query} official audio`)]);
  let { track, score } = pickBestTrack([...primary.slice(0, 5), ...enhanced.slice(0, 3)], query);

  // Low confidence — add ytsearch candidates to the pool and re-pick
  if (!track || score < 3) {
    const yt = (await resolve(`ytsearch:${query}`)).slice(0, 5);
    track = pickBestTrack(track ? [track, ...yt] : yt, query).track;
  }
  // Last resort: SoundCloud
  track ??= pickBestTrack((await resolve(`scsearch:${query}`)).slice(0, 3), query).track;
  if (!track) return { tracks: [], liveWarning: false };

  // Flag livestreams that weren't explicitly requested
  const ql = query.toLowerCase();
  const liveWarning = (track.info.isStream || track.info.length === 0) && !ql.includes('live') && !ql.includes('stream');
  return { tracks: [track], liveWarning };
}

// ================= HANDLERS =================

/** Voice gate for playback controls; replies and returns false when the user can't control. */
async function canControlPlayback(interaction: ChatInputCommandInteraction<'cached'> | ButtonInteraction<'cached'>, state: GuildState): Promise<boolean> {
  const memberChannelId = interaction.member.voice.channelId;
  if (!state.voiceChannelId) {
    if (memberChannelId) return true;
    await replyEphemeral(interaction, '🔊 Join a voice channel first.');
    return false;
  }
  if (!memberChannelId) {
    await replyEphemeral(interaction, '🔊 Join my voice channel first.');
    return false;
  }
  if (memberChannelId !== state.voiceChannelId) {
    await replyEphemeral(interaction, `🔒 You must be in <#${state.voiceChannelId}> to control playback.`);
    return false;
  }
  return true;
}

function requester(interaction: RepliableInteraction) {
  return { requesterId: interaction.user.id, requesterTag: interaction.user.tag };
}

async function sendDm(interaction: ChatInputCommandInteraction, payload: Parameters<ChatInputCommandInteraction['user']['send']>[0], type: string, done: string) {
  try {
    const sent = await interaction.user.send(payload);
    await trackDm(sent.channel.id, sent.id, type).catch(() => {});
    return interaction.editReply(done);
  } catch {
    return interaction.editReply('❌ I could not DM you. Check your privacy settings.');
  }
}

async function handleCommand(interaction: ChatInputCommandInteraction<'cached'>): Promise<unknown> {
  const { guildId, commandName, channelId } = interaction;

  /* 🎵 PLAY */
  if (commandName === 'play') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const query = interaction.options.getString('query', true);
    const state = getState(guildId);

    await ensurePlayer(interaction);
    state.textChannelId = channelId;
    if (state.queue.length >= MAX_QUEUE) return interaction.editReply(queueFull());

    const node = pickNode(interaction.client);
    if (!node) return interaction.editReply('❌ NodeLink not available');

    const { tracks, liveWarning } = await searchTracks(node, query, MAX_QUEUE - state.queue.length, guildId);
    if (!tracks.length) return interaction.editReply('❌ No results found');

    // Re-check: the queue may have filled up while we were searching.
    const available = MAX_QUEUE - state.queue.length;
    if (available <= 0) return interaction.editReply(queueFull());
    const added = tracks.slice(0, available);
    state.queue.push(...added.map((t): QueueTrack => ({ ...t, ...requester(interaction) })));

    // Idle: playNext() below posts the card for the new track.
    if (state.current) await upsertController(guildId, state);

    const skipped = tracks.length - added.length;
    let reply = `✅ Added **${added.length}** track(s)`;
    if (skipped > 0) reply += ` — **${skipped}** skipped (queue full at ${MAX_QUEUE})`;
    if (liveWarning) reply += '\n⚠️ This looks like a livestream — paste a direct URL for better results.';
    await interaction.editReply(reply);

    if (!state.current) await playNext(guildId);
    return;
  }

  /* 🩺 HEALTH */
  if (commandName === 'health') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) return interaction.reply(ADMINS_ONLY);
    // DB lookup + DM can take longer than Discord's 3s window — ack first.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const msg = await buildHealthMessage(interaction.client, getState(guildId), getStatsMeta(), pickNode(interaction.client), interaction.user.id, guildId);
    return sendDm(interaction, msg, 'health', '🩺 Health report sent to your DM.');
  }

  /* 📜 HISTORY */
  if (commandName === 'history') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return sendDm(interaction, buildHistoryMessage(guildId, 1, interaction.user.id), 'history', '📜 History sent to your DM.');
  }

  /* 📊 STATS */
  if (commandName === 'stats') {
    await interaction.deferReply();
    // One stats card per guild: drop the previous one before posting anew.
    const old = getStatsMessage(guildId);
    if (old.messageId && old.channelId) {
      await deleteMessage(interaction.client, old.channelId, old.messageId);
      clearStatsMessage(guildId);
    }
    // editReply resolves to the real Message (reply()'s InteractionResponse carries the interaction id).
    const message = await interaction.editReply(buildStatsChannelMessage(guildId));
    setStatsMessage(guildId, channelId, message.id);
    setTimeout(() => {
      if (peekState(guildId)?.current) return;
      message.delete().catch(() => {});
      if (getStatsMessage(guildId).messageId === message.id) clearStatsMessage(guildId);
    }, STATS_AUTO_DELETE_MS);
    return;
  }

  // Everything below controls playback
  const state = getState(guildId);
  if (!await canControlPlayback(interaction, state)) return;

  if (commandName === 'disconnect') {
    await interaction.reply(ephemeral('❎ Disconnecting…'));
    return disconnectGuild(guildId);
  }

  state.textChannelId = channelId;

  if (commandName === 'pause') {
    const paused = await togglePause(guildId); // also refreshes the card
    return interaction.reply(paused == null ? NOTHING_PLAYING : ephemeral(paused ? '⏸️ Paused' : '▶️ Resumed'));
  }

  if (commandName === 'skip') {
    if (!state.current) return interaction.reply(NOTHING_PLAYING);
    await stopTrack(guildId); // the 'stopped' end event advances + reposts the card
    return interaction.reply(ephemeral('⏭️ Skipped'));
  }

  if (commandName === 'queue') {
    await upsertController(guildId, state);
    return interaction.reply({ ...buildQueueMessage(guildId, state, 1, interaction.user.id), flags: MessageFlags.Ephemeral });
  }

  if (commandName === 'stop') {
    await stopPlayback(guildId);
    return interaction.reply(ephemeral('⏹️ Stopped playback'));
  }
}

async function dismiss(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate().catch(() => {});
  await interaction.message.delete().catch(() => {});
}

async function handleButton(interaction: ButtonInteraction): Promise<unknown> {
  const parts = interaction.customId.split(':');
  const [prefix, action = '', guildId = ''] = parts;
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;

  // DM / housekeeping buttons — keep working during maintenance
  switch (prefix) {
    case 'dmremove': // dmremove:<kind>:<userId>
      if (parts[2] !== interaction.user.id) return interaction.reply(NOT_YOURS);
      return dismiss(interaction);

    case 'memreset': { // memreset:<scope>:<guildId>:<userId>
      if (parts[3] !== interaction.user.id) return interaction.reply(NOT_YOURS);
      if (action === 'history') await resetGuildHistory(guildId);
      else if (action === 'messages') await resetGuildMessages(guildId);
      else await Promise.all([resetGuildMemory(guildId), resetGuildMessages(guildId)]);
      return dismiss(interaction);
    }

    case 'announce': // announce:remove:<guildId>
      if (!isAdmin && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply(ADMINS_ONLY);
      return dismiss(interaction);

    case 'statsremove': // statsremove:<guildId>
      if (!isAdmin) return interaction.reply(ADMINS_ONLY);
      clearStatsMessage(action);
      return dismiss(interaction);

    case 'history': { // history:<prev|next>:<guildId>:<page>:<userId>
      if (parts[4] !== interaction.user.id) return interaction.reply(NOT_YOURS);
      const page = (parseInt(parts[3] ?? '', 10) || 1) + (action === 'next' ? 1 : -1);
      return interaction.update(buildHistoryMessage(guildId, page, interaction.user.id)).catch(() => {});
    }
  }

  if (!interaction.inCachedGuild()) return;

  if (prefix === 'queuepage') { // queuepage:<prev|next>:<guildId>:<page>:<userId>
    if (parts[4] !== interaction.user.id) return interaction.reply(NOT_YOURS);
    const state = getState(guildId);
    if (!await canControlPlayback(interaction, state)) return;
    const page = (parseInt(parts[3] ?? '', 10) || 1) + (action === 'next' ? 1 : -1);
    return interaction.update(buildQueueMessage(guildId, state, page, interaction.user.id)).catch(() => {});
  }

  if (prefix !== 'music') return;

  // Only the playback-control buttons are gated by maintenance.
  const maintenance = getMaintenance();
  if (maintenance.enabled) return interaction.reply(ephemeral(maintenance.message));

  const state = getState(guildId);
  if (!await canControlPlayback(interaction, state)) return;
  const cd = getButtonCooldownRemaining(state, interaction.user.id);
  if (cd > 0) return interaction.reply(ephemeral(`⏳ Slow down — wait **${cd}s**`));

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const followUp = (content: string) => interaction.followUp(ephemeral(content));

  if (action === 'disconnect') {
    await followUp('🔌 Disconnecting…');
    return disconnectGuild(guildId);
  }
  if (action === 'stop') {
    await stopPlayback(guildId);
    return followUp('⏹️ Stopped playback');
  }

  state.textChannelId = interaction.channelId;

  switch (action) {
    case 'toggle': {
      const paused = await togglePause(guildId); // also refreshes the card
      return followUp(paused == null ? '🔇 Nothing is playing' : paused ? '⏸️ Paused' : '▶️ Resumed');
    }
    case 'skip':
      if (!state.current) return followUp('🔇 Nothing is playing');
      await stopTrack(guildId); // the 'stopped' end event advances + reposts the card
      return followUp('⏭️ Skipped');

    case 'clearqueue':
      await clearQueue(guildId); // also refreshes the card
      return followUp('🧹 Queue cleared');

    case 'queue':
      await upsertController(guildId, state);
      return interaction.editReply(buildQueueMessage(guildId, state, 1, interaction.user.id));

    case 'loop': {
      if (!state.current) return followUp('🔇 Nothing is playing');
      const mode = await toggleLoopMode(guildId);
      return followUp(mode === 'track' ? '🔂 Loop: Track' : mode === 'queue' ? '🔁 Loop: Queue' : '➡️ Loop: Off');
    }

    case 'shuffle': {
      const q = state.queue;
      if (!q.length) return followUp('📭 Queue is empty');
      for (let i = q.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [q[i], q[j]] = [q[j]!, q[i]!];
      }
      await upsertController(guildId, state);
      return followUp('🔀 Queue shuffled');
    }

    case 'replay': {
      const last = state.lastPlayed;
      if (!last?.uri && !last?.title) return followUp('❌ Nothing to replay');
      try { await ensurePlayer(interaction); } catch (err) { return followUp(`❌ ${errMsg(err)}`); }
      const node = pickNode(interaction.client);
      if (!node) return followUp('❌ NodeLink not available');
      const [track] = tracksOf(await node.rest.resolve(last.uri || `ytsearch:${last.title}`));
      if (!track) return followUp('❌ Could not find that track');
      state.queue.unshift({ ...track, ...requester(interaction) });
      if (state.current) await upsertController(guildId, state);
      else await playNext(guildId);
      return followUp('⏮️ Replaying last track!');
    }
  }
}

// ================= INTERACTION ENTRY =================

export async function handleInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
  const t0 = Date.now();
  const label = interaction.isChatInputCommand() ? interaction.commandName : interaction.customId;
  let outcome = 'ok';
  let announce = false;
  try {
    if (interaction.isButton()) {
      console.debug(`[CMD] → button ${label} guild=${interaction.guildId} user=${interaction.user.tag}`);
      await handleButton(interaction);
      return;
    }

    console.log(`[CMD] → /${label} guild=${interaction.guildId} user=${interaction.user.tag}`);
    if (!interaction.inCachedGuild()) {
      await interaction.reply(ephemeral('Use this command in a server.'));
      return;
    }
    const maintenance = getMaintenance();
    if (maintenance.enabled) {
      outcome = 'maintenance';
      await interaction.reply(ephemeral(maintenance.message));
      return;
    }
    const cd = checkCooldown(interaction.guildId);
    if (cd > 0) {
      await interaction.reply(ephemeral(`⏳ Slow down — wait **${cd}s**`));
      return;
    }
    setGuildSettings(interaction.guildId, { defaultTextChannelId: interaction.channelId, lastCommandTime: new Date().toISOString() });
    // The weekly announcement goes out after the command is handled (see
    // finally) so it never eats into Discord's 3s acknowledgement window.
    announce = true;
    await handleCommand(interaction);
  } catch (err) {
    if (err instanceof UserError) {
      outcome = 'user-error';
      await replyEphemeral(interaction, err.message).catch(() => {});
      return;
    }
    outcome = 'error';
    const appErr = logError(err, { guildId: interaction.guildId, command: label });
    await replyEphemeral(interaction, `❌ Something went wrong (ref: ${appErr.ref}). Try again in a moment.`).catch(() => {});
  } finally {
    console.debug(`[CMD] ← ${label} ${outcome} (${Date.now() - t0}ms)`);
    if (announce) {
      sendAnnouncement(interaction.guild, interaction.channelId).catch(err =>
        console.error(`Announcement failed in guild ${interaction.guildId}:`, err));
    }
  }
}
