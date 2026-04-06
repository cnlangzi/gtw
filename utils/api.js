import https from 'https';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { GitHubClient } from './github.js';

export const CONFIG_DIR = join(homedir(), '.openclaw', 'gtw');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');

function ensureDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function readJSON(file) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  } catch (e) {
    return null;
  }
}

export function writeJSON(file, data) {
  ensureDir();
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/**
/**
 * Get a valid GitHub token from token.json cache (PAT or OAuth).
 * Returns immediately without pre-validation.
 * @returns {Promise<string>}
 */
export async function getValidToken() {
  const cached = readJSON(TOKEN_FILE);
  if (cached?.access_token) {
    return cached.access_token;
  }
  throw new Error('Not authenticated. Run /gtw login');
}

/**
 * Validate a GitHub token by making a lightweight API call.
 * @param {string} token - Token to validate
 * @returns {Promise<boolean>} - True if token is valid
 */
export async function validateToken(token) {
  const client = new GitHubClient(token);
  return await client.validateToken();
}
