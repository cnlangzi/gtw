import { homedir } from 'os';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { Commander } from './Commander.js';
import { GitHubClient } from '../utils/github.js';

const CONFIG_DIR = join(homedir(), '.openclaw', 'gtw');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');

// ---------------------------------------------------------------------------
// Inject login polling directive into main session
// ---------------------------------------------------------------------------

function getMainSessionFile() {
  const sessionsPath = join(homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
  if (!existsSync(sessionsPath)) return null;
  try {
    const data = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    const key = 'agent:main:main';
    const entry = data[key];
    if (entry?.sessionFile && existsSync(entry.sessionFile)) {
      return { key, file: entry.sessionFile };
    }
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith('agent:') && v?.sessionFile && existsSync(v.sessionFile)) {
        return { key: k, file: v.sessionFile };
      }
    }
  } catch {}
  return null;
}

function injectLoginDirective(sessionFile, deviceCode) {
  // Same pattern as FixCommand: inject a directive, the main agent spawns
  // a subagent, and the main agent does all writing and reply.
  // The subagent only returns a structured result; main agent owns everything else.
  const directive = [
    `🚨 [gtw login] GitHub OAuth polling — reply to this message with result`,
    ``,
    `Device Code: ${deviceCode.device_code}`,
    `User Code: ${deviceCode.user_code}`,
    `Verification URL: ${deviceCode.verification_uri}`,
    `Expires in: ${deviceCode.expires_in}s | Poll interval: ${deviceCode.interval}s`,
    ``,
    `Please perform the following steps in order:`,
    ``,
    `1. Spawn a subagent (mode=run) with the following task:`,
    ``,
    `   Task:`,
    `   ===`,
    `   You are polling GitHub OAuth device flow.`,
    ``,
    `   Your job (do this ONLY, return nothing else):`,
    `   1. Loop every ${deviceCode.interval}s for up to ${deviceCode.expires_in}s:`,
    `   2. POST https://github.com/login/oauth/access_token`,
    `      Content-Type: application/json`,
    `      Body: {"client_id":"178c6fc778ccc68e1d6a","device_code":"${deviceCode.device_code}","grant_type":"urn:ietf:params:oauth:grant-type:device_code"}`,
    `   3. Parse the response:`,
    `      - If "access_token" present: output "RESULT:<token>" and exit 0`,
    `      - If "error":"authorization_pending": continue to next poll`,
    `      - If "error":"access_denied": output "DENIED" and exit 0`,
    `      - If "error":"expired_token": output "EXPIRED" and exit 0`,
    `   4. If ${deviceCode.expires_in}s elapse with no access_token: output "TIMEOUT" and exit 0`,
    `   ===`,
    ``,
    `2. Wait for the subagent to finish.`,
    ``,
    `3. Based on the subagent output:`,
    ``,
    `   **If output starts with "RESULT:":**`,
    `   Extract the token (everything after "RESULT:").`,
    `   a. Write to ${TOKEN_FILE}:`,
    `      {"source":"oauth","access_token":"<token>","cached_at":<current_timestamp_ms>}`,
    `   b. GET https://api.github.com/user`,
    `      Header: Authorization: Bearer <token>`,
    `   c. Extract the "login" field from the response`,
    `   d. Reply to this message: ✅ GitHub Login Successful! User: @<username>`,
    ``,
    `   **If output is "DENIED":**`,
    `      Reply to this message: ❌ Access Denied — you rejected the authorization`,
    ``,
    `   **If output is "EXPIRED":**`,
    `      Reply to this message: ❌ Token Expired — the device code expired before authorization`,
    ``,
    `   **If output is "TIMEOUT":**`,
    `      Reply to this message: ❌ Authorization Timeout — you did not complete login in time`,
    ``,
    `   **Otherwise:**`,
    `      Reply to this message: ❌ OAuth Polling Error: <the raw output>`,
    ``,
    `IMPORTANT: Do this work now, step by step. Do not skip any step.`,
  ].join('\n');

  try {
    const entry = JSON.stringify({
      type: 'message',
      id: `gtw-login-${Date.now()}`,
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text: directive }],
      },
    });
    appendFileSync(sessionFile, entry + '\n');
    return true;
  } catch (e) {
    console.error('[gtw] Failed to inject login directive:', e.message);
    return false;
  }
}

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
    // Check for --check flag
    const useCheck = args.includes('--check') || args.includes('-c');
    if (useCheck) {
      return await this.checkAuthStatus();
    }

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
      console.log('Validating provided token...');
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
          message: '✅ Login successful! PAT validated and cached',
          user: { login: user.login, name: user.name, id: user.id },
          token: { source: 'pat', cached_at: Date.now() },
          display: this.createLoginSuccessDisplay(user),
        };
      } else {
        return {
          ok: false,
          message: '❌ Invalid token. Please check it has repo and workflow scopes',
        };
      }
    }
    
    // Priority 2: Use GITHUB_TOKEN environment variable
    const envToken = process.env.GITHUB_TOKEN;
    
    if (envToken) {
      console.log('GITHUB_TOKEN detected, validating...');
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
          message: '✅ Login successful! PAT (GITHUB_TOKEN) validated and cached',
          user: { login: user.login, name: user.name, id: user.id },
          token: { source: 'pat', cached_at: Date.now() },
          display: this.createLoginSuccessDisplay(user),
        };
      } else {
        return {
          ok: false,
          message: '❌ GITHUB_TOKEN is invalid',
        };
      }
    }
    
    // Priority 3: No token provided - show usage
    return {
      ok: false,
      message: `❌ No PAT provided

Usage:
  /gtw login --pat <your_token>      # Provide token directly
  export GITHUB_TOKEN=xxx            # Or use environment variable
  /gtw login                         # Or use OAuth device flow

Generate a token: https://github.com/settings/tokens (requires repo and workflow scopes)`,
    };
  }

  /**
   * Check current authentication status
   * Usage: /gtw login --check
   */
  async checkAuthStatus() {
    const client = new GitHubClient();
    const tokenFile = join(CONFIG_DIR, 'token.json');
    const deviceCodeFile = join(CONFIG_DIR, 'device_code.json');

    // Step 1: Check if token exists and is valid
    if (existsSync(tokenFile)) {
      try {
        const tokenData = JSON.parse(readFileSync(tokenFile, 'utf8'));
        if (tokenData.access_token) {
          client.setToken(tokenData.access_token);
          const isValid = await client.validateToken();
          if (isValid) {
            const user = await client.getCurrentUser();
            return {
              ok: true,
              message: '✅ Token 有效，可以使用 gtw 命令',
              user: { login: user.login, name: user.name, id: user.id },
              display: this.createLoginSuccessDisplay(user),
            };
          }
        }
      } catch (e) {
        // Token invalid or error - fall through to check device code
      }
    }

    // Step 2: Check if device code exists (auth started but not completed)
    if (existsSync(deviceCodeFile)) {
      try {
        const state = JSON.parse(readFileSync(deviceCodeFile, 'utf8'));
        if (state.device_code && state.expiresAt > Date.now()) {
          const displayLines = [
            '🔐 **授权流程已开始，请完成以下步骤：**',
            '',
            '1️⃣ **打开链接**',
            state.verification_uri || 'https://github.com/login/device',
            '',
            '2️⃣ **输入验证码**',
            state.user_code,
            '',
            '⚠️ 授权尚未完成，请在浏览器中完成授权',
            '',
            '---',
            '💡 授权完成后，系统会自动检测并通知你结果。',
          ];
          const display = displayLines.join('\n');

          return {
            ok: false,
            message: '⚠️ 授权尚未完成',
            display: display,
          };
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    // Step 3: Neither token nor device code found
    return {
      ok: false,
      message: '❌ 未检测到授权流程，请先运行 /gtw login',
    };
  }

  /**
   * Start OAuth device flow, return device code immediately,
   * and inject polling directive into session for agent to process
   */
  async startOAuthFlow() {
    const client = new GitHubClient();
    
    try {
      console.log('Starting GitHub OAuth device code flow...\n');
      
      // Step 1: Request device code
      const deviceCode = await client.requestDeviceCode();
      
      // Step 2: Build session context for callback
      const sessionContext = {
        channel: this.api.channel || 'feishu',
        target: this.api.chatId || null,
        sessionKey: this.sessionKey,
      };
      
      // Step 3: Save device code state (for potential re-use)
      this.saveDeviceCodeState(deviceCode, sessionContext);
      
      // Step 4: Return instructions to user IMMEDIATELY
      const display = this.createDeviceCodeDisplay(deviceCode);
      
      // Step 5: Inject polling directive into main session
      // The agent will process this and poll until token is received
      const mainSession = getMainSessionFile();
      if (mainSession) {
        const injected = injectLoginDirective(mainSession.file, deviceCode);
        if (!injected) {
          console.error('[gtw] Warning: failed to inject login directive');
        }
      } else {
        console.error('[gtw] Warning: could not find main session file');
      }
      
      return {
        ok: true,
        message: 'GitHub OAuth login started',
        display: display,
      };
    } catch (e) {
      return {
        ok: false,
        message: `❌ Failed to get device code: ${e.message}`,
      };
    }
  }

  /**
   * Create display message for device code (chat-friendly)
   */
  createDeviceCodeDisplay(deviceCode) {
    return `🔐 **GitHub OAuth Login**

Please complete the authorization following these steps:

1️⃣ **Open this link**
${deviceCode.verification_uri}

2️⃣ **Enter this code**
\`${deviceCode.user_code}\`

3️⃣ **Wait for authorization**
The system will automatically detect when authorization is complete.
Valid for ${Math.floor(deviceCode.expires_in / 60)} minutes.

---
💡 **Tip**: Copy the link to your browser, open it, then enter the code on GitHub and authorize.`;
  }

  /**
   * Create display message for successful login
   */
  createLoginSuccessDisplay(user) {
    return `✅ **Login Successful**

👤 **User**: @${user.login}${user.name ? ` (${user.name})` : ''}
🆔 **User ID**: ${user.id}
🔐 **Auth Method**: OAuth Device Code

You can now start using gtw commands!`;
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
  saveDeviceCodeState(deviceCode, sessionContext = null) {
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
        // Session context for callback notification
        session: sessionContext ? {
          channel: sessionContext.channel,
          target: sessionContext.target,
          sessionKey: sessionContext.sessionKey,
        } : null,
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
