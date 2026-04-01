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
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, homedir } from 'path';

const CONFIG_DIR = join(homedir(), '.openclaw', 'gtw');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');

async function pollOAuth(deviceCode, clientId, interval = 5, expiresIn = 900) {
  const expiresAt = Date.now() + (expiresIn * 1000);
  
  console.log(`[poll-oauth] Starting poll for device code: ${deviceCode}`);
  console.log(`[poll-oauth] Expires in: ${expiresIn}s, interval: ${interval}s`);
  
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
        return { ok: false, error: 'expired_token' };
      }
      
      if (data.error === 'access_denied') {
        console.log('[poll-oauth] ❌ Authorization denied by user');
        return { ok: false, error: 'access_denied' };
      }
      
      // authorization_pending - continue polling
      if (data.error === 'authorization_pending') {
        console.log(`[poll-oauth] Waiting for authorization... (${Math.floor((expiresAt - Date.now()) / 1000)}s remaining)`);
      }
      
    } catch (e) {
      console.error(`[poll-oauth] Error: ${e.message}`);
    }
    
    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, interval * 1000));
  }
  
  console.log('[poll-oauth] ❌ Authorization timed out');
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
    if (result.ok) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  })
  .catch(e => {
    console.error(`[poll-oauth] Fatal error: ${e.message}`);
    process.exit(1);
  });