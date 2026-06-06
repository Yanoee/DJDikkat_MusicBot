/************************************************************
 * DJ DIKKAT - Maintenance Mode
 * File-backed maintenance state — persists across restarts
 ************************************************************/
const fs   = require('fs');
const path = require('path');
const fsp  = fs.promises;

const DATA_DIR = path.join(__dirname, 'data');
const FILE     = path.join(DATA_DIR, 'maintenance.json');

const DEFAULT_MESSAGE = '🔧 DJ DIKKAT is currently under maintenance. We\'ll be back shortly!';

let state = {
  enabled: false,
  message: DEFAULT_MESSAGE
};

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (parsed && typeof parsed.enabled === 'boolean') {
        state = { ...state, ...parsed };
      }
    }
  } catch {}
}

async function save() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('[MAINTENANCE] Failed to save state:', err.message);
  }
}

function getState() {
  return { ...state };
}

async function enable(message) {
  state.enabled = true;
  state.message = (message && message.trim()) ? message.trim() : DEFAULT_MESSAGE;
  await save();
}

async function disable() {
  state.enabled = false;
  await save();
}

// Load persisted state immediately on module init
load();

module.exports = { getState, enable, disable, DEFAULT_MESSAGE };
