import { homedir } from 'os';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { Commander } from './Commander.js';
import { getSessionFile } from '../utils/session.js';
import { GitHubClient } from '../utils/github.js';

const CONFIG_DIR = join(homedir(), '.openclaw', 'gtw');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');
const POLLING_STATE_FILE = join(CONFIG_DIR, 'polling_state.json');

// ---------------------------------------------------------------------------
// Inject login polling directive into main session
// The main agent will see this on its next turn and spawn a sub-agent
// ---------------------------------------------------------------------------

function injectLoginDirective(sessionKey, sessionFile, deviceCode) {
  const pollIntervalSec = deviceCode.interval || 5;

  const directive = [
    `🚨 [gtw login] GitHub OAuth polling - spawn sub-agent to handle this`,
    ``,
    `User Code: ${deviceCode.user_code}`,
    `Verification URL: ${deviceCode.verification_uri}`,
    `Poll interval: ${pollIntervalSec}s | Device code expires in: ${deviceCode.expires_in}s`,
    ``,
    `Please spawn a sub-agent to handle this OAuth polling task:`,
    ``,
    `Sub-agent task:`,
    `===`,
    `You are handling GitHub OAuth polling for gtw.`,
    ``,
    `Your job:`,
    `1. Read polling state from ${POLLING_STATE_FILE}. Extract expires_at (Unix ms timestamp). Stop polling once current time exceeds expires_at.`,
    `2. Poll GitHub OAuth token endpoint every ${pollIntervalSec}s using exec curl:`,
    `   curl -X POST https://github.com/login/oauth/access_token \\`,
    `     -H "Content-Type: application/json" \\`,
    `     -d '{"client_id":"178c6fc778ccc68e1d6a","device_code":"<device_code>","grant_type":"urn:ietf:params:oauth:grant-type:device_code"}'`,
    ``,
    `3. Parse response:`,
    `   - access_token present → write to ${TOKEN_FILE}: {"source":"oauth","access_token":"<token>","cached_at":<timestamp>}`,
    `   - error: "authorization_pending" → check if now > expires_at: if so, Announce timeout and stop; otherwise wait ${pollIntervalSec}s and poll again`,
    `   - error: "access_denied" → Announce: ❌ GitHub authorization was denied. If you changed your mind, run /gtw login again.`,
    `   - error: "expired_token" → Announce: ❌ GitHub authorization expired. Please run /gtw login again to get a new code.`,
    ``,
    `4. On timeout (current time > expires_at):`,
    `   Announce: ⏰ Authorization timed out. The device code has expired. Please run /gtw login again to get a new code.`,
    ``,
    `5. On success:`,
    `   a. Get user info: curl https://api.github.com/user -H "Authorization: Bearer <token>"`,
    `   b. Announce: ✅ GitHub login successful! User: @<username>`,
    `   c. Update ${POLLING_STATE_FILE}: {"status": "completed", "login": "<username>"}`,
    ``,
    `6. Use exec with proxy if needed:`,
    `   export https_proxy=http://192.168.31.225:1087; export http_proxy=http://192.168.31.225:1087; curl ...`,
    ``,
    `===`,
    ``,
    `IMPORTANT: Do this now. Poll every ${pollIntervalSec}s until done. Announce the result when complete.`,
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

// ---------------------------------------------------------------------------
// Save polling state for sub-agent to read
// ---------------------------------------------------------------------------

function savePollingState(deviceCode) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const state = {
      device_code: deviceCode.device_code,
      user_code: deviceCode.user_code,
      verification_uri: deviceCode.verification_uri,
      interval: deviceCode.interval || 5,
      expires_at: Date.now() + (deviceCode.expires_in * 1000),
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    writeFileSync(POLLING_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    console.log(`[gtw] Saved polling state to ${POLLING_STATE_FILE}`);
  } catch (e) {
    console.error(`[gtw] Failed to save polling state: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// LoginCommand
// ---------------------------------------------------------------------------

export class LoginCommand extends Commander {
  constructor(context) {
    super(context);
    this.sessionKey = context.sessionKey;
  }

  async execute(args) {
    const useCheck = args.includes('--check') || args.includes('-c');
    if (useCheck) {
      return await this.checkAuthStatus();
    }

    const usePat = args.includes('--pat') || args.includes('-p');
    if (usePat) {
      return await this.loginWithPat(args);
    }

    return await this.startOAuthFlow();
  }

  /**
   * Login using Personal Access Token (PAT)
   */
  async loginWithPat(args) {
    const client = new GitHubClient();
    const patIndex = args.findIndex(arg => arg === '--pat' || arg === '-p');
    let providedToken = null;
    if (patIndex !== -1 && args[patIndex + 1] && !args[patIndex + 1].startsWith('-')) {
      providedToken = args[patIndex + 1].trim();
    }

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
          display: this.createLoginSuccessDisplay(user, 'pat'),
        };
      } else {
        return {
          ok: false,
          message: '❌ Invalid token. Please check it has repo and workflow scopes',
        };
      }
    }

    const envToken = process.env.GITHUB_TOKEN;
    if (envToken) {
      console.log('GITHUB_TOKEN detected, validating...');
      client.setToken(envToken);
      const isValid = await client.validateToken();
      if (isValid) {
        this.saveToken({
          source: 'github_token',
          access_token: envToken,
          cached_at: Date.now(),
        });
        const user = await client.getCurrentUser();
        return {
          ok: true,
          message: '✅ Login successful! PAT (GITHUB_TOKEN) validated and cached',
          user: { login: user.login, name: user.name, id: user.id },
          token: { source: 'github_token', cached_at: Date.now() },
          display: this.createLoginSuccessDisplay(user, 'github_token'),
        };
      } else {
        return {
          ok: false,
          message: '❌ GITHUB_TOKEN is invalid',
        };
      }
    }

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
   */
  async checkAuthStatus() {
    const client = new GitHubClient();
    const tokenFile = TOKEN_FILE;
    const pollingStateFile = POLLING_STATE_FILE;

    // Check if token exists and is valid
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
              message: '✅ Token valid, gtw commands are ready to use',
              user: { login: user.login, name: user.name, id: user.id },
              display: this.createLoginSuccessDisplay(user),
            };
          }
        }
      } catch (e) {
        // Token invalid or error - fall through
      }
    }

    // Check if polling is in progress
    if (existsSync(pollingStateFile)) {
      try {
        const state = JSON.parse(readFileSync(pollingStateFile, 'utf8'));
        if (state.status === 'pending' && state.expires_at > Date.now()) {
          const displayLines = [
            '🔐 **Authorization in progress...**',
            '',
            `📋 Code: ${state.user_code}`,
            `🔗 URL: ${state.verification_uri}`,
            '',
            `⏳ Waiting for authorization...`,
            `⏰ Time remaining: ${Math.floor((state.expires_at - Date.now()) / 1000)}s`,
            '',
            '💡 Complete authorization on GitHub and the system will notify you automatically.',
          ];
          const display = displayLines.join('\n');

          return {
            ok: false,
            message: '⏳ Authorization still in progress',
            display: display,
          };
        } else if (state.status === 'completed') {
          // Token was received
          const user = await client.getCurrentUser();
          return {
            ok: true,
            message: '✅ Token valid, gtw commands are ready to use',
            user: { login: user.login, name: user.name, id: user.id },
            display: this.createLoginSuccessDisplay(user),
          };
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    // No token or polling state found
    return {
      ok: false,
      message: '❌ No authorization flow detected. Run /gtw login to start one',
    };
  }

  /**
   * Start OAuth device flow, return device code immediately,
   * and inject directive for main agent to spawn polling sub-agent.
   */
  async startOAuthFlow() {
    const client = new GitHubClient();

    try {
      console.log('Starting GitHub OAuth device code flow...\n\n');

      // Check for existing valid device code
      const existingState = this.loadDeviceCodeState();
      let deviceCode;

      if (existingState && existingState.device_code && existingState.expiresAt > Date.now()) {
        console.log('Reusing existing valid device code (expires in',
          Math.round((existingState.expiresAt - Date.now()) / 1000), 's)');
        deviceCode = {
          device_code: existingState.device_code,
          user_code: existingState.user_code,
          verification_uri: existingState.verification_uri,
          expires_in: Math.round((existingState.expiresAt - Date.now()) / 1000),
          interval: existingState.interval,
        };
      } else {
        deviceCode = await client.requestDeviceCode();
      }

      // Extract user open_id
      // Save polling state for sub-agent
      savePollingState(deviceCode);

      // Return instructions to user immediately
      const display = this.createDeviceCodeDisplay(deviceCode);

      // Inject directive into main session for next turn
      const sessionFile = getSessionFile(this.sessionKey);
      if (sessionFile) {
        const injected = injectLoginDirective(
          this.sessionKey,
          sessionFile,
          deviceCode
        );
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

  createDeviceCodeDisplay(deviceCode) {
    return `🔐 **GitHub OAuth Login**

Please complete the authorization following these steps:

1️⃣ **Open this link**
${deviceCode.verification_uri}

2️⃣ **Enter this code**
\`${deviceCode.user_code}\`

3️⃣ **Authorize the application**
Click "Authorize" to grant access.

⏱️ Code expires in ${Math.floor(deviceCode.expires_in / 60)} minutes.

---
✅ Once authorized, the system will notify you automatically.
You can continue using other commands while waiting.`;
  }

  createLoginSuccessDisplay(user, authMethod = 'OAuth Device Code') {
    const methodLabel = authMethod === 'pat' ? 'PAT' : authMethod === 'github_token' ? 'GITHUB_TOKEN' : authMethod;
    return `✅ **Login Successful**

👤 **User**: @${user.login}${user.name ? ` (${user.name})` : ''}
🆔 **User ID**: ${user.id}
🔐 **Auth Method**: ${methodLabel}

You can now start using gtw commands!`;
  }

  saveToken(tokenData) {
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2), 'utf8');
    } catch (e) {
      console.error('[gtw] Failed to save token:', e.message);
    }
  }



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
}
