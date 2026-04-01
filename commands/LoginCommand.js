import { homedir } from 'os';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { Commander } from './Commander.js';
import { GitHubClient, getGhTokenFromCli, isGhCliInstalled, isGhCliLoggedIn } from '../utils/github.js';

const CONFIG_DIR = join(homedir(), '.openclaw', 'gtw');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');

/**
 * Login command - supports three modes:
 * 1. PAT (--pat flag or GITHUB_TOKEN env var)
 * 2. GitHub OAuth device flow (uses gh CLI's official client_id)
 * 3. gh CLI token reuse (if already logged in)
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

    // Default: OAuth device flow or gh CLI reuse
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
        return {
          ok: true,
          message: '✅ 登录成功！PAT 已验证并缓存',
          user: { login: (await client.getCurrentUser()).login },
          token: { source: 'pat', cached_at: Date.now() },
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
        return {
          ok: true,
          message: '✅ 登录成功！PAT (GITHUB_TOKEN) 已验证并缓存',
          user: { login: (await client.getCurrentUser()).login },
          token: { source: 'pat', cached_at: Date.now() },
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
   * Login using OAuth device flow (or reuse gh CLI session)
   */
  async loginWithOAuth() {
    const client = new GitHubClient();
    
    // Check if gh CLI is installed and logged in
    if (isGhCliInstalled() && isGhCliLoggedIn()) {
      console.log('检测到 gh CLI 已登录，复用现有会话...\n');
      try {
        const ghToken = getGhTokenFromCli();
        client.setToken(ghToken);
        const user = await client.getCurrentUser();
        
        // Cache token for gtw
        this.saveToken({
          source: 'gh-cli',
          access_token: ghToken,
          cached_at: Date.now(),
        });
        
        return {
          ok: true,
          message: '✅ 登录成功！Token 已从 gh CLI 获取并缓存',
          user: { login: user.login, name: user.name },
          token: { source: 'gh-cli', cached_at: Date.now() },
        };
      } catch (e) {
        // Fall through to device flow if gh CLI token fails
        console.log('gh CLI token 无效，使用 OAuth 设备码登录...\n');
      }
    }
    
    // Use OAuth device flow
    try {
      console.log('开始 GitHub OAuth 设备码认证...\n');
      const result = await client.loginWithDeviceFlow();
      
      // Cache token
      this.saveToken({
        source: 'oauth',
        access_token: result.token,
        cached_at: Date.now(),
      });
      
      return {
        ok: true,
        message: '✅ 登录成功！',
        user: result.user,
        token: { source: 'oauth', cached_at: Date.now() },
      };
    } catch (e) {
      if (e.message.includes('expired')) {
        return {
          ok: false,
          message: '❌ 认证超时，请重试',
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
   * Save token to token.json
   * @param {object} tokenData
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
