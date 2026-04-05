/**
 * GitHub API Client
 * Encapsulates GitHub API calls including OAuth device flow.
 * Uses GitHub CLI's official OAuth app credentials.
 * 
 * GitHub CLI OAuth App:
 * - Client ID: 178c6fc778ccc68e1d6a
 * - Reference: https://github.com/cli/cli
 * 
 * References:
 * - Device flow: https://docs.github.com/en/developers/apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 */

import https from 'https';

// GitHub CLI's official OAuth app
export const GITHUB_CLIENT_ID = '178c6fc778ccc68e1d6a';
export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_API_BASE = 'https://api.github.com';

// Request timeout in milliseconds
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Make an HTTPS request to GitHub API
 * @param {string} method - HTTP method
 * @param {string} url - Full URL
 * @param {object} headers - Request headers
 * @param {string|null} body - Request body (for POST)
 * @returns {Promise<object>} - Parsed JSON response
 */
export function httpsRequest(method, url, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'gtw/1.0',
        ...headers,
      },
    };

    if (body) {
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          reject(new Error(`Parse error (${res.statusCode}): ${data.substring(0, 200)}`));
        }
      });
    });

    // Timeout handling
    req.on('error', (err) => {
      if (err.message.includes('ETIMEDOUT') || err.message.includes('ECONNREFUSED') || err.message.includes('TIMEOUT')) {
        reject(new Error(`Request timeout: ${err.message}`));
      } else {
        reject(err);
      }
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`));
    });

    if (body) req.write(body);
    req.end();
  });
}

/**
 * GitHub API Client class
 */
export class GitHubClient {
  /**
   * Create a GitHub client
   * @param {string|null} token - Optional GitHub token
   */
  constructor(token = null) {
    this.token = token;
  }

  /**
   * Set the authentication token
   * @param {string} token - GitHub token
   */
  setToken(token) {
    this.token = token;
  }

  /**
   * Make an authenticated API request to GitHub
   * @param {string} method - HTTP method
   * @param {string} endpoint - API endpoint (e.g., '/user')
   * @param {object|null} body - Request body
   * @returns {Promise<object>} - API response
   */
  async request(method, endpoint, body = null) {
    if (!this.token) {
      throw new Error('No token set. Call setToken() or login() first.');
    }

    const url = `${GITHUB_API_BASE}${endpoint}`;
    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };

    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
    }

    const { status, data } = await httpsRequest(method, url, headers, bodyStr);
    
    if (status >= 200 && status < 300) {
      return data;
    } else {
      throw new Error(`GitHub API ${status}: ${JSON.stringify(data)}`);
    }
  }

  /**
   * Get current user info
   * @returns {Promise<{login: string, name: string|null, id: number}>}
   */
  async getCurrentUser() {
    return await this.request('GET', '/user');
  }

  /**
   * Validate the current token
   * @returns {Promise<boolean>} - True if token is valid
   */
  async validateToken() {
    try {
      await this.getCurrentUser();
      return true;
    } catch (e) {
      if (e.message.includes('401')) {
        return false;
      }
      throw e;
    }
  }

  /**
   * Request a device code for OAuth device flow
   * @returns {Promise<{
   *   device_code: string,
   *   user_code: string,
   *   verification_uri: string,
   *   expires_in: number,
   *   interval: number
   * }>}
   */
  async requestDeviceCode() {
    const body = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      scope: 'repo workflow',
    });

    const { status, data } = await httpsRequest(
      'POST',
      GITHUB_DEVICE_CODE_URL,
      {},
      body.toString()
    );

    if (status !== 200) {
      throw new Error(`Failed to request device code: ${status} ${JSON.stringify(data)}`);
    }

    return {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri || data.verification_url,
      expires_in: data.expires_in || 900,
      interval: data.interval || 5,
    };
  }

  /**
   * Poll for OAuth token using device code
   * @param {string} device_code - Device code from requestDeviceCode()
   * @param {number} interval - Polling interval in seconds
   * @param {number} expiresAt - Expiration timestamp in ms
   * @returns {Promise<string>} - OAuth access token
   */
  async pollForToken(device_code, interval, expiresAt) {
    const intervalMs = interval * 1000;
    const maxAttempts = Math.max(1, Math.floor((expiresAt - Date.now()) / intervalMs));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Wait for interval
      await new Promise(resolve => setTimeout(resolve, intervalMs));

      const body = new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });

      const { status, data } = await httpsRequest(
        'POST',
        GITHUB_TOKEN_URL,
        {},
        body.toString()
      );

      if (data.access_token) {
        return data.access_token;
      }

      if (data.error === 'authorization_pending') {
        // User hasn't authorized yet - continue polling
        process.stderr.write('.');
        continue;
      }

      if (data.error === 'slow_down') {
        // GitHub is rate limiting - wait longer
        await new Promise(resolve => setTimeout(resolve, intervalMs));
        continue;
      }

      if (data.error === 'expired_token') {
        throw new Error('Device code expired. Please try again.');
      }

      if (data.error === 'access_denied') {
        throw new Error('Authorization denied by user.');
      }

      throw new Error(`OAuth error: ${data.error}`);
    }

    throw new Error('Device code expired. Please run login again.');
  }

  /**
   * Perform OAuth device flow login
   * @returns {Promise<{token: string, user: object}>}
   */
  async loginWithDeviceFlow() {
    // Step 1: Request device code
    const deviceCode = await this.requestDeviceCode();
    
    // Step 2: Display instructions
    console.log('\n🔐 GitHub OAuth Login\n');
    console.log(`1. Visit: ${deviceCode.verification_uri}`);
    console.log(`2. Enter code: ${deviceCode.user_code}\n`);
    console.log('Waiting for authorization...');

    // Step 3: Poll for token
    const expiresAt = Date.now() + (deviceCode.expires_in * 1000);
    const token = await this.pollForToken(
      deviceCode.device_code,
      deviceCode.interval,
      expiresAt
    );

    // Step 4: Get user info
    this.setToken(token);
    const user = await this.getCurrentUser();

    return {
      token,
      user: {
        login: user.login,
        name: user.name,
        id: user.id,
      },
    };
  }
}
