import { homedir } from 'os';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { Commander } from './Commander.js';
import { GitHubClient } from '../utils/github.js';

const CONFIG_DIR = join(homedir(), '.openclaw', 'gtw');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');

// ---------------------------------------------------------------------------
// Helper: Inject login polling directive into main session
// ---------------------------------------------------------------------------

function getMainSessionFile() {
  const sessionsPath = join(homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
  if (!existsSync(sessionsPath)) return null;
  try {
    const data = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    // Try main:main key first
    const key = 'agent:main:main';
    const entry = data[key];
    if (entry?.sessionFile && existsSync(entry.sessionFile)) {
      return { key, file: entry.sessionFile };
    }
    // Fallback: find first entry that has a sessionFile
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith('agent:') && v?.sessionFile && existsSync(v.sessionFile)) {
        return { key: k, file: v.sessionFile };
      }
    }
  } catch {}
  return null;
}

function injectLoginDirective(sessionFile, deviceCode) {
  const directive = [
    `🚨 [URGENT] [gtw login] GitHub OAuth - Execute NOW`,
    ``,
    `⚠️ ACTION REQUIRED: Poll GitHub OAuth token endpoint IMMEDIATELY`,
    ``,
    `Device Code: ${deviceCode.device_code}`,
    `User Code: ${deviceCode.user_code}`,
    `Verification URL: ${deviceCode.verification_uri}`,
    `Expires in: ${deviceCode.expires_in} seconds`,
    `Interval: ${deviceCode.interval} seconds`,
    ``,
    `Please perform the following:`,
    ``,
    `1. Poll GitHub OAuth token endpoint until authorization is complete or expired:`,
    `   - Endpoint: https://github.com/login/oauth/access_token`,
    `   - Body: client_id=178c6fc778ccc68e1d6a&device_code=${deviceCode.device_code}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
    `   - Poll every ${deviceCode.interval} seconds`,
    `   - Stop when: access_token received, or "expired_token" error, or ${deviceCode.expires_in} seconds elapsed`,
    ``,
    `2. If token received:`,
    `   - Save to ${TOKEN_FILE}:`,
    `     { "source": "oauth", "access_token": "<token>", "cached_at": <timestamp> }`,
    `   - Get user info from GitHub API (GET /user with the token)`,
    `   - Reply to user: "✅ Login successful! User: @<login>"`,
    ``,
    `3. If expired or denied:`,
    `   - Reply to user: "❌ Authorization expired/denied. Please run /gtw login again."`,
    ``,
    `Do this now. Poll until complete, then report the result.`,
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
   * Start OAuth device flow, return device code immediately,
   * and inject polling directive into session for agent to process
   */
  async startOAuthFlow() {
    const client = new GitHubClient();
    
    try {
      console.log('Starting GitHub OAuth device code flow...\n');
      
      // Step 1: Request device code
      const deviceCode = await client.requestDeviceCode();
      
      // Step 2: Save device code state (for potential re-use)
      this.saveDeviceCodeState(deviceCode);
      
      // Step 3: Return instructions to user IMMEDIATELY
      const display = this.createDeviceCodeDisplay(deviceCode);
      
      // Step 4: Inject polling directive into main session
      // The agent will process this and poll until token is received
      const mainSession = getMainSessionFile();
      if (mainSession) {
        const injected = injectLoginDirective(mainSession.file, deviceCode);
        if (!injected) {
          console.error('[gtw] Warning: failed to inject login directive into session');
        } else {
          console.log('[gtw] Login polling directive injected into session');
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
