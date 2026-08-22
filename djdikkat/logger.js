/************************************************************
 * DJ DIKKAT - Music Bot
 * Logger
 * Timestamped console output — patches global console
 * Writes to stdout (journalctl) and a rotating log file
 * Build 4.0.0
 * Author: Yanoee
 ************************************************************/
const util = require('util');
const fs   = require('fs');
const path = require('path');

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
        try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch {}
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
