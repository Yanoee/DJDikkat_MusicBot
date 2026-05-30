/************************************************************
 * DJ DIKKAT - Music Bot
 * Logger
 * Timestamped console output — patches global console
 * Build 1.1.0
 * Author: Yanoee
 ************************************************************/
const util = require('util');

// Only apply ANSI colors when attached to a real terminal.
// Under systemd the process has no TTY, so codes would appear as raw text
// in journalctl and the admin panel SSE stream.
const TTY = Boolean(process.stdout.isTTY);

const C = TTY ? {
  reset:  '\x1b[0m',
  gray:   '\x1b[90m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
} : { reset: '', gray: '', red: '', yellow: '' };

const _log   = console.log.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);

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

console.log   = (...a) => _log(`${ts()} ${fmt(...a)}`);
console.warn  = (...a) => _warn(`${ts()} ${C.yellow}${fmt(...a)}${C.reset}`);
console.error = (...a) => _error(`${ts()} ${C.red}${fmt(...a)}${C.reset}`);

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
    _log(`${ts()} 💓 ${active} playing  •  ${guilds} guilds  •  ${mem}MB  •  up ${uptime}`);
  }, 10 * 60 * 1000);
}

module.exports = { startHeartbeat };
