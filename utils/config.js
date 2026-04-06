import { join } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { readJSON, writeJSON } from './api.js';

/**
 * Config directory: GTW_CONFIG_DIR env var if set, otherwise ~/.openclaw/gtw/
 * Tests set GTW_CONFIG_DIR to an isolated directory to avoid conflicts.
 */
const BASE_DIR = process.env.GTW_CONFIG_DIR || join(homedir(), '.openclaw', 'gtw');
const CONFIG_FILE = join(BASE_DIR, 'config.json');
const WIP_FILE = join(BASE_DIR, 'wip.json');

export { BASE_DIR, CONFIG_FILE, WIP_FILE };

export function getConfig() {
  return readJSON(CONFIG_FILE) || {};
}

export function saveConfig(c) {
  // Ensure directory exists
  mkdirSync(BASE_DIR, { recursive: true });
  writeJSON(CONFIG_FILE, c);
}

/**
 * Get a single config key.
 * @param {string} key
 * @returns {string|null}
 */
export function getConfigKey(key) {
  const c = getConfig();
  return c[key] ?? null;
}

/**
 * Set a single config key.
 * @param {string} key
 * @param {string} value
 */
export function setConfigKey(key, value) {
  const c = getConfig();
  c[key] = value;
  saveConfig(c);
}

/**
 * Delete a config key.
 * @param {string} key
 * @returns {boolean} true if key existed
 */
export function deleteConfigKey(key) {
  const c = getConfig();
  if (!(key in c)) return false;
  delete c[key];
  saveConfig(c);
  return true;
}

/**
 * List all config key-value pairs.
 * @returns {{ key: string, value: string }[]}
 */
export function listConfig() {
  const c = getConfig();
  return Object.entries(c).map(([key, value]) => ({ key, value: String(value) }));
}

function getLangLabel(lang) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(lang) || lang;
  } catch {
    return lang;
  }
}

export { getLangLabel };
