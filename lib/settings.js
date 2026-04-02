const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  notionToken: '',
  notionPageId: '',
  notionDatabaseId: '', // auto-created
  notionSyncEnabled: false,
};

class Settings {
  constructor(settingsPath) {
    this.path = settingsPath;
    this.data = { ...DEFAULTS };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.path)) {
        const raw = fs.readFileSync(this.path, 'utf-8');
        this.data = { ...DEFAULTS, ...JSON.parse(raw) };
      }
    } catch (e) {
      this.data = { ...DEFAULTS };
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to save settings:', e.message);
    }
  }

  get(key) { return this.data[key]; }

  set(key, value) {
    this.data[key] = value;
    this._save();
  }

  getAll() { return { ...this.data }; }

  update(updates) {
    Object.assign(this.data, updates);
    this._save();
  }
}

module.exports = Settings;
