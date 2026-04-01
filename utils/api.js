import https from 'https';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.openclaw', 'gtw');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');

function ensureDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function apiRequest(method, endpoint, token, body = null) {
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com${endpoint}`;
    const urlObj = new URL(url);
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'github-work-skill/1.0',
      },
    };
    if (bodyStr) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(`GitHub API ${res.statusCode}: ${JSON.stringify(parsed)}`));
        } catch (e) {
          reject(new Error(`Parse error (${res.statusCode}): ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

export function getGhToken() {
  try {
    return execSync('gh auth token', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    throw new Error('Not authenticated with gh CLI. Run: gh auth login');
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
 * 3. gh CLI token (validated)
 * 
 * @param {string} envToken - Optional GITHUB_TOKEN from environment
 * @returns {Promise<string>} - Valid GitHub token
 */
export async function getValidToken(envToken) {
  // Priority 1: Environment variable (PAT)
  if (envToken) {
    console.error('[gtw] Using GITHUB_TOKEN from environment');
    return envToken;
  }

  // Priority 2: token.json cache
  const cached = readJSON(TOKEN_FILE);
  if (cached?.access_token) {
    // Validate cached token before using
    const isValid = await validateToken(cached.access_token);
    if (isValid) {
      console.error(`[gtw] Using cached token from token.json (source: ${cached.source || 'unknown'})`);
      return cached.access_token;
    }
    console.error('[gtw] Cached token invalid, attempting refresh');
  }

  // Priority 3: gh CLI token
  try {
    const ghToken = getGhToken();
    const isValid = await validateToken(ghToken);
    if (isValid) {
      writeJSON(TOKEN_FILE, { source: 'gh', access_token: ghToken, cached_at: Date.now() });
      console.error('[gtw] Using gh CLI token (validated and cached)');
      return ghToken;
    }
    throw new Error('gh CLI token is invalid or revoked');
  } catch (e) {
    throw new Error('Not authenticated. Run: gh auth login or set GITHUB_TOKEN environment variable');
  }
}

/**
 * Validate a GitHub token by making a lightweight API call.
 * @param {string} token - Token to validate
 * @returns {Promise<boolean>} - True if token is valid
 */
export async function validateToken(token) {
  try {
    await apiRequest('GET', '/user', token);
    return true;
  } catch (e) {
    // 401 means invalid/expired token
    if (e.message.includes('401')) {
      return false;
    }
    // Other errors (network, etc.) - assume token might be valid
    console.error('[gtw] Token validation error:', e.message);
    return true;
  }
}
