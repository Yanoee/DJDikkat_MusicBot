/************************************************************
 * DJ DIKKAT - Music Bot
 * InteractionCreate
 * Routes autocomplete, slash commands and buttons; owns the
 * maintenance + cooldown gates and the [CMD] log lines.
 * Author: Yanoee
 ************************************************************/
import { MessageFlags } from 'discord.js';
import type { Interaction } from 'discord.js';
import { commandsByName } from '../commands/index.ts';
import { canControlPlayback, ephemeral, say, userLocale } from '../commands/shared.ts';
import { filterCooldown, setFilter } from '../music/player.ts';
import { isFilter } from '../music/filters.ts';
import { handleButton } from '../components/buttons.ts';
import { checkCooldown } from '../music/state.ts';
import { setGuildSettings } from '../services/memory.ts';
import { maintenanceBlocks, maintenanceMessage } from '../services/config-store.ts';
import { sendAnnouncement } from '../services/announcement.ts';
import { PERM_KEYS, denial } from '../services/access.ts';
import { addToPlaylist } from '../services/playlists.ts';
import { getState } from '../music/state.ts';
import { t } from '../i18n/index.ts';
import { buildSetupCard } from '../ui/setup-card.ts';
import { buildLaunchPost } from '../ui/launch-card.ts';
import { buildDjNotice, djServers } from '../services/dj-mode.ts';
import { buildUpdatePost } from '../services/update-post.ts';
import { isLocale } from '../i18n/index.ts';
import { UserError, logError, errMsg } from '../lib/errors.ts';
import { requestId, withRequestId } from '../lib/trace.ts';

export function handleInteraction(interaction: Interaction): Promise<void> {
  return withRequestId(requestId(), () => route(interaction));
}

async function route(interaction: Interaction): Promise<void> {
  if (interaction.isAutocomplete()) {
    const command = commandsByName.get(interaction.commandName);
    await command?.autocomplete?.(interaction).catch(err => console.debug(`[SUGGEST] failed: ${errMsg(err)}`));
    return;
  }
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('djmode:lang:')) {
    // DJ notice language picker (DM): redraw it for the same servers.
    const locale = interaction.values[0];
    // The message's link buttons, in order: they hold the one-time panel switch-on links.
    const urls: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      const o = node as { url?: unknown; components?: unknown };
      if (typeof o.url === 'string') urls.push(o.url);
      walk(o.components);
    };
    walk(interaction.message.components.map(c => c.toJSON()));
    const servers = djServers(interaction.client, interaction.customId.slice('djmode:lang:'.length).split(','), urls);
    if (servers.length && isLocale(locale)) await interaction.update(buildDjNotice(servers, locale)).catch(err => console.debug(`[CARD] redraw failed: ${errMsg(err)}`));
    else await interaction.deferUpdate().catch(() => {});
    return;
  }
  if (interaction.isStringSelectMenu() && /^(setup|launch|update):lang:/.test(interaction.customId)) {
    // Setup card / launch / update post language picker: redraw the card in place (works in DMs too).
    const [kind, , guildId = ''] = interaction.customId.split(':');
    const guild = interaction.client.guilds.cache.get(guildId);
    const locale = interaction.values[0];
    if (guild && isLocale(locale)) {
      const removeFor = interaction.inGuild() ? undefined : interaction.user.id;
      const card = kind === 'launch' ? await buildLaunchPost(guild, locale)
        : kind === 'update' ? await buildUpdatePost(guild, locale) : buildSetupCard(guild, locale, removeFor);
      await interaction.update(card).catch(err => console.debug(`[CARD] redraw failed: ${errMsg(err)}`));
    } else {
      await interaction.deferUpdate().catch(() => {});
    }
    return;
  }
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('pladd:') && interaction.inCachedGuild()) {
    // Queue view's "Add to playlist" picker: the song playing now goes into the chosen playlist.
    const locale = userLocale(interaction);
    const denied = denial(interaction.member, 'playlist', null);
    const current = getState(interaction.guildId).current;
    const name = interaction.component.options.find(o => o.value === interaction.values[0])?.label ?? '';
    let text: string;
    if (denied) text = t(locale, denied.key, denied.vars);
    else if (!current) text = t(locale, 'common.nothing_playing');
    else {
      const result = await addToPlaylist(interaction.guildId, Number(interaction.values[0]), interaction.user.id, current).catch(() => 'missing' as const);
      text = t(locale, `playlist.${result}`, { name, max: 200 });
    }
    await interaction.update({ content: text, components: [] }).catch(err => console.debug(`[PLAYLIST] picker update failed: ${errMsg(err)}`));
    return;
  }
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('fx:') && interaction.inCachedGuild()) {
    // Player card's effect picker: same rules as /filter.
    const locale = userLocale(interaction);
    if (maintenanceBlocks(interaction.user.id, interaction.guildId)) return void await interaction.reply(ephemeral(maintenanceMessage(locale))).catch(() => {});
    const denied = denial(interaction.member, 'filter', null);
    if (denied) return void await say(interaction, denied.key, denied.vars).catch(() => {});
    const state = getState(interaction.guildId);
    if (!await canControlPlayback(interaction, state)) return;
    if (!state.player || !state.current) return void await say(interaction, 'common.nothing_playing').catch(() => {});
    const wait = filterCooldown(interaction.guildId);
    if (wait) return void await say(interaction, 'common.slow_down', { seconds: wait }).catch(() => {});
    const value = interaction.values[0];
    state.textChannelId = interaction.channelId;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await setFilter(interaction.guildId, isFilter(value) ? value : null);   // also redraws the card
      await say(interaction, isFilter(value) ? 'fx.set' : 'fx.cleared', isFilter(value) ? { name: t(locale, `fx.${value}`) } : undefined);
    } catch (err) {
      logError(err, { guildId: interaction.guildId, during: 'card effect picker' });
    }
    return;
  }
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
      await say(interaction, 'common.guild_only');
      return;
    }
    if (maintenanceBlocks(interaction.user.id, interaction.guildId)) {
      outcome = 'maintenance';
      await interaction.reply(ephemeral(maintenanceMessage(userLocale(interaction))));
      return;
    }
    const permKey = PERM_KEYS.find(k => k === interaction.commandName);
    const denied = permKey && denial(interaction.member, permKey, interaction.channelId);
    if (denied) {
      outcome = 'denied';
      await say(interaction, denied.key, denied.vars);
      return;
    }
    const cd = checkCooldown(interaction.guildId);
    if (cd > 0) {
      await say(interaction, 'common.slow_down', { seconds: cd });
      return;
    }
    setGuildSettings(interaction.guildId, { defaultTextChannelId: interaction.channelId, lastCommandTime: new Date().toISOString() });
    // The weekly announcement goes out after the command is handled (see
    // finally) so it never eats into Discord's 3s acknowledgement window.
    announce = true;
    await commandsByName.get(interaction.commandName)?.execute(interaction);
  } catch (err) {
    if (err instanceof UserError) {
      outcome = 'user-error';
      await say(interaction, err.key, err.vars).catch(() => {});
      return;
    }
    outcome = 'error';
    const appErr = logError(err, { guildId: interaction.guildId, command: label });
    await say(interaction, 'common.error_ref', { ref: appErr.ref }).catch(() => {});
  } finally {
    // Normal level on purpose: ops/scripts/watch-snapshot.sh reads outcomes + latency from it.
    console.log(`[CMD] ← ${label} ${outcome} (${Date.now() - t0}ms)`);
    if (announce) {
      sendAnnouncement(interaction.guild, interaction.channelId).catch(err =>
        console.error(`Announcement failed in guild ${interaction.guildId}:`, err));
    }
  }
}
