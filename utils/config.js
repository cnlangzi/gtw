import { join } from 'path';
import { homedir } from 'os';
import { readJSON, writeJSON } from './api.js';

const CONFIG_FILE = join(homedir(), '.openclaw', 'gtw', 'config.json');

export function getConfig() {
  return readJSON(CONFIG_FILE) || {};
}

export function saveConfig(c) {
  writeJSON(CONFIG_FILE, c);
}
