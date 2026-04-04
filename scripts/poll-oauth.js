#!/usr/bin/env node
/**
 * poll-oauth.js - Poll GitHub OAuth token endpoint until authorization complete
 * 
 * Usage: node poll-oauth.js <device_code> <client_id> [interval] [expires_in]
 * 
 * This script polls the GitHub OAuth token endpoint every 5 seconds until:
 * - access_token received (success)
 * - expired_token error (failure)
 * - access_denied error (failure)
 * - timeout reached (failure)
 * 
 * Uses http_proxy/https_proxy environment variables for GitHub access.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getSessionFile, injectMessage } from '../utils/session.js';

const CONFIG_DIR = join(homedir(), '.openclaw', 'gtw');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');
const DEVICE_CODE_FILE = join(CONFIG_DIR, 'device_code.json');

/**
 * Send notification to original session by injecting a message.
 */
function notifySession(message, isSuccess = true) {
  try {
    let sessionKey = null;
    
    // Try to get sessionKey from device_code.json
    if (existsSync(DEVICE_CODE_FILE)) {
      const state = JSON.parse(readFileSync(DEVICE_CODE_FILE, 'utf8'));
      const session = state?.session;
      
      if (session?.sessionKey) {
        sessionKey = session.sessionKey;
        console.log(`[poll-oauth] Found sessionKey in device_code.json: ${sessionKey}`);
      } else if (session?.channel) {
        console.log(`[poll-oauth] device_code.json session context:`, JSON.stringify(session, null, 2));
      }
    }
    
    // Fallback to main session if no sessionKey found
    if (!sessionKey) {
      sessionKey = 'agent:main:main';
      console.log(`[poll-oauth] Using fallback main session: ${sessionKey}`);
    }
    
    // Format message with prefix for visibility
    const prefix = isSuccess ? '✅' : '❌';
    const formattedMessage = `${prefix} [gtw login] ${message}`;
    
    // Use injectMessage to append directly to session JSONL
    injectMessage(sessionKey, formattedMessage);
    
  } catch (e) {
    console.error('[poll-oauth] Failed to notify session:', e.message);
  }
}

async function pollOAuth(deviceCode, clientId, interval = 5, expiresIn = 900) {
  const expiresAt = Date.now() + (expiresIn * 1000);
  
  console.log(`[poll-oauth] Starting poll for device code: ${deviceCode}`);
  console.log(`[poll-oauth] Expires in: ${expiresIn}s, interval: ${interval}s`);
  console.log(`[poll-oauth] http_proxy: ${process.env.http_proxy || 'not set'}`);
  console.log(`[poll-oauth] https_proxy: ${process.env.https_proxy || 'not set'}`);
  
  while (Date.now() < expiresAt) {
    try {
      // POST to GitHub OAuth token endpoint
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      
      const data = await response.json();
      console.log(`[poll-oauth] Response:`, JSON.stringify(data));
      
      // Check for success
      if (data.access_token) {
        console.log('[poll-oauth] ✅ Token received!');
        
        // Save token
        mkdirSync(CONFIG_DIR, { recursive: true });
        const tokenData = {
          source: 'oauth',
          access_token: data.access_token,
          cached_at: Date.now(),
        };
        writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2), 'utf8');
        console.log(`[poll-oauth] Token saved to: ${TOKEN_FILE}`);
        
        // Get user info
        const userResponse = await fetch('https://api.github.com/user', {
          headers: {
            'Authorization': `Bearer ${data.access_token}`,
            'Accept': 'application/json',
          },
        });
        const user = await userResponse.json();
        
        console.log(`[poll-oauth] ✅ Login successful! User: @${user.login}`);
        console.log(`[poll-oauth] User ID: ${user.id}, Name: ${user.name || 'N/A'}`);
        
        // Notify original session
        const successMessage = `**GitHub Login Successful**\n\n👤 User: @${user.login}${user.name ? ` (${user.name})` : ''}\n🆔 User ID: ${user.id}\n\nYou can now use gtw commands!`;
        notifySession(successMessage, true);
        
        return {
          ok: true,
          login: user.login,
          id: user.id,
          name: user.name,
        };
      }
      
      // Check for errors
      if (data.error === 'expired_token') {
        console.log('[poll-oauth] ❌ Authorization expired');
        notifySession('GitHub OAuth authorization expired. Please try `/gtw login` again.', false);
        return { ok: false, error: 'expired_token' };
      }
      
      if (data.error === 'access_denied') {
        console.log('[poll-oauth] ❌ Authorization denied by user');
        notifySession('GitHub OAuth authorization was denied. Please try `/gtw login` again if you changed your mind.', false);
        return { ok: false, error: 'access_denied' };
      }
      
      // authorization_pending - continue polling
      if (data.error === 'authorization_pending') {
        console.log(`[poll-oauth] Waiting for authorization... (${Math.floor((expiresAt - Date.now()) / 1000)}s remaining)`);
      } else if (data.error) {
        console.log(`[poll-oauth] Unknown error: ${data.error}`);
      }
      
    } catch (e) {
      console.error(`[poll-oauth] Fetch error: ${e.message}`);
    }
    
    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, interval * 1000));
  }
  
  console.log('[poll-oauth] ❌ Authorization timed out');
  notifySession('GitHub OAuth authorization timed out. Please try `/gtw login` again.', false);
  return { ok: false, error: 'timeout' };
}

// Main
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node poll-oauth.js <device_code> <client_id> [interval] [expires_in]');
  process.exit(1);
}

const deviceCode = args[0];
const clientId = args[1];
const interval = parseInt(args[2] || '5', 10);
const expiresIn = parseInt(args[3] || '900', 10);

pollOAuth(deviceCode, clientId, interval, expiresIn)
  .then(result => {
    process.exit(result.ok ? 0 : 1);
  })
  .catch(e => {
    console.error(`[poll-oauth] Fatal error: ${e.message}`);
    process.exit(1);
  });
