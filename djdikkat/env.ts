/************************************************************
 * DJ DIKKAT - Music Bot
 * Environment
 * Loads djdikkat/.env. Import this FIRST: ES module imports are
 * evaluated in order, and other modules read process.env at load.
 * Existing variables win (so `DISCORD_TOKEN=x node …` still works).
 * Build 5.1.0
 * Author: Yanoee
 ************************************************************/
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ENV_FILE = join(import.meta.dirname, '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
