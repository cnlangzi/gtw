import { homedir } from 'os';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { Commander } from './Commander.js';
import { GitHubClient, httpsRequest, GITHUB_CLIENT_ID, GITHUB_TOKEN_URL } from '../utils/github.js';
import { resolveRealSessionKey, injectMessage as injectMessageToSession } from '../utils/session.js';

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
   * and start async polling in background
   */
  async startOAuthFlow() {
    const client = new GitHubClient();
    
    try {
      console.log('Starting GitHub OAuth device code flow...\n');
      
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
        message: 'GitHub authorization flow started',
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
   * Start background polling for OAuth token
   * Fires and forgets - will inject message to session when complete
   */
  startBackgroundPolling(deviceCode) {
    // Resolve the real session key (handles dmScope variations)
    const rawSessionKey = this.sessionKey;
    const resolvedSessionKey = resolveRealSessionKey(rawSessionKey, 'main');
    const targetSessionKey = resolvedSessionKey || rawSessionKey;
    
    console.log('[gtw] Starting background polling...');
    console.log('[gtw] Raw session key:', rawSessionKey);
    console.log('[gtw] Resolved session key:', resolvedSessionKey);
    console.log('[gtw] Target session key:', targetSessionKey);
    
    // Capture context before async to avoid losing it
    const saveToken = this.saveToken.bind(this);
    const clearDeviceCodeState = this.clearDeviceCodeState.bind(this);
    const createLoginSuccessDisplay = this.createLoginSuccessDisplay.bind(this);
    
    // Use setTimeout(0) instead of setImmediate for better compatibility
    setTimeout(async () => {
      const expiresAt = Date.now() + (deviceCode.expires_in * 1000);
      const interval = deviceCode.interval * 1000;
      
      console.log('[gtw] Background polling loop started...');
      console.log('[gtw] Interval:', interval / 1000, 'seconds');
      console.log('[gtw] Expires at:', new Date(expiresAt).toISOString());
      
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
            console.log('[gtw] Token received! Getting user info...');
            const client = new GitHubClient(data.access_token);
            const user = await client.getCurrentUser();
            
            // Cache token
            saveToken({
              source: 'oauth',
              access_token: data.access_token,
              cached_at: Date.now(),
            });
            
            // Clear device code state
            clearDeviceCodeState();
            
            // Notify user via session message
            const successDisplay = createLoginSuccessDisplay(user);
            console.log('[gtw] Sending success message to session:', targetSessionKey);
            
            if (targetSessionKey) {
              const sent = injectMessageToSession(targetSessionKey, successDisplay);
              console.log('[gtw] Message sent:', sent ? 'success' : 'failed');
            } else {
              console.error('[gtw] Cannot send message: sessionKey is missing');
            }
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
            clearDeviceCodeState();
            if (targetSessionKey) {
              injectMessageToSession(targetSessionKey, 
                '❌ **Authorization Expired**\n\nThe device code is valid for 15 minutes and has expired.\n\nPlease run: /gtw login');
            }
            console.log('[gtw] Device code expired');
            return;
          }

          if (data.error === 'access_denied') {
            clearDeviceCodeState();
            if (targetSessionKey) {
              injectMessageToSession(targetSessionKey,
                '❌ **Authorization Denied**\n\nThe authorization was denied or cancelled.\n\nTo re-authorize, run: /gtw login');
            }
            console.log('[gtw] Authorization denied');
            return;
          }

          // Other errors
          if (targetSessionKey) {
            injectMessageToSession(targetSessionKey,
              `❌ **Authentication Failed**\n\nError: ${data.error}\n\nPlease retry: /gtw login`);
          }
          console.log('[gtw] OAuth error:', data.error);
          return;
          
        } catch (e) {
          // Network errors - retry
          console.error('[gtw] Polling network error, retrying:', e.message);
        }
      }
      
      // Timeout
      clearDeviceCodeState();
      if (targetSessionKey) {
        injectMessageToSession(targetSessionKey,
          '❌ **Authorization Timeout**\n\nThe device code is valid for 15 minutes.\n\nPlease run: /gtw login');
      }
      console.log('[gtw] Polling timeout');
    }, 0); // setTimeout with 0 delay instead of setImmediate
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
        console.error('Network error, retrying...');
      }
    }
    
    throw new Error('Device code expired');
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
