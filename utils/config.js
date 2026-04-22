import { join } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { readJSON, writeJSON } from './api.js';

/**
 * Config directory: GTW_CONFIG_DIR env var if set, otherwise ~/.gtw/
 * Tests set GTW_CONFIG_DIR to an isolated directory to avoid conflicts.
 */
const BASE_DIR = process.env.GTW_CONFIG_DIR || join(homedir(), '.gtw');
const CONFIG_FILE = join(BASE_DIR, 'config.json');
const WIP_FILE = join(BASE_DIR, 'wip.json');
const TOKEN_FILE = join(BASE_DIR, 'token.json');
const POLLING_STATE_FILE = join(BASE_DIR, 'polling_state.json');

export { BASE_DIR, CONFIG_FILE, WIP_FILE, TOKEN_FILE, POLLING_STATE_FILE };

/** Override hook for testing — mirrors httpsRequest/setHttpsRequest pattern */
let _getConfigOverride = null;
let _saveConfigOverride = null;

export function setConfigOverride(getter, setter) {
  _getConfigOverride = getter;
  _saveConfigOverride = setter;
}

export function getConfig() {
  if (_getConfigOverride) return _getConfigOverride();
  return readJSON(CONFIG_FILE) || {};
}

export function saveConfig(c) {
  if (_saveConfigOverride) return _saveConfigOverride(c);
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
 * Timeout in seconds for LLM API calls.
 * Priority: GTW_LLM_TIMEOUT_SECONDS env var > config.llmTimeoutSeconds > 60.
 */
export function getLLMTimeoutSeconds() {
  const envVal = process.env.GTW_LLM_TIMEOUT_SECONDS;
  if (envVal !== undefined) {
    const n = parseInt(envVal, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  const c = getConfig();
  if (c.llmTimeoutSeconds !== undefined) {
    const n = parseInt(c.llmTimeoutSeconds, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return 60;
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
