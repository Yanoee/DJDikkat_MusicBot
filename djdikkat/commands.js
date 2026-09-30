/************************************************************
 * DJ DIKKAT - Music Bot
 * Command router
 * Slash commands and button interactions
 * Build 5.0.0
 * Author: Yanoee
 ************************************************************/

const {
  SlashCommandBuilder,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits
} = require('discord.js');

const {
  getState,
  peekState,
  checkCooldown
} = require('./state');

const {
  upsertController,
  truncateQueueTitle,
  deleteMessage
} = require('./ui');

const {
  loadTracks,
  pickNode,
  ensurePlayer,
  playNext,
  togglePause,
  toggleLoopMode,
  stopTrack,
  stopPlayback,
  clearQueue,
  disconnectGuild
} = require('./player');

const { getStatsMeta } = require('./stats');
const { buildStatsChannelMessage } = require('./stats_ui');
const { buildHealthMessage } = require('./health');
const { getHistoryPage, setGuildSettings, resetGuildMemory, resetGuildHistory, resetGuildMessages, setStatsMessage, getStatsMessage, clearStatsMessage } = require('./memory');
const { isSpotifyUrl, resolveSpotifyTracks } = require('./spotify');
const { sendAnnouncement } = require('./announcement');
const { trackDm } = require('./dm-store');
const { getMaintenance } = require('./runtime-flags');
const { UserError, logError } = require('./errors');

let BUTTON_COOLDOWN_MS = 5000;
const BUTTON_COOLDOWN_PRUNE_LIMIT = 500;
const QUEUE_PAGE_SIZE = 10;
const MAX_QUEUE = 25;
const STATS_AUTO_DELETE_MS = 3 * 60 * 1000;

function getButtonCooldownMs() { return BUTTON_COOLDOWN_MS; }
function setButtonCooldownMs(ms) {
  if (Number.isFinite(ms) && ms >= 0) BUTTON_COOLDOWN_MS = Math.min(ms, 60000);
  return BUTTON_COOLDOWN_MS;
}

function pruneButtonCooldowns(state, now) {
  if (state.buttonCooldowns.size < BUTTON_COOLDOWN_PRUNE_LIMIT) return;
  for (const [userId, until] of state.buttonCooldowns.entries()) {
    if (until <= now) state.buttonCooldowns.delete(userId);
  }
}

function getButtonCooldownRemaining(state, userId) {
  const now = Date.now();
  pruneButtonCooldowns(state, now);
  const until = state.buttonCooldowns.get(userId) || 0;
  if (until > now) return Math.ceil((until - now) / 1000);
  state.buttonCooldowns.set(userId, now + BUTTON_COOLDOWN_MS);
  return 0;
}

function buildHistoryEmbed(pageData) {
  const lines = pageData.entries.map((e, idx) => {
    const n = (pageData.page - 1) * 10 + idx + 1;
    const title = e.title || 'Unknown';
    const link = e.url ? `[${title}](${e.url})` : title;
    const who = e.userId ? `<@${e.userId}>` : (e.userTag || 'Unknown');
    return `${n}. ${link} — ${who}`;
  });

  return new EmbedBuilder()
    .setTitle('📜 Play History')
    .setColor(0x2b6cb0)
    .setDescription(lines.length ? lines.join('\n') : '—')
    .setFooter({ text: `Page ${pageData.page} / ${pageData.totalPages}` });
}

function buildHistoryComponents(guildId, page, totalPages, userId) {
  const prevDisabled = page <= 1;
  const nextDisabled = page >= totalPages;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`history:prev:${guildId}:${page}:${userId}`)
        .setLabel('Prev')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(prevDisabled),
      new ButtonBuilder()
        .setCustomId(`history:next:${guildId}:${page}:${userId}`)
        .setLabel('Next')
        .setEmoji('⏭️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(nextDisabled),
      new ButtonBuilder()
        .setCustomId(`dmremove:history:${userId}`)
        .setLabel('Remove')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
    )
  ];
}

// ================= SLASH COMMAND DEFINITIONS =================

const slashCommands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('🎵 Play music (search / YouTube / Spotify / SoundCloud)')
    .addStringOption(o =>
      o.setName('query')
        .setDescription('Search text, YouTube, Spotify or SoundCloud URL')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('⏯️ Pause / Resume'),

  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('⏭️ Skip current track'),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('📜 Show queue'),

  new SlashCommandBuilder()
    .setName('health')
    .setDescription('🩺 Show bot health'),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('📊 Show music stats'),

  new SlashCommandBuilder()
    .setName('history')
    .setDescription('📜 Show play history'),

  new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('❎ Disconnect bot'),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('⏹️ Stop playback (stay in voice)')
].map(c => c.toJSON());


async function deployCommands(client) {
  await client.application.commands.set(slashCommands);
  console.log('✅ Slash commands deployed');
}

function replyEphemeral(interaction, content) {
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  }
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

function extractTracks(data) {
  if (Array.isArray(data)) return data;
  if (data?.tracks && Array.isArray(data.tracks)) return data.tracks;
  if (data?.encoded) return [data];
  return [];
}

function pickFirstTrack(data) {
  const tracks = extractTracks(data);
  return tracks.length ? [tracks[0]] : [];
}

function scoreTrack(track, queryWords, queryLower) {
  const info = track.info || {};
  const titleLower  = (info.title  || '').toLowerCase();
  const authorLower = (info.author || '').toLowerCase();
  const durationSec = (info.length || 0) / 1000;
  let score = 0;

  for (const word of queryWords) {
    if (titleLower.includes(word))                       score += 3;
    if (word.length >= 3 && authorLower.includes(word))  score += 5;
  }

  if (durationSec >= 90 && durationSec <= 600) score += 2;

  if (
    titleLower.includes('official') ||
    titleLower.includes('audio')    ||
    titleLower.includes('lyrics')
  ) score += 1;

  const negatives = ['cover', 'remix', 'karaoke', 'reaction', 'nightcore', 'slowed', 'reverb', 'parody', 'instrumental'];
  for (const kw of negatives) {
    if (titleLower.includes(kw) && !queryLower.includes(kw)) score -= 4;
  }

  return score;
}

function pickBestTrack(candidates, query) {
  if (!candidates.length) return { track: null, score: -Infinity };
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length >= 2);
  let best = candidates[0];
  let bestScore = scoreTrack(candidates[0], queryWords, queryLower);
  console.debug(`[SEARCH] "${query}" candidate: "${candidates[0].info?.title}" score=${bestScore}`);
  for (let i = 1; i < candidates.length; i++) {
    const s = scoreTrack(candidates[i], queryWords, queryLower);
    console.debug(`[SEARCH] "${query}" candidate: "${candidates[i].info?.title}" score=${s}`);
    if (s > bestScore) { best = candidates[i]; bestScore = s; }
  }
  console.debug(`[SEARCH] "${query}" picked: "${best?.info?.title}" score=${bestScore}`);
  return { track: best, score: bestScore };
}

function getQueuePageData(state, page, pageSize = QUEUE_PAGE_SIZE) {
  const queue = Array.isArray(state?.queue) ? state.queue : [];
  const total = queue.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const entries = queue.slice(start, start + pageSize);
  return { entries, page: safePage, totalPages, total };
}

function buildQueueComponents(guildId, page, totalPages, userId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`queuepage:prev:${guildId}:${page}:${userId}`)
        .setLabel('Prev')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 1),
      new ButtonBuilder()
        .setCustomId(`queuepage:next:${guildId}:${page}:${userId}`)
        .setLabel('Next')
        .setEmoji('⏭️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages)
    )
  ];
}

function buildQueueContent(state, pageData) {
  const now = state.current?.info?.title
    ? state.current.info.title
    : 'Nothing playing';

  const list = pageData.entries.length
    ? pageData.entries
        .map((t, idx) => {
          const n = (pageData.page - 1) * QUEUE_PAGE_SIZE + idx + 1;
          const title = truncateQueueTitle(t.info?.title);
          const uri = t.info?.uri || null;
          const label = uri ? `[${title}](${uri})` : title;
          const requestedBy = t.requesterId ? `<@${t.requesterId}>` : (t.requesterTag || 'Unknown');
          return `${n}. ${label} || ${requestedBy}`;
        })
        .join('\n')
    : '—';

  const safeNow = truncateQueueTitle(now);
  let description = `🎶 **Now Playing:** ${safeNow}\n\n📜 **Up next:**\n${list}`;
  if (description.length > 4000) {
    description = `${description.slice(0, 3997)}...`;
  }

  return new EmbedBuilder()
    .setTitle('📜 Queue')
    .setColor(0x2b6cb0)
    .setDescription(description)
    .setFooter({ text: `Page ${pageData.page}/${pageData.totalPages} • ${pageData.total} track(s)` });
}

async function canControlPlayback(interaction, state) {
  if (!interaction.guild) return false;

  let member = interaction.member;
  if (!member?.voice) {
    member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  }

  const memberChannelId = member?.voice?.channelId || member?.voice?.channel?.id || null;

  if (!state?.voiceChannelId) {
    if (!memberChannelId) {
      await replyEphemeral(interaction, '🔊 Join a voice channel first.');
      return false;
    }
    return true;
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

// ================= INTERACTION HANDLER =================

async function handleInteraction(interaction) {
  const _t0 = Date.now();
  let _label = null;
  let _outcome = 'ok';
  let _announce = false;
  try {
    /* ---------------- SLASH COMMANDS ---------------- */
    if (interaction.isChatInputCommand()) {
      const { guildId, commandName } = interaction;
      _label = commandName;
      console.log(`[CMD] → /${commandName} guild=${guildId} user=${interaction.user?.tag || interaction.user?.id}`);

      const maintenance = getMaintenance();
      if (maintenance.enabled) {
        _outcome = 'maintenance';
        return interaction.reply({ content: maintenance.message, flags: MessageFlags.Ephemeral });
      }

      const cd = checkCooldown(guildId);
      if (cd > 0) {
        return interaction.reply({
          content: `⏳ Slow down — wait **${cd}s**`,
          flags: MessageFlags.Ephemeral
        });
      }

      await setGuildSettings(guildId, {
        defaultTextChannelId: interaction.channelId,
        lastCommandTime: new Date().toISOString()
      });

      // The weekly announcement goes out after the command is handled (see
      // finally) so it never eats into Discord's 3s acknowledgement window.
      _announce = true;

      /* 🎵 PLAY */
      if (commandName === 'play') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const query = interaction.options.getString('query', true);
        const state = getState(guildId);

        await ensurePlayer(interaction);
        state.textChannelId = interaction.channelId;

        if (state.queue.length >= MAX_QUEUE) {
          return interaction.editReply(`❌ Queue is full (${MAX_QUEUE} tracks max). Skip or clear some tracks first.`);
        }

        const node = pickNode(interaction.client);
        if (!node) {
          return interaction.editReply('❌ NodeLink not available');
        }

        let tracks = [];

        if (isSpotifyUrl(query)) {
          let queries = [];
          try {
            // Only resolve as many tracks as the queue can still take.
            queries = await resolveSpotifyTracks(query, MAX_QUEUE - state.queue.length);
          } catch (err) {
            const appErr = logError(err, { guildId });
            return interaction.editReply(`❌ Spotify error (ref: ${appErr.ref}). Try again in a moment, or paste a direct YouTube link instead.`);
          }

          if (!queries.length) {
            return interaction.editReply('❌ No Spotify tracks found');
          }

          for (const q of queries) {
            const primary = await loadTracks(node, `ytmsearch:${q}`);
            let picked = pickFirstTrack(primary?.data ?? primary);
            if (!picked.length) {
              const fallback = await loadTracks(node, `ytsearch:${q}`);
              picked = pickFirstTrack(fallback?.data ?? fallback);
            }
            if (picked.length) tracks.push(picked[0]);
          }
        } else {
          const isUrl = query.startsWith('http');
          if (isUrl) {
            const result = await loadTracks(node, query);
            tracks = extractTracks(result?.data ?? result);
          } else {
            // Fetch top candidates from ytmsearch: raw query + "official audio" variant in parallel
            const [primary, enhanced] = await Promise.all([
              loadTracks(node, `ytmsearch:${query}`),
              loadTracks(node, `ytmsearch:${query} official audio`)
            ]);
            const ytmCandidates = [
              ...extractTracks(primary?.data  ?? primary).slice(0, 5),
              ...extractTracks(enhanced?.data ?? enhanced).slice(0, 3)
            ];
            const { track: ytmBest, score: ytmScore } = pickBestTrack(ytmCandidates, query);

            // Low confidence — add ytsearch candidates to the pool and re-pick
            if (!ytmBest || ytmScore < 3) {
              const ytResult   = await loadTracks(node, `ytsearch:${query}`);
              const ytCandidates = extractTracks(ytResult?.data ?? ytResult).slice(0, 5);
              const combined   = [...(ytmBest ? [ytmBest] : []), ...ytCandidates];
              const { track: best } = pickBestTrack(combined, query);
              if (best) tracks = [best];
            } else {
              tracks = [ytmBest];
            }

            // Last resort: SoundCloud
            if (!tracks.length) {
              const sc = await loadTracks(node, `scsearch:${query}`);
              const scCandidates = extractTracks(sc?.data ?? sc).slice(0, 3);
              const { track: scBest } = pickBestTrack(scCandidates, query);
              if (scBest) tracks = [scBest];
            }

            // Flag livestreams that weren't explicitly requested
            if (tracks.length) {
              const info = tracks[0].info || {};
              const ql   = query.toLowerCase();
              if ((info.isStream || info.length === 0) && !ql.includes('live') && !ql.includes('stream')) {
                tracks[0]._liveWarning = true;
              }
            }
          }
        }

        if (!tracks.length) {
          return interaction.editReply('❌ No results found');
        }

        // Re-check: the queue may have filled up while we were searching.
        const available = Math.max(0, MAX_QUEUE - state.queue.length);
        if (available === 0) {
          return interaction.editReply(`❌ Queue is full (${MAX_QUEUE} tracks max). Skip or clear some tracks first.`);
        }
        const originalCount = tracks.length;
        if (tracks.length > available) {
          tracks = tracks.slice(0, available);
        }

        tracks.forEach(t => {
          t.requesterTag = interaction.user.tag;
          t.requesterId = interaction.user.id;
          state.queue.push(t);
        });

        // Idle: playNext() below posts the card for the new track.
        if (state.current) {
          await upsertController(guildId, state);
        }

        const skipped = originalCount - tracks.length;
        let replyMsg = `✅ Added **${tracks.length}** track(s)`;
        if (skipped > 0) replyMsg += ` — **${skipped}** skipped (queue full at ${MAX_QUEUE})`;
        if (tracks[0]?._liveWarning) replyMsg += `\n⚠️ This looks like a livestream — paste a direct URL for better results.`;
        await interaction.editReply(replyMsg);

        if (!state.current) {
          await playNext(guildId, interaction.client);
        }

        return;
      }

      /* ⏯️ PAUSE / RESUME */
      if (commandName === 'pause') {
        const state = getState(guildId);
        if (!await canControlPlayback(interaction, state)) return;
        state.textChannelId = interaction.channelId;
        const paused = await togglePause(guildId); // also refreshes the card
        if (paused == null) {
          return interaction.reply({
            content: '🔇 Nothing is playing',
            flags: MessageFlags.Ephemeral
          });
        }
        return interaction.reply({
          content: paused ? '⏸️ Paused' : '▶️ Resumed',
          flags: MessageFlags.Ephemeral
        });
      }

      /* ⏭️ SKIP */
      if (commandName === 'skip') {
        const state = getState(guildId);
        if (!await canControlPlayback(interaction, state)) return;
        state.textChannelId = interaction.channelId;
        if (!state.current) {
          return interaction.reply({
            content: '🔇 Nothing is playing',
            flags: MessageFlags.Ephemeral
          });
        }
        await stopTrack(guildId); // the 'stopped' end event advances + reposts the card
        return interaction.reply({
          content: '⏭️ Skipped',
          flags: MessageFlags.Ephemeral
        });
      }

      /* 📜 QUEUE */
      if (commandName === 'queue') {
        const state = getState(guildId);
        if (!await canControlPlayback(interaction, state)) return;
        state.textChannelId = interaction.channelId;
        await upsertController(guildId, state);
        const pageData = getQueuePageData(state, 1);
        const components = buildQueueComponents(guildId, pageData.page, pageData.totalPages, interaction.user.id);
        const embed = buildQueueContent(state, pageData);

        return interaction.reply({
          content: '',
          embeds: [embed],
          components,
          flags: MessageFlags.Ephemeral
        });
      }

      /* 🩺 HEALTH */
      if (commandName === 'health') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({
            content: '⛔ Admins only.',
            flags: MessageFlags.Ephemeral
          });
        }
        // DB lookup + DM can take longer than Discord's 3s window — ack first.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const state = getState(guildId);
        const meta = getStatsMeta();
        const node = pickNode(interaction.client);
        const msg = await buildHealthMessage(interaction.client, state, meta, node, interaction.user.id, guildId);
        try {
          const sent = await interaction.user.send(msg);
          if (sent) await trackDm(sent.channel.id, sent.id, 'health').catch(() => {});
          return interaction.editReply('🩺 Health report sent to your DM.');
        } catch {
          return interaction.editReply('❌ I could not DM you. Check your privacy settings.');
        }
      }

      /* 📊 STATS */
      if (commandName === 'stats') {
        await interaction.deferReply();
        // One stats card per guild: drop the previous one before posting anew.
        const old = getStatsMessage(guildId);
        if (old.messageId && old.channelId) {
          await deleteMessage(interaction.client, old.channelId, old.messageId);
          await clearStatsMessage(guildId);
        }

        // editReply resolves to the real Message. (reply()'s InteractionResponse
        // carries the interaction id, which never matched the card.)
        const message = await interaction.editReply(buildStatsChannelMessage(guildId));
        await setStatsMessage(guildId, interaction.channelId, message.id);
        setTimeout(() => {
          if (peekState(guildId)?.current) return;
          message.delete().catch(() => {});
          if (getStatsMessage(guildId).messageId === message.id) {
            clearStatsMessage(guildId).catch(() => {});
          }
        }, STATS_AUTO_DELETE_MS);
        return;
      }

      /* 📜 HISTORY */
      if (commandName === 'history') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const pageData = getHistoryPage(guildId, 1, 10);
        const embed = buildHistoryEmbed(pageData);
        const components = buildHistoryComponents(guildId, pageData.page, pageData.totalPages, interaction.user.id);
        try {
          const sent = await interaction.user.send({ embeds: [embed], components });
          if (sent) await trackDm(sent.channel.id, sent.id, 'history').catch(() => {});
          return interaction.editReply('📜 History sent to your DM.');
        } catch {
          return interaction.editReply('❌ I could not DM you. Check your privacy settings.');
        }
      }

      /* ❎ DISCONNECT */
      if (commandName === 'disconnect') {
        const state = getState(guildId);
        if (!await canControlPlayback(interaction, state)) return;
        await interaction.reply({
          content: '❎ Disconnecting…',
          flags: MessageFlags.Ephemeral
        });
        await disconnectGuild(guildId);
        return;
      }

      /* ⏹️ STOP */
      if (commandName === 'stop') {
        const state = getState(guildId);
        if (!await canControlPlayback(interaction, state)) return;
        state.textChannelId = interaction.channelId;
        await stopPlayback(guildId);
        return interaction.reply({
          content: '⏹️ Stopped playback',
          flags: MessageFlags.Ephemeral
        });
      }
    }

    /* ---------------- BUTTONS ---------------- */
    if (interaction.isButton()) {
      _label = interaction.customId;
      console.debug(`[CMD] → button ${interaction.customId} guild=${interaction.guildId} user=${interaction.user?.tag || interaction.user?.id}`);
      if (interaction.customId && interaction.customId.startsWith('dmremove:')) {
        const parts = interaction.customId.split(':');
        const userId = parts[2];
        if (userId !== interaction.user.id) {
          return interaction.reply({ content: '❌ Not your message', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferUpdate().catch(() => {});
        await interaction.message.delete().catch(() => {});
        return;
      }
      if (interaction.customId && interaction.customId.startsWith('memreset:')) {
        const parts = interaction.customId.split(':');
        const scope = parts[1];
        const guildId = parts[2];
        const userId = parts[3];
        if (userId !== interaction.user.id) {
          return interaction.reply({ content: '❌ Not your message', flags: MessageFlags.Ephemeral });
        }
        if (scope === 'history') {
          await resetGuildHistory(guildId);
        } else if (scope === 'messages') {
          await resetGuildMessages(guildId);
        } else {
          await resetGuildMemory(guildId);
          await resetGuildMessages(guildId);
        }
        await interaction.deferUpdate().catch(() => {});
        await interaction.message.delete().catch(() => {});
        return;
      }
      if (interaction.customId && interaction.customId.startsWith('announce:remove:')) {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '⛔ Admins only.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferUpdate().catch(() => {});
        await interaction.message.delete().catch(() => {});
        return;
      }
      if (interaction.customId && interaction.customId.startsWith('history:')) {
        const parts = interaction.customId.split(':');
        const action = parts[1];
        const guildId = parts[2];
        const page = parseInt(parts[3], 10) || 1;
        const userId = parts[4];
        if (userId !== interaction.user.id) {
          return interaction.reply({ content: '❌ Not your message', flags: MessageFlags.Ephemeral });
        }
        const nextPage = action === 'next' ? page + 1 : page - 1;
        const pageData = getHistoryPage(guildId, nextPage, 10);
        const embed = buildHistoryEmbed(pageData);
        const components = buildHistoryComponents(guildId, pageData.page, pageData.totalPages, userId);
        await interaction.update({ embeds: [embed], components }).catch(() => {});
        return;
      }
      if (interaction.customId && interaction.customId.startsWith('queuepage:')) {
        const parts = interaction.customId.split(':');
        const action = parts[1];
        const guildId = parts[2];
        const page = parseInt(parts[3], 10) || 1;
        const userId = parts[4];
        if (userId !== interaction.user.id) {
          return interaction.reply({ content: '❌ Not your message', flags: MessageFlags.Ephemeral });
        }
        const state = getState(guildId);
        if (!await canControlPlayback(interaction, state)) return;
        const nextPage = action === 'next' ? page + 1 : page - 1;
        const pageData = getQueuePageData(state, nextPage);
        const embed = buildQueueContent(state, pageData);
        const components = buildQueueComponents(guildId, pageData.page, pageData.totalPages, userId);
        await interaction.update({ content: '', embeds: [embed], components }).catch(() => {});
        return;
      }
      if (interaction.customId && interaction.customId.startsWith('statsremove:')) {
        const parts = interaction.customId.split(':');
        const guildId = parts[1];
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '⛔ Admins only.', flags: MessageFlags.Ephemeral });
        }
        await clearStatsMessage(guildId);
        await interaction.deferUpdate().catch(() => {});
        await interaction.message.delete().catch(() => {});
        return;
      }

      const [prefix, action, guildId] = interaction.customId.split(':');
      if (prefix !== 'music') return;

      // Only the playback-control buttons (toggle/skip/replay/stop/disconnect/
      // etc.) are gated — DM opt-out, memory reset, and pagination buttons
      // above this point aren't "using the bot" in the playback sense and
      // should keep working during maintenance.
      const maintenance = getMaintenance();
      if (maintenance.enabled) {
        _outcome = 'maintenance';
        return interaction.reply({ content: maintenance.message, flags: MessageFlags.Ephemeral });
      }

      const state = getState(guildId);
      if (!await canControlPlayback(interaction, state)) return;
      const cd = getButtonCooldownRemaining(state, interaction.user.id);
      if (cd > 0) {
        return interaction.reply({
          content: `⏳ Slow down — wait **${cd}s**`,
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (action === 'toggle') {
        state.textChannelId = interaction.channelId;
        const paused = await togglePause(guildId); // also refreshes the card
        if (paused == null) {
          return interaction.followUp({ content: '🔇 Nothing is playing', flags: MessageFlags.Ephemeral });
        }
        return interaction.followUp({
          content: paused ? '⏸️ Paused' : '▶️ Resumed',
          flags: MessageFlags.Ephemeral
        });
      }

      if (action === 'skip') {
        state.textChannelId = interaction.channelId;
        if (!state.current) {
          return interaction.followUp({ content: '🔇 Nothing is playing', flags: MessageFlags.Ephemeral });
        }
        await stopTrack(guildId); // the 'stopped' end event advances + reposts the card
        return interaction.followUp({ content: '⏭️ Skipped', flags: MessageFlags.Ephemeral });
      }

      if (action === 'clearqueue') {
        state.textChannelId = interaction.channelId;
        await clearQueue(guildId); // also refreshes the card
        return interaction.followUp({ content: '🧹 Queue cleared', flags: MessageFlags.Ephemeral });
      }

      if (action === 'queue') {
        state.textChannelId = interaction.channelId;
        await upsertController(guildId, state);
        const pageData = getQueuePageData(state, 1);
        const embed = buildQueueContent(state, pageData);
        const components = buildQueueComponents(guildId, pageData.page, pageData.totalPages, interaction.user.id);
        return interaction.editReply({
          content: '',
          embeds: [embed],
          components
        });
      }

      if (action === 'loop') {
        state.textChannelId = interaction.channelId;
        if (!state.current) {
          return interaction.followUp({ content: '🔇 Nothing is playing', flags: MessageFlags.Ephemeral });
        }
        const mode = await toggleLoopMode(guildId);
        const modeText = mode === 'track' ? '🔂 Loop: Track' : mode === 'queue' ? '🔁 Loop: Queue' : '➡️ Loop: Off';
        return interaction.followUp({ content: modeText, flags: MessageFlags.Ephemeral });
      }

      if (action === 'shuffle') {
        state.textChannelId = interaction.channelId;
        if (!state.queue.length) {
          return interaction.followUp({ content: '📭 Queue is empty', flags: MessageFlags.Ephemeral });
        }
        for (let i = state.queue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
        }
        await upsertController(guildId, state);
        return interaction.followUp({ content: '🔀 Queue shuffled', flags: MessageFlags.Ephemeral });
      }

      if (action === 'replay') {
        state.textChannelId = interaction.channelId;
        if (!state.lastPlayed?.uri && !state.lastPlayed?.title) {
          return interaction.followUp({ content: '❌ Nothing to replay', flags: MessageFlags.Ephemeral });
        }
        try { await ensurePlayer(interaction); } catch (err) {
          return interaction.followUp({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral });
        }
        const node = pickNode(interaction.client);
        if (!node) return interaction.followUp({ content: '❌ NodeLink not available', flags: MessageFlags.Ephemeral });
        const identifier = state.lastPlayed.uri || `ytsearch:${state.lastPlayed.title}`;
        const result = await loadTracks(node, identifier);
        const tracks = extractTracks(result?.data ?? result);
        const track = tracks[0];
        if (!track) return interaction.followUp({ content: '❌ Could not find that track', flags: MessageFlags.Ephemeral });
        track.requesterTag = interaction.user.tag;
        track.requesterId = interaction.user.id;
        state.queue.unshift(track);
        if (!state.current) {
          await playNext(guildId, interaction.client);
        } else {
          await upsertController(guildId, state);
        }
        return interaction.followUp({ content: '⏮️ Replaying last track!', flags: MessageFlags.Ephemeral });
      }

      if (action === 'disconnect') {
        await interaction.followUp({ content: '🔌 Disconnecting…', flags: MessageFlags.Ephemeral });
        await disconnectGuild(guildId);
        return;
      }

      if (action === 'stop') {
        await stopPlayback(guildId);
        return interaction.followUp({ content: '⏹️ Stopped playback', flags: MessageFlags.Ephemeral });
      }
    }
  } catch (err) {
    if (err instanceof UserError) {
      _outcome = 'user-error';
      try { await replyEphemeral(interaction, err.message); } catch {}
      return;
    }
    _outcome = 'error';
    const appErr = logError(err, { guildId: interaction.guildId, command: interaction.commandName || interaction.customId });
    try {
      await replyEphemeral(interaction, `❌ Something went wrong (ref: ${appErr.ref}). Try again in a moment.`);
    } catch {}
  } finally {
    if (_label) console.debug(`[CMD] ← ${_label} ${_outcome} (${Date.now() - _t0}ms)`);
    if (_announce) {
      sendAnnouncement(interaction.guild, interaction.client, interaction.channelId).catch(err => {
        console.error(`Announcement failed in guild ${interaction.guildId}:`, err);
      });
    }
  }
}

module.exports = {
  deployCommands,
  handleInteraction,
  getButtonCooldownMs,
  setButtonCooldownMs
};


