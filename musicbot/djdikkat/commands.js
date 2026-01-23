/************************************************************
 * DJ DIKKAT - Music Bot
 * Command router
 * Slash commands and button interactions
 * Build 2.0.3.15
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
  checkCooldown
} = require('./state');

const {
  upsertController,
  repostController
} = require('./ui');

const {
  loadTracks,
  pickNode,
  ensurePlayer,
  playNext,
  togglePause,
  stopTrack,
  stopPlayback,
  clearQueue,
  disconnectGuild
} = require('./player');

const { getStatsMeta } = require('./stats');
const { buildStatsEmbed } = require('./stats_ui');
const { buildHealthMessage } = require('./health');
const { getHistoryPage, setGuildSettings, resetGuildMemory, resetGuildHistory, setStatsMessage, getStatsMessage, clearStatsMessage } = require('./memory');
const { isSpotifyUrl, resolveSpotifyTracks } = require('./spotify');

const BUTTON_COOLDOWN_MS = 5000;

function getButtonCooldownRemaining(state, userId) {
  const now = Date.now();
  const until = state.buttonCooldowns.get(userId) || 0;
  if (until > now) return Math.ceil((until - now) / 1000);
  state.buttonCooldowns.set(userId, now + BUTTON_COOLDOWN_MS);
  return 0;
}

function buildHistoryEmbed(guildId, pageData) {
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
    .setDescription('🎵 Play music (search / URL / Spotify)')
    .addStringOption(o =>
      o.setName('query')
        .setDescription('Search text or URL')
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
    .setDescription('❎ Disconnect bot')
    ,

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('⏹️ Stop playback (stay in voice)')
].map(c => c.toJSON());

// ================= DEPLOY =================

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

// ================= INTERACTION HANDLER =================

async function handleInteraction(interaction) {
  try {
    /* ---------------- SLASH COMMANDS ---------------- */
    if (interaction.isChatInputCommand()) {
      const { guildId, commandName } = interaction;

      const cd = checkCooldown(guildId);
      if (cd > 0) {
        return interaction.reply({
          content: `⏳ Slow down — wait **${cd}s**`,
          flags: MessageFlags.Ephemeral
        });
      }

      setGuildSettings(guildId, {
        defaultTextChannelId: interaction.channelId,
        lastCommandTime: new Date().toISOString()
      });

      /* 🎵 PLAY */
      if (commandName === 'play') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const query = interaction.options.getString('query', true);
        const state = getState(guildId);
        state.textChannelId = interaction.channelId;

        await ensurePlayer(interaction);

        const node = pickNode(interaction.client);
        if (!node) {
          return interaction.followUp('❌ Lavalink not available');
        }

        let tracks = [];

        if (isSpotifyUrl(query)) {
          let queries = [];
          try {
            queries = await resolveSpotifyTracks(query, 25);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return interaction.followUp(`❌ Spotify error: ${msg}`);
          }

          if (!queries.length) {
            return interaction.followUp('❌ No Spotify tracks found');
          }

          for (const q of queries) {
            const result = await loadTracks(node, `ytsearch:${q}`);
            const data = result?.data ?? result;
            let found = null;
            if (Array.isArray(data)) {
              found = data[0] || null;
            } else if (data?.tracks && Array.isArray(data.tracks)) {
              found = data.tracks[0] || null;
            } else if (data?.encoded) {
              found = data;
            }
            if (found) tracks.push(found);
          }
        } else {
          const identifier = query.startsWith('http')
            ? query
            : `ytsearch:${query}`;

          const result = await loadTracks(node, identifier);
          const data = result?.data ?? result;

          if (Array.isArray(data)) {
            tracks = data;
          } else if (data?.tracks && Array.isArray(data.tracks)) {
            tracks = data.tracks;
          } else if (data?.encoded) {
            tracks = [data];
          }
        }

        if (!tracks.length) {
          return interaction.followUp('❌ No results found');
        }

        tracks.forEach(t => {
          t.requesterTag = interaction.user.tag;
          t.requesterId = interaction.user.id;
          state.queue.push(t);
        });

        await repostController(guildId, state);

        await interaction.followUp(
          `✅ Added **${tracks.length}** track(s)`
        );

        if (!state.current) {
          await playNext(guildId, interaction.client);
        }

        return;
      }

      /* ⏯️ PAUSE / RESUME */
      if (commandName === 'pause') {
        const state = getState(guildId);
        state.textChannelId = interaction.channelId;
        const paused = await togglePause(guildId);
        if (paused == null) {
          return interaction.reply({
            content: '🔇 Nothing is playing',
            flags: MessageFlags.Ephemeral
          });
        }
        await upsertController(guildId, state);
        return interaction.reply({
          content: paused ? '⏸️ Paused' : '▶️ Resumed',
          flags: MessageFlags.Ephemeral
        });
      }

      /* ⏭️ SKIP */
      if (commandName === 'skip') {
        const state = getState(guildId);
        state.textChannelId = interaction.channelId;
        if (!state.current) {
          return interaction.reply({
            content: '🔇 Nothing is playing',
            flags: MessageFlags.Ephemeral
          });
        }
        await stopTrack(guildId);
        await upsertController(guildId, state);
        return interaction.reply({
          content: '⏭️ Skipped',
          flags: MessageFlags.Ephemeral
        });
      }

      /* 📜 QUEUE */
      if (commandName === 'queue') {
        const state = getState(guildId);
        state.textChannelId = interaction.channelId;
        await upsertController(guildId, state);

        const now = state.current
          ? `🎶 **Now Playing:** ${state.current.info.title}`
          : '🎶 **Now Playing:** Nothing playing';

        const list = state.queue.length
          ? state.queue
              .slice(0, 10)
              .map((t, i) => `${i + 1}. ${t.info.title}`)
              .join('\n')
          : '—';

        return interaction.reply({
          content: `${now}\n\n📜 **Up next:**\n${list}`,
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
        const state = getState(guildId);
        const meta = getStatsMeta();
        const node = pickNode(interaction.client);
        const msg = buildHealthMessage(interaction.client, state, meta, node, interaction.user.id, guildId);
        try {
          await interaction.user.send(msg);
          return interaction.reply({ content: '🩺 Health report sent to your DM.', flags: MessageFlags.Ephemeral });
        } catch {
          return interaction.reply({ content: '❌ I could not DM you. Check your privacy settings.', flags: MessageFlags.Ephemeral });
        }
      }

      /* 📊 STATS */
      if (commandName === 'stats') {
        const { messageId, channelId } = getStatsMessage(guildId);
        if (messageId && channelId) {
          const channel = interaction.channelId === channelId
            ? interaction.channel
            : await interaction.client.channels.fetch(channelId).catch(() => null);
          if (channel?.messages) {
            const oldMsg = await channel.messages.fetch(messageId).catch(() => null);
            if (oldMsg) {
              await oldMsg.delete().catch(() => {});
            } else {
              clearStatsMessage(guildId);
            }
          } else {
            clearStatsMessage(guildId);
          }
        }

        const embed = buildStatsEmbed();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`statsremove:${guildId}`)
            .setLabel('Remove')
            .setEmoji('🗑️')
            .setStyle(ButtonStyle.Secondary)
        );
        const msg = await interaction.reply({ embeds: [embed], components: [row] });
        const message = msg?.id ? msg : await interaction.fetchReply();
        setStatsMessage(guildId, interaction.channelId, message.id);
        return;
      }

      /* 📜 HISTORY */
      if (commandName === 'history') {
        const pageData = getHistoryPage(guildId, 1, 10);
        const embed = buildHistoryEmbed(guildId, pageData);
        const components = buildHistoryComponents(guildId, pageData.page, pageData.totalPages, interaction.user.id);
        try {
          await interaction.user.send({ embeds: [embed], components });
          return interaction.reply({ content: '📜 History sent to your DM.', flags: MessageFlags.Ephemeral });
        } catch {
          return interaction.reply({ content: '❌ I could not DM you. Check your privacy settings.', flags: MessageFlags.Ephemeral });
        }
      }

      /* ❎ DISCONNECT */
      if (commandName === 'disconnect') {
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
          resetGuildHistory(guildId);
        } else {
          resetGuildMemory(guildId);
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
        const embed = buildHistoryEmbed(guildId, pageData);
        const components = buildHistoryComponents(guildId, pageData.page, pageData.totalPages, userId);
        await interaction.update({ embeds: [embed], components }).catch(() => {});
        return;
      }
      if (interaction.customId && interaction.customId.startsWith('statsremove:')) {
        const parts = interaction.customId.split(':');
        const guildId = parts[1];
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '⛔ Admins only.', flags: MessageFlags.Ephemeral });
        }
        clearStatsMessage(guildId);
        await interaction.deferUpdate().catch(() => {});
        await interaction.message.delete().catch(() => {});
        return;
      }

      const [prefix, action, guildId] = interaction.customId.split(':');
      if (prefix !== 'music') return;

      const state = getState(guildId);
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
        const paused = await togglePause(guildId);
        if (paused == null) {
          return interaction.followUp({ content: '🔇 Nothing is playing', flags: MessageFlags.Ephemeral });
        }
        await upsertController(guildId, state);
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
        await stopTrack(guildId);
        await upsertController(guildId, state);
        return interaction.followUp({ content: '⏭️ Skipped', flags: MessageFlags.Ephemeral });
      }

      if (action === 'clearqueue') {
        state.textChannelId = interaction.channelId;
        await clearQueue(guildId);
        await upsertController(guildId, state);
        return interaction.followUp({ content: '🧹 Queue cleared', flags: MessageFlags.Ephemeral });
      }

      if (action === 'queue') {
        state.textChannelId = interaction.channelId;
        await upsertController(guildId, state);

        const now = state.current
          ? `🎶 **Now Playing:** ${state.current.info.title}`
          : '🎶 **Now Playing:** Nothing playing';

        const list = state.queue.length
          ? state.queue
              .slice(0, 10)
              .map((t, i) => `${i + 1}. ${t.info.title}`)
              .join('\n')
          : '—';

        return interaction.followUp({
          content: `${now}\n\n📜 **Up next:**\n${list}`,
          flags: MessageFlags.Ephemeral
        });
      }

      if (action === 'stop') {
        await stopPlayback(guildId);
        return interaction.followUp({ content: '⏹️ Stopped playback', flags: MessageFlags.Ephemeral });
      }
    }
  } catch (err) {
    console.error('❌ Command error:', err);
    const message = err instanceof Error ? err.message : 'Something went wrong';
    try {
      await replyEphemeral(interaction, message);
    } catch {}
  }
}

module.exports = {
  deployCommands,
  handleInteraction
};
