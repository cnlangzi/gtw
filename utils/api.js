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

export async function getValidToken(envToken) {
  if (envToken) return envToken;
  try {
    const token = getGhToken();
    writeJSON(TOKEN_FILE, { source: 'gh', access_token: token, cached_at: Date.now() });
    return token;
  } catch (e) {
    const t = readJSON(TOKEN_FILE);
    if (!t?.access_token) throw new Error('Not authenticated. Run: gh auth login');
    return t.access_token;
  }
}
