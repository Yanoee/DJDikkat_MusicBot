/************************************************************
 * DJ DIKKAT - Music Bot
 * InteractionCreate
 * Routes autocomplete, slash commands and buttons; owns the
 * maintenance + cooldown gates and the [CMD] log lines.
 * Author: Yanoee
 ************************************************************/
import type { Interaction } from 'discord.js';
import { commandsByName } from '../commands/index.ts';
import { ephemeral, say, userLocale } from '../commands/shared.ts';
import { handleButton } from '../components/buttons.ts';
import { checkCooldown } from '../music/state.ts';
import { setGuildSettings } from '../services/memory.ts';
import { maintenanceBlocks, maintenanceMessage } from '../services/config-store.ts';
import { sendAnnouncement } from '../services/announcement.ts';
import { PERM_KEYS, denial } from '../services/access.ts';
import { buildSetupCard } from '../ui/setup-card.ts';
import { buildLaunchPost } from '../ui/launch-card.ts';
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
  if (interaction.isStringSelectMenu() && /^(setup|launch):lang:/.test(interaction.customId)) {
    // Setup card / launch post language picker: redraw the card in place (works in DMs too).
    const [kind, , guildId = ''] = interaction.customId.split(':');
    const guild = interaction.client.guilds.cache.get(guildId);
    const locale = interaction.values[0];
    if (guild && isLocale(locale)) {
      const removeFor = interaction.inGuild() ? undefined : interaction.user.id;
      const card = kind === 'launch' ? await buildLaunchPost(guild, locale) : buildSetupCard(guild, locale, removeFor);
      await interaction.update(card).catch(err => console.debug(`[CARD] redraw failed: ${errMsg(err)}`));
    } else {
      await interaction.deferUpdate().catch(() => {});
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
