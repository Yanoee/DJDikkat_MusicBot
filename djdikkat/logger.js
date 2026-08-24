/************************************************************
 * DJ DIKKAT - Music Bot
 * Logger
 * Timestamped console output — patches global console
 * Writes to stdout and a zip-archived, per-run rotating log file
 * Build 4.0.0
 * Author: Yanoee
 ************************************************************/
const util = require('util');
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Only apply ANSI colors when attached to a real terminal.
const TTY = Boolean(process.stdout.isTTY);

const C = TTY ? {
  reset:  '\x1b[0m',
  gray:   '\x1b[90m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  magenta:'\x1b[35m',
} : { reset: '', gray: '', red: '', yellow: '', magenta: '' };

const _log   = console.log.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);
const _debug = console.debug ? console.debug.bind(console) : _log;

// ── Log level ─────────────────────────────────────────────────
// quiet   = errors/warnings only
// normal  = + routine info logs (default, current behavior)
// verbose = + detailed console.debug() diagnostics from specific subsystems
let LOG_LEVEL = 'normal';
const LOG_LEVELS = new Set(['quiet', 'normal', 'verbose']);

function getLogLevel() { return LOG_LEVEL; }
function setLogLevel(level) {
  if (LOG_LEVELS.has(level)) LOG_LEVEL = level;
  return LOG_LEVEL;
}

// ── File output ───────────────────────────────────────────────
const LOG_FILE    = process.env.BOT_LOG_FILE || path.join(__dirname, 'data', 'bot.log');
const LOG_MAX     = 20 * 1024 * 1024; // 20 MB before rotation
const ANSI_RE     = /\x1b\[[0-9;]*m/g;
let   _logStream  = null;
let   _writeCount = 0;

function openStream() {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    _logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    _logStream.on('error', () => { _logStream = null; });
  } catch { _logStream = null; }
}

function writeFile(line) {
  if (!_logStream) openStream();
  if (!_logStream) return;
  _logStream.write(line.replace(ANSI_RE, '') + '\n');
  if (++_writeCount % 100 === 0) {
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX) {
        _logStream.end(); _logStream = null;
        archiveNow(); // same zip-archive path as a restart, not a throwaway .1
      }
    } catch {}
  }
}

// ── Timestamp ─────────────────────────────────────────────────
function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${C.gray}[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]${C.reset}`;
}

function fmt(...args) {
  return args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'string') return a;
    return util.inspect(a, { depth: 3, colors: TTY });
  }).join(' ');
}

// Patch console methods — each writes to stdout AND the log file.
// warn/error always fire regardless of level; log/debug are level-gated.
console.log   = (...a) => {
  if (LOG_LEVEL === 'quiet') return;
  const l = `${ts()} ${fmt(...a)}`; _log(l); writeFile(l);
};
console.warn  = (...a) => { const l = `${ts()} ${C.yellow}${fmt(...a)}${C.reset}`;   _warn(l);  writeFile(l); };
console.error = (...a) => { const l = `${ts()} ${C.red}${fmt(...a)}${C.reset}`;      _error(l); writeFile(l); };
console.debug = (...a) => {
  if (LOG_LEVEL !== 'verbose') return;
  const l = `${ts()} ${C.magenta}🔍 ${fmt(...a)}${C.reset}`; _debug(l); writeFile(l);
};

// ── Archive previous run on startup ─────────────────────────────
// Runs once at module load (before anything writes a log line) so every
// process start gets a clean bot.log with a hard boundary at the top, while
// the previous run's content is preserved as its own file instead of lost —
// works no matter what triggered the restart (panel, crash, manual systemctl).
const ARCHIVE_DIR = path.join(path.dirname(LOG_FILE), 'logs');
const ARCHIVE_KEEP = 30;

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function pruneArchive() {
  try {
    const files = fs.readdirSync(ARCHIVE_DIR)
      .filter(f => f.startsWith('bot-') && (f.endsWith('.log') || f.endsWith('.log.zip')))
      .map(f => ({ f, t: fs.statSync(path.join(ARCHIVE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(ARCHIVE_KEEP)) fs.unlinkSync(path.join(ARCHIVE_DIR, f));
  } catch {}
}

// `zip -jm` compresses in place and deletes the source only on success, so a
// missing/failing `zip` binary just leaves the plain .log archived instead of
// losing it — degrades safely rather than throwing.
function zipInPlace(logPath) {
  try {
    execFileSync('zip', ['-jmq', `${logPath}.zip`, logPath], { stdio: 'ignore' });
  } catch {}
}

// Shared by both the startup rotation and the mid-run 20MB size trigger, so
// there's exactly one path a log file ever leaves through — archived and
// zipped, tracked by the Log Archives panel — instead of two (this one, plus
// the old throwaway .1 rename that bypassed archiving entirely).
function archiveNow(sourceFile = LOG_FILE) {
  try {
    if (!fs.existsSync(sourceFile) || fs.statSync(sourceFile).size === 0) return;
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const archived = path.join(ARCHIVE_DIR, `bot-${stamp()}.log`);
    fs.renameSync(sourceFile, archived);
    zipInPlace(archived);
    pruneArchive();
  } catch {}
}

function rotateOnStartup() {
  archiveNow();
  // One-time migration: a leftover bot.log.1 from before this fix used to be
  // silently deleted here with no archiving at all. Archive it properly
  // instead so nothing already on disk gets lost.
  const staleBackup = `${LOG_FILE}.1`;
  if (fs.existsSync(staleBackup)) archiveNow(staleBackup);
}
rotateOnStartup();

// ── Clear log file ────────────────────────────────────────────
// Truncates in place (safe even with _logStream open in append mode —
// writes seek to EOF on each call) so the bot never has to reopen the stream.
function clearLogFile() {
  try {
    if (fs.existsSync(LOG_FILE)) fs.truncateSync(LOG_FILE, 0);
    const rotated = `${LOG_FILE}.1`;
    if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
    _writeCount = 0;
    return true;
  } catch (err) {
    _error(`Failed to clear log file: ${err.message}`);
    return false;
  }
}

// ── Heartbeat ─────────────────────────────────────────────────
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function startHeartbeat(client, getActiveVoiceCount) {
  setInterval(() => {
    const mem    = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const uptime = formatUptime(process.uptime() * 1000);
    const guilds = client.guilds?.cache?.size ?? '?';
    const active = getActiveVoiceCount();
    const line   = `${ts()} 💓 ${active} playing  •  ${guilds} guilds  •  ${mem}MB  •  up ${uptime}`;
    _log(line);
    writeFile(line);
  }, 10 * 60 * 1000);
}

module.exports = { startHeartbeat, clearLogFile, getLogLevel, setLogLevel };
