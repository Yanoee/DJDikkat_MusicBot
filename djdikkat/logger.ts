/************************************************************
 * DJ DIKKAT - Music Bot
 * Logger
 * Timestamped console output — patches global console
 * Writes to stdout and a zip-archived, per-run rotating log file
 * Build 5.1.0
 * Author: Yanoee
 ************************************************************/
import { inspect } from 'node:util';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Client } from 'discord.js';

// Only apply ANSI colors when attached to a real terminal.
const TTY = Boolean(process.stdout.isTTY);
const C = TTY
  ? { reset: '\x1b[0m', gray: '\x1b[90m', red: '\x1b[31m', yellow: '\x1b[33m', magenta: '\x1b[35m' }
  : { reset: '', gray: '', red: '', yellow: '', magenta: '' };

const _log   = console.log.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);
const _debug = console.debug.bind(console);

// ── Log level ─────────────────────────────────────────────────
// quiet   = errors/warnings only
// normal  = + routine info logs (default)
// verbose = + console.debug() diagnostics from specific subsystems
const LOG_LEVELS = ['quiet', 'normal', 'verbose'] as const;
type LogLevel = typeof LOG_LEVELS[number];
let LOG_LEVEL: LogLevel = 'normal';

export function getLogLevel(): LogLevel { return LOG_LEVEL; }
export function setLogLevel(level: unknown): LogLevel {
  if (LOG_LEVELS.includes(level as LogLevel)) LOG_LEVEL = level as LogLevel;
  return LOG_LEVEL;
}

// ── File output ───────────────────────────────────────────────
const LOG_FILE = process.env.BOT_LOG_FILE || join(import.meta.dirname, 'data', 'bot.log');
const LOG_MAX  = 20 * 1024 * 1024; // 20 MB before rotation
const ANSI_RE  = /\x1b\[[0-9;]*m/g;
let _logStream: fs.WriteStream | null = null;
let _writeCount = 0;

function writeFile(line: string): void {
  if (!_logStream) {
    try {
      fs.mkdirSync(dirname(LOG_FILE), { recursive: true });
      _logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
      _logStream.on('error', () => { _logStream = null; });
    } catch { return; }
  }
  _logStream.write(line.replace(ANSI_RE, '') + '\n');
  if (++_writeCount % 100 === 0) {
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX) {
        _logStream.end();
        _logStream = null;
        archiveNow(); // same zip-archive path as a restart
      }
    } catch {}
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

function ts(): string {
  const d = new Date();
  return `${C.gray}[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]${C.reset}`;
}

function fmt(...args: unknown[]): string {
  return args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'string') return a;
    return inspect(a, { depth: 3, colors: TTY });
  }).join(' ');
}

// Patch console — each call writes to stdout AND the log file.
// warn/error always fire; log/debug are level-gated.
console.log = (...a: unknown[]) => {
  if (LOG_LEVEL === 'quiet') return;
  const l = `${ts()} ${fmt(...a)}`; _log(l); writeFile(l);
};
console.warn  = (...a: unknown[]) => { const l = `${ts()} ${C.yellow}${fmt(...a)}${C.reset}`; _warn(l);  writeFile(l); };
console.error = (...a: unknown[]) => { const l = `${ts()} ${C.red}${fmt(...a)}${C.reset}`;    _error(l); writeFile(l); };
console.debug = (...a: unknown[]) => {
  if (LOG_LEVEL !== 'verbose') return;
  const l = `${ts()} ${C.magenta}🔍 ${fmt(...a)}${C.reset}`; _debug(l); writeFile(l);
};

// ── Archive previous run on startup ─────────────────────────────
// Runs once at module load (before anything writes a log line) so every
// process start gets a clean bot.log, while the previous run is kept as its
// own zipped file — whatever triggered the restart (panel, crash, systemctl).
const ARCHIVE_DIR  = join(dirname(LOG_FILE), 'logs');
const ARCHIVE_KEEP = 30;

function stamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function pruneArchive(): void {
  try {
    const files = fs.readdirSync(ARCHIVE_DIR)
      .filter(f => f.startsWith('bot-') && (f.endsWith('.log') || f.endsWith('.log.zip')))
      .map(f => ({ f, t: fs.statSync(join(ARCHIVE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(ARCHIVE_KEEP)) fs.unlinkSync(join(ARCHIVE_DIR, f));
  } catch {}
}

// The single way a log file ever leaves: renamed into logs/ and zipped.
// `zip -jm` deletes the source only on success, so a missing zip binary
// leaves the plain .log archived instead of losing it.
function archiveNow(): void {
  try {
    if (!fs.existsSync(LOG_FILE) || fs.statSync(LOG_FILE).size === 0) return;
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const archived = join(ARCHIVE_DIR, `bot-${stamp()}.log`);
    fs.renameSync(LOG_FILE, archived);
    try { execFileSync('zip', ['-jmq', `${archived}.zip`, archived], { stdio: 'ignore' }); } catch {}
    pruneArchive();
  } catch {}
}
archiveNow();

/**
 * Truncates bot.log in place (safe with the append-mode stream open —
 * writes seek to EOF), so the stream never has to be reopened.
 */
export function clearLogFile(): boolean {
  try {
    if (fs.existsSync(LOG_FILE)) fs.truncateSync(LOG_FILE, 0);
    _writeCount = 0;
    return true;
  } catch (err) {
    _error(`Failed to clear log file: ${(err as Error).message}`);
    return false;
  }
}

// ── Heartbeat ─────────────────────────────────────────────────
export function startHeartbeat(client: Client, getActiveVoiceCount: () => number): void {
  setInterval(() => {
    const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const s   = Math.floor(process.uptime());
    const up  = s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`;
    const line = `${ts()} 💓 ${getActiveVoiceCount()} playing  •  ${client.guilds.cache.size} guilds  •  ${mem}MB  •  up ${up}`;
    _log(line);
    writeFile(line);
  }, 10 * 60 * 1000);
}
