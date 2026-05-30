/************************************************************
 * DJ DIKKAT - Music Bot
 * Ui/UX Emoji Container
 * Chat UI card and button layout
 * Build 3.0.0
 * Author: Yanoee
 ************************************************************/
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

const { getInactivityRemaining, clearIdleUiTimer } = require('./state');
const { setUiMessage, getUiMessage, clearUiMessage } = require('./memory');

// guildId -> controller message
const controllers = new Map();
// guildId -> Promise (serialises concurrent upsertController calls per guild)
const upsertQueues = new Map();
const QUEUE_TITLE_LIMIT = 25;
const NOW_PLAYING_TITLE_LIMIT = 50;
const IDLE_REFRESH_MS = 30 * 1000;

const COLORS = {
  youtube:    0xFF0000,
  spotify:    0x1DB954,
  soundcloud: 0xFF5500,
  paused:     0x4a5568,
  idle:       0x2b6cb0,
  default:    0x2b6cb0
};

/**
 * Format milliseconds as H:MM:SS or M:SS
 */
function formatMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function truncateQueueTitle(title) {
  const text = (title || 'Unknown').trim();
  if (text.length <= QUEUE_TITLE_LIMIT) return text;
  return `${text.slice(0, QUEUE_TITLE_LIMIT - 1)}…`;
}

function truncateNowPlayingTitle(title) {
  const text = (title || 'Unknown title').trim();
  if (text.length <= NOW_PLAYING_TITLE_LIMIT) return text;
  return `${text.slice(0, NOW_PLAYING_TITLE_LIMIT - 3)}...`;
}

function getSourceKey(uri) {
  if (!uri) return 'default';
  try {
    const host = new URL(uri).hostname.toLowerCase();
    if (host.includes('youtube') || host.includes('youtu.be')) return 'youtube';
    if (host.includes('spotify')) return 'spotify';
    if (host.includes('soundcloud')) return 'soundcloud';
  } catch {}
  return 'default';
}

function sourceLabel(uri) {
  const key = getSourceKey(uri);
  if (key === 'youtube') return 'YouTube';
  if (key === 'spotify') return 'Spotify';
  if (key === 'soundcloud') return 'SoundCloud';
  if (!uri) return 'Unknown';
  try {
    return new URL(uri).hostname.replace(/^www\./, '');
  } catch {
    return 'Unknown';
  }
}

function getArtworkUrl(info) {
  if (info.artworkUrl) return info.artworkUrl;
  try {
    const url = new URL(info.uri || '');
    const host = url.hostname.toLowerCase();
    if (host.includes('youtube') || host.includes('youtu.be')) {
      const id = url.searchParams.get('v') || url.pathname.slice(1);
      if (id) return `https://img.youtube.com/vi/${id}/mqdefault.jpg`;
    }
  } catch {}
  return null;
}

// Split "Artist - Song Name" YouTube titles into separate fields
function parseTrackMeta(title, uri) {
  if (getSourceKey(uri) === 'youtube' && title) {
    const idx = title.indexOf(' - ');
    if (idx > 0 && idx < 40) {
      return { artist: title.slice(0, idx).trim(), trackTitle: title.slice(idx + 3).trim() };
    }
  }
  return { artist: null, trackTitle: title || 'Unknown title' };
}

/**
 * Build controller embed
 */
function buildEmbed(state) {
  // Idle state
  if (!state.current) {
    const embed = new EmbedBuilder()
      .setTitle('💤 Dakka Records')
      .setColor(COLORS.idle)
      .setDescription('**No music is playing...**\nUse `/play` to start something!');

    if (state.lastPlayed?.title) {
      const link = state.lastPlayed.uri
        ? `[${truncateNowPlayingTitle(state.lastPlayed.title)}](${state.lastPlayed.uri})`
        : truncateNowPlayingTitle(state.lastPlayed.title);
      embed.addFields({ name: '⏮️ Last played', value: link, inline: false });
    }

    const remaining = getInactivityRemaining(state);
    if (remaining) {
      embed.setFooter({ text: `⏳ Auto-disconnect in ${formatMs(remaining)}` });
    }
    return embed;
  }

  // Playing / Paused
  const info = state.current.info || {};
  const uri = info.uri || null;
  const artwork = getArtworkUrl(info);
  const { artist, trackTitle } = parseTrackMeta(info.title, uri);
  const displayTitle = truncateNowPlayingTitle(trackTitle);
  const length = info.length ? formatMs(info.length) : 'Live';
  const requester = state.current.requesterId
    ? `<@${state.current.requesterId}>`
    : (state.current.requesterTag || 'Unknown');
  const src = sourceLabel(uri);
  const loopMode = state.loopCurrent ? 'Track' : state.loopQueue ? 'Queue' : 'Off';

  const color = state.paused ? COLORS.paused : (COLORS[getSourceKey(uri)] ?? COLORS.default);
  const titleIcon = state.paused ? '⏸️' : '▶️';
  const trackLink = uri ? `[${displayTitle}](${uri})` : displayTitle;

  const embed = new EmbedBuilder()
    .setTitle(`${titleIcon} Dakka Records Sunar:`)
    .setColor(color)
    .setDescription(state.paused ? `**⏸️ PAUSED**\n${trackLink}` : `**Now Playing:**\n${trackLink}`);

  if (artwork) embed.setThumbnail(artwork);

  const fields = [
    { name: '⏱️ Length',       value: length,    inline: true },
    { name: '🙋 Requested by', value: requester,  inline: true },
  ];
  if (artist) fields.push({ name: '🎤 Artist', value: artist, inline: true });
  fields.push(
    { name: '🔁 Loop',   value: loopMode,                      inline: true },
    { name: '🌐 Source', value: src,                            inline: true },
    { name: '📜 Queue',  value: `${state.queue.length} track(s)`, inline: true }
  );
  embed.addFields(...fields);

  // Up next: top 3 only
  const nextTracks = state.queue.slice(0, 3);
  if (nextTracks.length) {
    const preview = nextTracks.map((t, i) => {
      const tInfo = t.info || {};
      const tTitle = truncateQueueTitle(tInfo.title);
      const tUri = tInfo.uri || null;
      const label = tUri ? `[${tTitle}](${tUri})` : tTitle;
      const requestedBy = t.requesterId ? `<@${t.requesterId}>` : (t.requesterTag || 'Unknown');
      return `${i + 1}. ${label} — ${requestedBy}`;
    });
    const more = state.queue.length > 3 ? `\n*(+${state.queue.length - 3} more)*` : '';
    embed.addFields({ name: '⏭️ Up next', value: preview.join('\n') + more, inline: false });
  }

  const footerText = state.queue.length > 0
    ? `${state.queue.length} track(s) remaining • ${src}`
    : `Last track • ${src}`;
  embed.setFooter({ text: footerText });

  return embed;
}

function startIdleRefresh(guildId, state) {
  if (state.idleUiTimer) return;
  state.idleUiTimer = setInterval(async () => {
    if (state.current) { clearIdleUiTimer(state); return; }
    await upsertController(guildId, state);
  }, IDLE_REFRESH_MS);
}

async function resolveControllerMessage(guildId, client, preferredChannel = null) {
  if (controllers.has(guildId)) return controllers.get(guildId);
  if (!client) return null;

  const { messageId, channelId } = getUiMessage(guildId);
  if (!messageId || !channelId) return null;

  const channel = (preferredChannel && preferredChannel.id === channelId)
    ? preferredChannel
    : (
      client.channels.cache.get(channelId)
      || await client.channels.fetch(channelId).catch(() => null)
    );

  if (!channel?.messages) {
    await clearUiMessage(guildId);
    return null;
  }

  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (!msg) {
    await clearUiMessage(guildId);
    return null;
  }

  controllers.set(guildId, msg);
  return msg;
}

function buildIdleButtons(guildId, lastPlayed) {
  if (!lastPlayed?.title) return [];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`music:replay:${guildId}`)
        .setLabel('Play Again')
        .setEmoji('⏮️')
        .setStyle(ButtonStyle.Primary)
    )
  ];
}

/**
 * Build controller buttons
 * Row 1: [⏸/▶ Pause] [⏭ Skip] [Loop: Off/Track/Queue] [⏹ Stop]
 * Row 2: [📜 Queue] [🔀 Shuffle] [🧹 Clear]
 */
function buildButtons(guildId, paused, loopCurrent, loopQueue) {
  const loopLabel = loopCurrent ? 'Loop: Track' : loopQueue ? 'Loop: Queue' : 'Loop: Off';
  const loopStyle = (loopCurrent || loopQueue) ? ButtonStyle.Success : ButtonStyle.Secondary;

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`music:toggle:${guildId}`)
        .setEmoji(paused ? '▶️' : '⏸️')
        .setStyle(paused ? ButtonStyle.Success : ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId(`music:skip:${guildId}`)
        .setEmoji('⏭️')
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId(`music:loop:${guildId}`)
        .setLabel(loopLabel)
        .setStyle(loopStyle),

      new ButtonBuilder()
        .setCustomId(`music:stop:${guildId}`)
        .setEmoji('⏹️')
        .setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`music:queue:${guildId}`)
        .setEmoji('📜')
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId(`music:shuffle:${guildId}`)
        .setEmoji('🔀')
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId(`music:clearqueue:${guildId}`)
        .setEmoji('🧹')
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

/**
 * Create or update controller message (text channel)
 * Serialised per guild to prevent duplicate cards from concurrent calls.
 */
async function upsertController(guildId, state) {
  const next = (upsertQueues.get(guildId) ?? Promise.resolve())
    .then(() => _upsertController(guildId, state))
    .catch(() => {})
    .finally(() => {
      if (upsertQueues.get(guildId) === next) upsertQueues.delete(guildId);
    });
  upsertQueues.set(guildId, next);
  return next;
}

async function _upsertController(guildId, state) {
  if (!state.player || !state.textChannelId || !state.client) return;

  const channel = state.client.channels.cache.get(state.textChannelId)
    || await state.client.channels.fetch(state.textChannelId).catch(() => null);
  if (!channel || !channel.send) return;

  const embed = buildEmbed(state);
  const components = state.current
    ? buildButtons(guildId, state.paused, state.loopCurrent, state.loopQueue)
    : buildIdleButtons(guildId, state.lastPlayed);

  if (state.current) {
    clearIdleUiTimer(state);
  } else {
    startIdleRefresh(guildId, state);
  }

  const current = await resolveControllerMessage(guildId, state.client, channel);
  if (current) {
    const edited = await current.edit({ embeds: [embed], components })
      .then(() => true)
      .catch(() => false);
    if (edited) return;

    // Edit failed — send replacement first, then delete old card
    controllers.delete(guildId);
    await clearUiMessage(guildId);
    const replacement = await channel.send({ embeds: [embed], components }).catch(() => null);
    if (replacement) {
      controllers.set(guildId, replacement);
      await setUiMessage(guildId, channel.id, replacement.id);
      await current.delete().catch(() => {});
    } else {
      controllers.set(guildId, current);
      await setUiMessage(guildId, channel.id, current.id);
    }
    return;
  }

  const msg = await channel.send({ embeds: [embed], components }).catch(() => null);
  if (msg) {
    controllers.set(guildId, msg);
    await setUiMessage(guildId, channel.id, msg.id);
  }
}

/**
 * Recreate controller message (move to bottom of channel)
 */
async function repostController(guildId, state) {
  if (!state.player || !state.textChannelId || !state.client) return;
  clearIdleUiTimer(state);

  const channel = state.client.channels.cache.get(state.textChannelId)
    || await state.client.channels.fetch(state.textChannelId).catch(() => null);
  if (!channel || !channel.send) return;

  const embed = buildEmbed(state);
  const components = buildButtons(guildId, state.paused, state.loopCurrent, state.loopQueue);

  const current = await resolveControllerMessage(guildId, state.client, channel);
  if (current) {
    await current.delete().catch(() => {});
    controllers.delete(guildId);
    await clearUiMessage(guildId);
  }

  const msg = await channel.send({ embeds: [embed], components }).catch(() => null);
  if (msg) {
    controllers.set(guildId, msg);
    await setUiMessage(guildId, channel.id, msg.id);
  }
}

/**
 * Remove controller message
 */
async function removeController(guildId, client = null) {
  const current = controllers.get(guildId) || await resolveControllerMessage(guildId, client);
  if (current) {
    await current.delete().catch(() => {});
    controllers.delete(guildId);
  }
  await clearUiMessage(guildId);
}

module.exports = {
  upsertController,
  removeController,
  repostController,
  truncateQueueTitle
};
