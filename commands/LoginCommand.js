import { write, read, exists, makeDir } from '../utils/fs.js';
import { Commander } from './Commander.js';
import { GitHubClient } from '../utils/github.js';
import { BASE_DIR, TOKEN_FILE, POLLING_STATE_FILE } from '../utils/config.js';

export class LoginCommand extends Commander {
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
        this._saveToken({
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

    return {
      ok: false,
      message: `❌ No PAT provided

Usage:
  /gtw login --pat <your_token>      # Provide token directly
  /gtw login                         # Or use OAuth device flow

Generate a token: https://github.com/settings/tokens (requires repo and workflow scopes)`,
    };
  }

  async checkAuthStatus() {
    const client = new GitHubClient();

    if (exists(TOKEN_FILE)) {
      try {
        const tokenData = JSON.parse(read(TOKEN_FILE, 'utf8'));
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
        console.debug('[LoginCommand] Token file parse failed:', e.message);
      }
    }

    if (exists(POLLING_STATE_FILE)) {
      try {
        const state = JSON.parse(read(POLLING_STATE_FILE, 'utf8'));
        if (state.status === 'pending' && state.expires_at > Date.now()) {
          return {
            ok: false,
            message: '⏳ Authorization still in progress',
            display: [
              '🔐 **Authorization in progress...**',
              '',
              `📋 Code: ${state.user_code}`,
              `🔗 URL: ${state.verification_uri}`,
              '',
              `⏳ Waiting for authorization...`,
              `⏰ Time remaining: ${Math.floor((state.expires_at - Date.now()) / 1000)}s`,
              '',
              '💡 Complete authorization on GitHub and the system will notify you automatically.',
            ].join('\n'),
          };
        } else if (state.status === 'completed') {
          const user = await client.getCurrentUser();
          return {
            ok: true,
            message: '✅ Token valid, gtw commands are ready to use',
            user: { login: user.login, name: user.name, id: user.id },
            display: this.createLoginSuccessDisplay(user),
          };
        }
      } catch (e) {
        console.debug('[LoginCommand] Polling state parse failed:', e.message);
      }
    }

    return {
      ok: false,
      message: '❌ No authorization flow detected. Run /gtw login to start one',
    };
  }

  loadExistingPollingState() {
    try {
      if (exists(POLLING_STATE_FILE)) {
        const state = JSON.parse(read(POLLING_STATE_FILE, 'utf8'));
        if (state.device_code && state.expires_at > Date.now() && state.status === 'pending') {
          return state;
        }
      }
    } catch (e) {
      console.error('[gtw] Failed to load polling state:', e.message);
    }
    return null;
  }

  async startOAuthFlow() {
    const client = new GitHubClient();

    try {
      console.log('Starting GitHub OAuth device code flow...\n\n');

      const existingState = this.loadExistingPollingState();
      let deviceCode;

      if (existingState) {
        console.log('Reusing existing valid device code (expires in',
          Math.round((existingState.expires_at - Date.now()) / 1000), 's)');
        deviceCode = {
          device_code: existingState.device_code,
          user_code: existingState.user_code,
          verification_uri: existingState.verification_uri,
          expires_in: Math.round((existingState.expires_at - Date.now()) / 1000),
          interval: existingState.interval || 5,
        };
      } else {
        deviceCode = await client.requestDeviceCode();
      }

      this._savePollingState(deviceCode);

      const injected = await this.enqueueDirective(this._buildLoginDirective(deviceCode));
      if (!injected) {
        console.error('[gtw] Warning: failed to enqueue login directive');
      }

      return {
        ok: true,
        message: 'GitHub OAuth login started',
        display: this.createDeviceCodeDisplay(deviceCode),
      };
    } catch (e) {
      return {
        ok: false,
        message: `❌ Failed to get device code: ${e.message}`,
      };
    }
  }

  _buildLoginDirective(deviceCode) {
    const pollIntervalSec = deviceCode.interval || 5;
    return [
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
      ``,
      `===`,
      ``,
      `IMPORTANT: Do this now. Poll every ${pollIntervalSec}s until done. Announce the result when complete.`,
    ].join('\n');
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
💡 Or manually verify with: \`gtw login --check\``;
  }

  createLoginSuccessDisplay(user, authMethod = 'OAuth Device Code') {
    const methodLabel = authMethod === 'pat' ? 'PAT' : authMethod === 'github_token' ? 'GITHUB_TOKEN' : authMethod;
    return `✅ **Login Successful**

👤 **User**: @${user.login}${user.name ? ` (${user.name})` : ''}
🆔 **User ID**: ${user.id}
🔐 **Auth Method**: ${methodLabel}

You can now start using gtw commands!`;
  }

  _saveToken(tokenData) {
    try {
      makeDir(BASE_DIR, { recursive: true });
      write(TOKEN_FILE, JSON.stringify(tokenData, null, 2), 'utf8');
    } catch (e) {
      console.error('[gtw] Failed to save token:', e.message);
    }
  }

  _savePollingState(deviceCode) {
    try {
      makeDir(BASE_DIR, { recursive: true });
      const state = {
        device_code: deviceCode.device_code,
        user_code: deviceCode.user_code,
        verification_uri: deviceCode.verification_uri,
        interval: deviceCode.interval || 5,
        expires_at: Date.now() + (deviceCode.expires_in * 1000),
        status: 'pending',
        created_at: new Date().toISOString(),
      };
      write(POLLING_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
      console.log(`[gtw] Saved polling state to ${POLLING_STATE_FILE}`);
    } catch (e) {
      console.error(`[gtw] Failed to save polling state: ${e.message}`);
    }
  }
}