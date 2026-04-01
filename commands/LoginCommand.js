import { homedir } from 'os';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { Commander } from './Commander.js';
import { GitHubClient, httpsRequest, GITHUB_CLIENT_ID, GITHUB_TOKEN_URL } from '../utils/github.js';

const CONFIG_DIR = join(homedir(), '.openclaw', 'gtw');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');

/**
 * Login command - supports OAuth device flow with async polling:
 * - /gtw login: Returns device code immediately, polls in background
 * - /gtw login --pat <token>: PAT login
 * 
 * No --check needed - async poll completes and notifies user via session message.
 */
export class LoginCommand extends Commander {
  /**
   * @param {{ api: object, config: object }} context
   */
  constructor(context) {
    super(context);
    this.api = context.api;
    this.config = context.config;
    this.sessionKey = context.sessionKey;
    this.injectMessage = context.injectMessage;
  }

  async execute(args) {
    // Check for --pat flag
    const usePat = args.includes('--pat') || args.includes('-p');
    
    if (usePat) {
      return await this.loginWithPat(args);
    }

    // Default: OAuth device flow with async polling
    return await this.startOAuthFlow();
  }

  /**
   * Login using Personal Access Token (PAT)
   * Usage: /gtw login --pat [token]
   */
  async loginWithPat(args) {
    const client = new GitHubClient();
    
    // Extract PAT from args if provided
    const patIndex = args.findIndex(arg => arg === '--pat' || arg === '-p');
    let providedToken = null;
    if (patIndex !== -1 && args[patIndex + 1] && !args[patIndex + 1].startsWith('-')) {
      providedToken = args[patIndex + 1].trim();
    }
    
    // Priority 1: Use provided token from command line
    if (providedToken) {
      console.log('验证提供的 Token 中...');
      client.setToken(providedToken);
      const isValid = await client.validateToken();
      if (isValid) {
        this.saveToken({
          source: 'pat',
          access_token: providedToken,
          cached_at: Date.now(),
        });
        const user = await client.getCurrentUser();
        return {
          ok: true,
          message: '✅ 登录成功！PAT 已验证并缓存',
          user: { login: user.login, name: user.name, id: user.id },
          token: { source: 'pat', cached_at: Date.now() },
          display: this.createLoginSuccessDisplay(user),
        };
      } else {
        return {
          ok: false,
          message: '❌ Token 无效，请检查是否正确以及具有 repo 和 workflow 权限',
        };
      }
    }
    
    // Priority 2: Use GITHUB_TOKEN environment variable
    const envToken = process.env.GITHUB_TOKEN;
    
    if (envToken) {
      console.log('检测到 GITHUB_TOKEN 环境变量，验证中...');
      client.setToken(envToken);
      const isValid = await client.validateToken();
      if (isValid) {
        this.saveToken({
          source: 'pat',
          access_token: envToken,
          cached_at: Date.now(),
        });
        const user = await client.getCurrentUser();
        return {
          ok: true,
          message: '✅ 登录成功！PAT (GITHUB_TOKEN) 已验证并缓存',
          user: { login: user.login, name: user.name, id: user.id },
          token: { source: 'pat', cached_at: Date.now() },
          display: this.createLoginSuccessDisplay(user),
        };
      } else {
        return {
          ok: false,
          message: '❌ GITHUB_TOKEN 无效',
        };
      }
    }
    
    // Priority 3: No token provided - show usage
    return {
      ok: false,
      message: `❌ 未提供 PAT

用法:
  /gtw login --pat <your_token>      # 直接提供 Token
  export GITHUB_TOKEN=xxx            # 或使用环境变量
  /gtw login                         # 或使用 OAuth 设备码登录

生成 Token: https://github.com/settings/tokens (需要 repo 和 workflow 权限)`,
    };
  }

  /**
   * Start OAuth device flow, return device code immediately,
   * and start async polling in background
   */
  async startOAuthFlow() {
    const client = new GitHubClient();
    
    try {
      console.log('开始 GitHub OAuth 设备码认证...\n');
      
      // Step 1: Request device code
      const deviceCode = await client.requestDeviceCode();
      
      // Step 2: Save device code state for background polling
      this.saveDeviceCodeState(deviceCode);
      
      // Step 3: Return instructions to user IMMEDIATELY (non-blocking)
      const display = this.createDeviceCodeDisplay(deviceCode);
      
      // Step 4: Start async polling in background (fire-and-forget)
      // This will notify user via injectMessage when complete
      this.startBackgroundPolling(deviceCode);
      
      return {
        ok: true,
        message: '已启动 GitHub 授权流程',
        display: display,
      };
    } catch (e) {
      return {
        ok: false,
        message: `❌ 获取设备码失败：${e.message}`,
      };
    }
  }

  /**
   * Start background polling for OAuth token
   * Fires and forgets - will inject message to session when complete
   */
  async startBackgroundPolling(deviceCode) {
    // Use setImmediate to avoid blocking the response
    setImmediate(async () => {
      const expiresAt = Date.now() + (deviceCode.expires_in * 1000);
      const interval = deviceCode.interval * 1000;
      
      console.log('[gtw] Background polling started...');
      
      while (Date.now() < expiresAt) {
        await new Promise(resolve => setTimeout(resolve, interval));
        
        try {
          const body = new URLSearchParams({
            client_id: GITHUB_CLIENT_ID,
            device_code: deviceCode.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          });

          const { data } = await httpsRequest(
            'POST',
            GITHUB_TOKEN_URL,
            {},
            body.toString()
          );

          if (data.access_token) {
            // Success!
            const client = new GitHubClient(data.access_token);
            const user = await client.getCurrentUser();
            
            // Cache token
            this.saveToken({
              source: 'oauth',
              access_token: data.access_token,
              cached_at: Date.now(),
            });
            
            // Clear device code state
            this.clearDeviceCodeState();
            
            // Notify user via session message
            const successDisplay = this.createLoginSuccessDisplay(user);
            this.injectMessage?.(this.sessionKey, successDisplay);
            
            console.log('[gtw] Login successful, notified user');
            return;
          }

          if (data.error === 'authorization_pending') {
            process.stderr.write('.');
            continue;
          }

          if (data.error === 'slow_down') {
            await new Promise(resolve => setTimeout(resolve, interval));
            continue;
          }

          if (data.error === 'expired_token') {
            this.clearDeviceCodeState();
            this.injectMessage?.(this.sessionKey, 
              '❌ **授权已超时**\n\n设备码有效期为 15 分钟，已过期。\n\n请重新运行：/gtw login');
            console.log('[gtw] Device code expired');
            return;
          }

          if (data.error === 'access_denied') {
            this.clearDeviceCodeState();
            this.injectMessage?.(this.sessionKey,
              '❌ **授权已被取消**\n\n如需重新授权，请运行：/gtw login');
            console.log('[gtw] Authorization denied');
            return;
          }

          // Other errors
          this.injectMessage?.(this.sessionKey,
            `❌ **认证失败**\n\n错误：${data.error}\n\n请重试：/gtw login`);
          console.log('[gtw] OAuth error:', data.error);
          return;
          
        } catch (e) {
          // Network errors - retry
          console.error('[gtw] Polling network error, retrying:', e.message);
        }
      }
      
      // Timeout
      this.clearDeviceCodeState();
      this.injectMessage?.(this.sessionKey,
        '❌ **授权已超时**\n\n设备码有效期为 15 分钟。\n\n请重新运行：/gtw login');
      console.log('[gtw] Polling timeout');
    });
  }

  /**
   * Poll for token with progress indication
   */
  async pollWithProgress(deviceCode, interval, expiresAt) {
    while (Date.now() < expiresAt) {
      await new Promise(resolve => setTimeout(resolve, interval * 1000));
      
      try {
        const body = new URLSearchParams({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode,
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
          // Still waiting - show progress
          process.stderr.write('.');
          continue;
        }

        if (data.error === 'slow_down') {
          await new Promise(resolve => setTimeout(resolve, interval * 1000));
          continue;
        }

        if (data.error === 'expired_token') {
          throw new Error('Device code expired');
        }

        if (data.error === 'access_denied') {
          throw new Error('Authorization denied');
        }

        throw new Error(`OAuth error: ${data.error}`);
      } catch (e) {
        if (e.message.includes('expired') || e.message.includes('denied')) {
          throw e;
        }
        // Network error - retry
        console.error('网络错误，重试中...');
      }
    }
    
    throw new Error('Device code expired');
  }

  /**
   * Create display message for device code (chat-friendly)
   */
  createDeviceCodeDisplay(deviceCode) {
    return `🔐 **GitHub OAuth 登录**

请按以下步骤完成认证：

1️⃣ **打开链接**
${deviceCode.verification_uri}

2️⃣ **输入验证码**
\`${deviceCode.user_code}\`

3️⃣ **等待授权完成**
系统会自动检测授权状态，有效期 ${Math.floor(deviceCode.expires_in / 60)} 分钟

---
💡 提示：复制链接到浏览器打开，然后在 GitHub 页面输入验证码并授权。`;
  }

  /**
   * Create display message for successful login
   */
  createLoginSuccessDisplay(user) {
    return `✅ **登录成功**

👤 **用户**: @${user.login}${user.name ? ` (${user.name})` : ''}
🆔 **用户 ID**: ${user.id}
🔐 **认证方式**: OAuth 设备码

现在可以开始使用 gtw 命令了！`;
  }

  /**
   * Save token to token.json
   */
  saveToken(tokenData) {
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2), 'utf8');
    } catch (e) {
      console.error('[gtw] Failed to save token:', e.message);
    }
  }

  /**
   * Save device code state for background polling
   */
  saveDeviceCodeState(deviceCode) {
    const stateFile = join(CONFIG_DIR, 'device_code.json');
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      const state = {
        device_code: deviceCode.device_code,
        user_code: deviceCode.user_code,
        verification_uri: deviceCode.verification_uri,
        interval: deviceCode.interval,
        expiresAt: Date.now() + (deviceCode.expires_in * 1000),
        createdAt: new Date().toISOString(),
      };
      writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
      console.error('[gtw] Failed to save device code state:', e.message);
    }
  }

  /**
   * Load device code state
   */
  loadDeviceCodeState() {
    const stateFile = join(CONFIG_DIR, 'device_code.json');
    try {
      if (existsSync(stateFile)) {
        return JSON.parse(readFileSync(stateFile, 'utf8'));
      }
    } catch (e) {
      console.error('[gtw] Failed to load device code state:', e.message);
    }
    return null;
  }

  /**
   * Clear device code state
   */
  clearDeviceCodeState() {
    const stateFile = join(CONFIG_DIR, 'device_code.json');
    try {
      if (existsSync(stateFile)) {
        // Keep the file but clear the device_code to invalidate the session
        const state = JSON.parse(readFileSync(stateFile, 'utf8'));
        state.device_code = null;
        state.clearedAt = new Date().toISOString();
        writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
      }
    } catch (e) {
      console.error('[gtw] Failed to clear device code state:', e.message);
    }
  }
}
