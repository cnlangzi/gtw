import { join } from 'path';
import { homedir } from 'os';
import { readJSON, writeJSON } from './api.js';

/**
 * Config directory: GTW_CONFIG_DIR env var if set, otherwise ~/.openclaw/gtw/
 * Tests set GTW_CONFIG_DIR to an isolated directory to avoid conflicts.
 */
const BASE_DIR = process.env.GTW_CONFIG_DIR || join(homedir(), '.openclaw', 'gtw');
const CONFIG_FILE = join(BASE_DIR, 'config.json');
const WIP_FILE = join(BASE_DIR, 'wip.json');

export { CONFIG_FILE, WIP_FILE };

export function getConfig() {
  return readJSON(CONFIG_FILE) || {};
}

export function saveConfig(c) {
  writeJSON(CONFIG_FILE, c);
}
