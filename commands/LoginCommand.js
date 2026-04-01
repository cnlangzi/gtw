import { homedir } from 'os';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { Commander } from './Commander.js';
import { GitHubClient, httpsRequest, GITHUB_CLIENT_ID, GITHUB_TOKEN_URL } from '../utils/github.js';

const CONFIG_DIR = join(homedir(), '.openclaw', 'gtw');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');

/**
 * Login command - supports two-phase OAuth device flow:
 * Phase 1: /gtw login - Returns device code for user to authorize
 * Phase 2: /gtw login --check - Checks if authorization is complete
 * 
 * Also supports PAT login: /gtw login --pat <token>
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
    
    // Check for --check flag (phase 2)
    const checkStatus = args.includes('--check') || args.includes('-c');
    
    if (checkStatus) {
      return await this.checkAuthStatus();
    }

    // Default: Start OAuth device flow (phase 1)
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
   * Phase 1: Start OAuth device flow and return device code to user
   */
  async startOAuthFlow() {
    const client = new GitHubClient();
    
    try {
      console.log('开始 GitHub OAuth 设备码认证...\n');
      
      // Step 1: Request device code
      const deviceCode = await client.requestDeviceCode();
      
      // Step 2: Save device code to state file for later polling
      this.saveDeviceCodeState(deviceCode);
      
      // Step 3: Return instructions to user IMMEDIATELY
      // User needs to see this before they can authorize
      return {
        ok: true,
        message: '请按以下步骤完成 GitHub 授权',
        display: this.createDeviceCodeDisplay(deviceCode),
        deviceCode: {
          verification_uri: deviceCode.verification_uri,
          user_code: deviceCode.user_code,
          expires_in: deviceCode.expires_in,
        },
      };
    } catch (e) {
      return {
        ok: false,
        message: `❌ 获取设备码失败：${e.message}`,
      };
    }
  }

  /**
   * Phase 2: Check if user has completed authorization
   * Polls for token and returns success/failure
   */
  async checkAuthStatus() {
    const deviceCode = this.loadDeviceCodeState();
    
    if (!deviceCode) {
      return {
        ok: false,
        message: '❌ 未找到进行中的授权会话\n\n请先运行：/gtw login',
      };
    }
    
    // Check if expired
    if (Date.now() > deviceCode.expiresAt) {
      this.clearDeviceCodeState();
      return {
        ok: false,
        message: '❌ 授权已超时，设备码有效期为 15 分钟\n\n请重新运行：/gtw login',
      };
    }
    
    // Poll for token (non-blocking check - just one attempt)
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
        // Success! Save token and return user info
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
        
        return {
          ok: true,
          message: '✅ 登录成功！',
          user: { login: user.login, name: user.name, id: user.id },
          display: this.createLoginSuccessDisplay(user),
        };
      }

      if (data.error === 'authorization_pending') {
        return {
          ok: false,
          message: '⏳ 等待授权中...\n\n请复制链接到浏览器并完成授权，然后再次运行：/gtw login --check',
          polling: true,
        };
      }

      if (data.error === 'slow_down') {
        return {
          ok: false,
          message: '⏳ GitHub 请求频繁，请稍后再试\n\n等待 10 秒后运行：/gtw login --check',
        };
      }

      if (data.error === 'expired_token') {
        this.clearDeviceCodeState();
        return {
          ok: false,
          message: '❌ 设备码已过期\n\n请重新运行：/gtw login',
        };
      }

      if (data.error === 'access_denied') {
        this.clearDeviceCodeState();
        return {
          ok: false,
          message: '❌ 授权已被取消\n\n如需重新授权，请运行：/gtw login',
        };
      }

      return {
        ok: false,
        message: `❌ 认证失败：${data.error}`,
      };
    } catch (e) {
      return {
        ok: false,
        message: `❌ 检查状态失败：${e.message}`,
      };
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
