import { homedir } from 'os';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { Commander } from './Commander.js';
import { apiRequest } from '../utils/api.js';

const CONFIG_DIR = join(homedir(), '.openclaw', 'gtw');
const DEVICE_CODE_FILE = join(CONFIG_DIR, 'device_code.json');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');

/**
 * Device code flow for GitHub OAuth.
 * Supports device_code reuse within expires_in window to avoid rate limiting.
 */
export class LoginCommand extends Commander {
  /**
   * @param {{ api: object, config: object }} context
   */
  constructor(context) {
    super(context);
    this.api = context.api;
    this.config = context.config;
  }

  async execute(args) {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;

    if (!clientId) {
      return {
        ok: false,
        message: '⚠️ GITHUB_CLIENT_ID not configured. Please set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET environment variables.',
      };
    }

    // Check for cached device code that's still valid
    let deviceCodeData = this.loadCachedDeviceCode();
    
    if (!deviceCodeData || deviceCodeData.expires_at < Date.now()) {
      // Request new device code
      deviceCodeData = await this.requestDeviceCode(clientId);
      this.saveDeviceCode(deviceCodeData);
    } else {
      console.error('[gtw] Reusing cached device code (expires in ' + Math.round((deviceCodeData.expires_at - Date.now()) / 1000) + 's)');
    }

    // Display instructions to user
    const display = `🔐 GitHub 登录\n\n请访问：${deviceCodeData.verification_uri}\n输入验证码：${deviceCodeData.user_code}\n\n等待授权完成...`;
    console.log(display);

    // Poll for token
    const token = await this.pollForToken(clientId, clientSecret, deviceCodeData);
    
    // Save token
    this.saveToken(token);

    return {
      ok: true,
      message: '✅ 登录成功！Token 已保存到 ~/.openclaw/gtw/token.json',
      token: { source: 'oauth', saved_at: new Date().toISOString() },
    };
  }

  /**
   * Load cached device code if still valid.
   * @returns {{ device_code: string, user_code: string, verification_uri: string, expires_at: number, interval: number } | null}
   */
  loadCachedDeviceCode() {
    try {
      if (existsSync(DEVICE_CODE_FILE)) {
        const data = JSON.parse(readFileSync(DEVICE_CODE_FILE, 'utf8'));
        if (data.expires_at > Date.now()) {
          return data;
        }
      }
    } catch (e) {
      console.error('[gtw] Failed to load cached device code:', e.message);
    }
    return null;
  }

  /**
   * Save device code to cache.
   * @param {{ device_code: string, user_code: string, verification_uri: string, expires_in: number, interval: number }} data
   */
  saveDeviceCode(data) {
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      const toSave = {
        device_code: data.device_code,
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        expires_at: Date.now() + (data.expires_in || 900) * 1000,
        interval: data.interval || 5,
      };
      writeFileSync(DEVICE_CODE_FILE, JSON.stringify(toSave, null, 2), 'utf8');
    } catch (e) {
      console.error('[gtw] Failed to save device code:', e.message);
    }
  }

  /**
   * Request a new device code from GitHub.
   * @param {string} clientId
   * @returns {Promise<{ device_code: string, user_code: string, verification_uri: string, expires_in: number, interval: number }>}
   */
  async requestDeviceCode(clientId) {
    const url = 'https://github.com/login/device/code';
    const body = new URLSearchParams({
      client_id: clientId,
      scope: 'repo workflow',
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'github-work-skill/1.0',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new Error(`Failed to request device code: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    return {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri || data.verification_url,
      expires_in: data.expires_in || 900,
      interval: data.interval || 5,
    };
  }

  /**
   * Poll GitHub for token until user authorizes or timeout.
   * @param {string} clientId
   * @param {string} clientSecret
   * @param {{ device_code: string, interval: number, expires_at: number }} deviceCodeData
   * @returns {Promise<string>}
   */
  async pollForToken(clientId, clientSecret, deviceCodeData) {
    const url = 'https://github.com/login/oauth/access_token';
    const interval = (deviceCodeData.interval || 5) * 1000;
    const maxAttempts = Math.max(1, Math.floor((deviceCodeData.expires_at - Date.now()) / interval));

    console.error(`[gtw] Polling for token (max ${maxAttempts} attempts, ${interval/1000}s interval)`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, interval));

      const body = new URLSearchParams({
        client_id: clientId,
        device_code: deviceCodeData.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });

      // Add client_secret if available (required for some OAuth apps)
      if (clientSecret) {
        body.append('client_secret', clientSecret);
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'User-Agent': 'github-work-skill/1.0',
        },
        body: body.toString(),
      });

      const data = await res.json();

      if (data.access_token) {
        console.error('[gtw] Token received!');
        return data.access_token;
      }

      if (data.error === 'authorization_pending') {
        process.stdout.write('.');
        continue;
      }

      if (data.error === 'slow_down') {
        console.error('[gtw] Rate limited, waiting longer...');
        await new Promise(resolve => setTimeout(resolve, interval));
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

    throw new Error('Device code expired. Please run /gtw login again.');
  }

  /**
   * Save token to token.json.
   * @param {string} token
   */
  saveToken(token) {
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      const toSave = {
        source: 'oauth',
        access_token: token,
        created_at: new Date().toISOString(),
      };
      writeFileSync(TOKEN_FILE, JSON.stringify(toSave, null, 2), 'utf8');
      console.error('[gtw] Token saved to', TOKEN_FILE);
    } catch (e) {
      console.error('[gtw] Failed to save token:', e.message);
    }
  }
}
