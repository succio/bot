const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const RAILWAY_VOLUME_DIR = '/data';

function resolveDataFile() {
  if (process.env.USERS_DATA_FILE) {
    return path.resolve(process.env.USERS_DATA_FILE);
  }

  if (process.env.USERS_DATA_DIR) {
    return path.join(path.resolve(process.env.USERS_DATA_DIR), 'users.json');
  }

  if (process.env.RAILWAY_ENVIRONMENT && fs.existsSync(RAILWAY_VOLUME_DIR)) {
    return path.join(RAILWAY_VOLUME_DIR, 'users.json');
  }

  return path.join(DEFAULT_DATA_DIR, 'users.json');
}

const DATA_FILE = resolveDataFile();

const users = new Map();

let saveTimer = null;

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const arr = JSON.parse(raw);
      for (const u of arr) {
        users.set(u.email, u);
      }
      console.log(`Loaded ${users.size} users from ${DATA_FILE}.`);
    } else {
      console.log(`No existing user store found at ${DATA_FILE}. Starting fresh.`);
    }
  } catch (err) {
    console.error('Failed to load users from disk:', err.message);
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const arr = Array.from(users.values());
    const tmpFile = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(arr, null, 2), 'utf8');
    fs.renameSync(tmpFile, DATA_FILE);
  } catch (err) {
    console.error('Failed to save users to disk:', err.message);
  }
}

// Debounced save — batches rapid successive writes into one disk write
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  save();
}

load();

module.exports = { users, save, scheduleSave, flushSave, DATA_FILE };
