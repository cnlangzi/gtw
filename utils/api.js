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
 * Get a valid GitHub token with the following priority:
 * 1. GITHUB_TOKEN environment variable (PAT)
 * 2. token.json cache (PAT or OAuth)
 * 
 * @param {string} envToken - Optional GITHUB_TOKEN from environment
 * @returns {Promise<string>} - Valid GitHub token
 */
export async function getValidToken(envToken) {
  // Priority 1: Environment variable (PAT)
  if (envToken) {
    console.log('[gtw] Using GITHUB_TOKEN from environment');
    return envToken;
  }

  // Priority 2: token.json cache
  const cached = readJSON(TOKEN_FILE);
  if (cached?.access_token) {
    // Validate cached token before using
    const isValid = await validateToken(cached.access_token);
    if (isValid) {
      console.log(`[gtw] Using cached token from token.json (source: ${cached.source || 'unknown'})`);
      return cached.access_token;
    }
    console.log('[gtw] Cached token invalid');
  }

  throw new Error('Not authenticated. Run /gtw login or set GITHUB_TOKEN environment variable');
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
