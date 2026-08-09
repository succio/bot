const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'users.json');

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
      console.log(`Loaded ${users.size} users from disk.`);
    }
  } catch (err) {
    console.error('Failed to load users from disk:', err.message);
  }
}

function save() {
  try {
    const arr = Array.from(users.values());
    fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save users to disk:', err.message);
  }
}

// Debounced save — batches rapid successive writes into one disk write
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
}

load();

module.exports = { users, save, scheduleSave };
