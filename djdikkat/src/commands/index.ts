/************************************************************
 * DJ DIKKAT - Music Bot
 * Command registry
 * Every slash command, by name, plus the Discord deploy.
 * Author: Yanoee
 ************************************************************/
import type { Client } from 'discord.js';
import { play } from './play.ts';
import { pause, skip, stop, disconnect, queue } from './controls.ts';
import { history, health, stats } from './info.ts';
import { language } from './language.ts';
import { panel } from './panel.ts';
import type { Command } from './shared.ts';

const commands: Command[] = [play, pause, skip, queue, health, stats, history, disconnect, stop, language, panel];

export const commandsByName = new Map(commands.map(c => [c.data.name, c]));

export async function deployCommands(client: Client<true>): Promise<void> {
  await client.application.commands.set(commands.map(c => c.data.toJSON()));
  console.log('✅ Slash commands deployed');
}
