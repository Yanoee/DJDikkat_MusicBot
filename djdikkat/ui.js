/************************************************************
 * DJ DIKKAT - Music Bot
 * Ui/UX Emoji Container
 * Chat UI card and button layout
 * Build 2.0.7
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
const IDLE_REFRESH_MS = 15000;
const QUEUE_TITLE_LIMIT = 60;

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

/**
 * Build controller embed
 */
function buildEmbed(state) {
  const embed = new EmbedBuilder()
    .setTitle('🎶 Dakka Records Sunar:')
    .setColor(0x2b6cb0)

  // Nothing playing
  if (!state.current) {
    embed.setDescription('**No music is playing...** 💤💤\nTo play a music use /play !');
    const remaining = getInactivityRemaining(state);
    if (remaining) {
      embed.setFooter({
        text: `⏳ Auto-disconnect in ${formatMs(remaining)}`
      });
    }

    return embed;
  }

  // Playing / Paused
  const info = state.current.info || {};
  const title = info.title || 'Unknown title';
  const uri = info.uri || null;
  const length = info.length ? formatMs(info.length) : 'Live';
  const requester = state.current.requesterId
    ? `<@${state.current.requesterId}>`
    : (state.current.requesterTag || 'Unknown');
  const status = state.paused ? 'Paused' : 'Playing';

  const queuePreview = state.queue.slice(0, 5).map((t, i) => {
    const tInfo = t.info || {};
    const tTitle = truncateQueueTitle(tInfo.title);
    const tUri = tInfo.uri || null;
    const label = tUri ? `[${tTitle}](${tUri})` : tTitle;
    const requestedBy = t.requesterId
      ? `<@${t.requesterId}>`
      : (t.requesterTag || 'Unknown');
    return `${i + 1}. ${label} || ${requestedBy}`;
  });

  embed.setDescription(
    uri ? `**Now Playing:** [${title}](${uri})` : `**Now Playing:** ${title}`
  );

  embed.addFields(
    { name: '⏱️ Length', value: length, inline: true },
    { name: '🙋 Requested by', value: requester, inline: true },
    { name: '📜 Queue', value: `${state.queue.length} track(s)`, inline: true },
    { name: '📊 Status', value: status, inline: true }
  );

  if (queuePreview.length) {
    embed.addFields({ name: '⏭️ Up next', value: queuePreview.join('\n'), inline: false });
  }

  return embed;
}

function startIdleRefresh(guildId, state) {
  if (state.idleUiTimer) return;
  state.idleUiTimer = setInterval(async () => {
    if (state.current) {
      clearIdleUiTimer(state);
      return;
    }
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

/**
 * Build controller buttons
 */
function buildButtons(guildId, paused) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`music:stop:${guildId}`)
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId(`music:skip:${guildId}`)
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId(`music:toggle:${guildId}`)
      .setEmoji(paused ? '▶️' : '⏸️')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(`music:queue:${guildId}`)
      .setEmoji('📜')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(`music:clearqueue:${guildId}`)
      .setEmoji('🧹')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Create or update controller message (text channel)
 */
async function upsertController(guildId, state) {
  if (!state.player || !state.textChannelId || !state.client) return;

  const channel = state.client.channels.cache.get(state.textChannelId)
    || await state.client.channels.fetch(state.textChannelId).catch(() => null);
  if (!channel || !channel.send) return;

  const embed = buildEmbed(state);
  const components = [buildButtons(guildId, state.paused)];

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
 * Recreate controller message (move to bottom)
 */
async function repostController(guildId, state) {
  if (!state.player || !state.textChannelId || !state.client) return;

  const channel = state.client.channels.cache.get(state.textChannelId)
    || await state.client.channels.fetch(state.textChannelId).catch(() => null);
  if (!channel || !channel.send) return;

  const embed = buildEmbed(state);
  const components = [buildButtons(guildId, state.paused)];

  const current = await resolveControllerMessage(guildId, state.client, channel);
  if (current) {
    await current.delete().catch(() => {});
    controllers.delete(guildId);
    await clearUiMessage(guildId);
  }

  const msg = await channel.send({ embeds: [embed], components });
  controllers.set(guildId, msg);
  await setUiMessage(guildId, channel.id, msg.id);
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
  repostController
};
