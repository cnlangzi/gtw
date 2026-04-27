import https from 'https';
import { exists, read, makeDir, write } from './fs.js';
import { dirname } from 'path';
import { GitHubClient } from './github.js';
import { TOKEN_FILE } from './config.js';

export function readJSON(file) {
  try {
    return exists(file) ? JSON.parse(read(file, 'utf8')) : null;
  } catch (e) {
    return null;
  }
}

export function writeJSON(file, data) {
  makeDir(dirname(file), { recursive: true });
  write(file, JSON.stringify(data, null, 2), 'utf8');
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
