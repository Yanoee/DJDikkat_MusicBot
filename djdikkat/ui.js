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
const { setUiMessage, clearUiMessage } = require('./memory');

// guildId -> controller message
const controllers = new Map();
const IDLE_REFRESH_MS = 15000;

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
    const tTitle = tInfo.title || 'Unknown';
    const tUri = tInfo.uri || null;
    const label = tUri ? `[${tTitle}](${tUri})` : tTitle;
    return `${i + 1}. ${label}`;
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

  if (controllers.has(guildId)) {
    const current = controllers.get(guildId);
    const edited = await current.edit({ embeds: [embed], components })
      .then(() => true)
      .catch(() => false);
    if (edited) return;
    controllers.delete(guildId);
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

  if (controllers.has(guildId)) {
    await controllers.get(guildId).delete().catch(() => {});
    controllers.delete(guildId);
  }

  const msg = await channel.send({ embeds: [embed], components });
  controllers.set(guildId, msg);
  await setUiMessage(guildId, channel.id, msg.id);
}

/**
 * Remove controller message
 */
async function removeController(guildId) {
  if (!controllers.has(guildId)) return;
  await controllers.get(guildId).delete().catch(() => {});
  controllers.delete(guildId);
  await clearUiMessage(guildId);
}

module.exports = {
  upsertController,
  removeController,
  repostController
};
