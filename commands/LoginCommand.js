import { homedir } from 'os';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { Commander } from './Commander.js';
import { GitHubClient, httpsRequest, GITHUB_CLIENT_ID, GITHUB_TOKEN_URL } from '../utils/github.js';

const CONFIG_DIR = join(homedir(), '.openclaw', 'gtw');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');

/**
 * Login command - supports three modes:
 * 1. PAT (--pat flag or GITHUB_TOKEN env var)
 * 2. GitHub OAuth device flow (pure HTTPS, works in chat environments like Feishu)
 * 3. gh CLI token reuse (optional fallback)
 * 
 * Designed for chat environments - no browser launching, all info returned to session.
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
    // Check for --pat flag
    const usePat = args.includes('--pat') || args.includes('-p');
    
    if (usePat) {
      return await this.loginWithPat(args);
    }

    // Default: OAuth device flow (pure HTTPS, no browser launch)
    return await this.loginWithOAuth();
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
   * Login using OAuth device flow (pure HTTPS, works in chat environments)
   * Returns verification URI and user code for user to complete in browser
   */
  async loginWithOAuth() {
    const client = new GitHubClient();
    
    // Use OAuth device flow (pure HTTPS)
    try {
      console.log('开始 GitHub OAuth 设备码认证...\n');
      
      // Step 1: Request device code
      const deviceCode = await client.requestDeviceCode();
      
      // Step 2: Return instructions to user (for chat environment)
      // User will manually open browser and enter code
      const display = this.createDeviceCodeDisplay(deviceCode);
      
      // Step 3: Poll for token (with timeout)
      console.log('等待用户授权...');
      const expiresAt = Date.now() + (deviceCode.expires_in * 1000);
      
      // Poll in background - in chat environment, user might take time
      const token = await this.pollWithProgress(
        deviceCode.device_code,
        deviceCode.interval,
        expiresAt
      );
      
      // Step 4: Set token and get user info
      client.setToken(token);
      const user = await client.getCurrentUser();
      
      // Step 5: Cache token
      this.saveToken({
        source: 'oauth',
        access_token: token,
        cached_at: Date.now(),
      });
      
      return {
        ok: true,
        message: '✅ 登录成功！',
        user: { login: user.login, name: user.name, id: user.id },
        token: { source: 'oauth', cached_at: Date.now() },
        display: this.createLoginSuccessDisplay(user),
      };
    } catch (e) {
      if (e.message.includes('expired')) {
        return {
          ok: false,
          message: '❌ 认证超时，请重试\n\n提示：设备码有效期为 15 分钟，请在有效期内完成授权。',
        };
      }
      if (e.message.includes('denied')) {
        return {
          ok: false,
          message: '❌ 认证已被取消',
        };
      }
      throw e;
    }
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
}
