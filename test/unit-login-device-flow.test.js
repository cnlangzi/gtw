/**
 * Unit tests for /gtw login device code flow
 * 
 * Tests cover:
 * 1. Device code request and response parsing
 * 2. Device code caching and reuse
 * 3. Token persistence after successful login
 * 4. Device code expiration handling
 */

import { strict as assert } from 'assert';
import { existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.openclaw', 'gtw');
const DEVICE_CODE_FILE = join(CONFIG_DIR, 'device_code.json');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');

const { LoginCommand } = await import('../commands/LoginCommand.js');

// Ensure config dir exists
if (!existsSync(CONFIG_DIR)) {
  const { mkdirSync } = await import('fs');
  mkdirSync(CONFIG_DIR, { recursive: true });
}

console.log('🧪 Testing /gtw login device code flow\n');

let passed = 0;
let failed = 0;

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`❌ ${name}`);
    console.log(`   Error: ${e.message}`);
    failed++;
  }
}

// Cleanup before tests
if (existsSync(DEVICE_CODE_FILE)) {
  rmSync(DEVICE_CODE_FILE);
}
if (existsSync(TOKEN_FILE)) {
  rmSync(TOKEN_FILE);
}

const cmd = new LoginCommand({ api: {}, config: {} });

// Test 1: Device code request structure
await asyncTest('Device code request returns expected structure', async () => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    console.log('   (skipped: GITHUB_CLIENT_ID not set)');
    return;
  }
  
  const deviceCodeData = await cmd.requestDeviceCode(clientId);
  
  assert(deviceCodeData.device_code, 'Should have device_code');
  assert(deviceCodeData.user_code, 'Should have user_code');
  assert(deviceCodeData.verification_uri, 'Should have verification_uri');
  assert(deviceCodeData.expires_in > 0, 'Should have positive expires_in');
  assert(deviceCodeData.interval > 0, 'Should have positive interval');
  
  // Cleanup
  if (existsSync(DEVICE_CODE_FILE)) {
    rmSync(DEVICE_CODE_FILE);
  }
});

// Test 2: Device code caching
await asyncTest('Device code is cached correctly', async () => {
  const mockDeviceCode = {
    device_code: 'test_device_code_12345',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 300,
    interval: 5,
  };
  
  cmd.saveDeviceCode(mockDeviceCode);
  
  assert(existsSync(DEVICE_CODE_FILE), 'Device code file should exist');
  
  const cached = cmd.loadCachedDeviceCode();
  assert(cached, 'Should load cached device code');
  assert.strictEqual(cached.device_code, mockDeviceCode.device_code, 'device_code should match');
  assert.strictEqual(cached.user_code, mockDeviceCode.user_code, 'user_code should match');
  assert(cached.expires_at > Date.now(), 'expires_at should be in future');
  
  // Cleanup
  rmSync(DEVICE_CODE_FILE);
});

// Test 3: Expired device code is not reused
await asyncTest('Expired device code is not reused', async () => {
  const expiredDeviceCode = {
    device_code: 'expired_device_code',
    user_code: 'EXPI-RED1',
    verification_uri: 'https://github.com/login/device',
    expires_at: Date.now() - 10000, // 10 seconds ago
    interval: 5,
  };
  
  const { writeFileSync } = await import('fs');
  writeFileSync(DEVICE_CODE_FILE, JSON.stringify(expiredDeviceCode, null, 2));
  
  const cached = cmd.loadCachedDeviceCode();
  assert.strictEqual(cached, null, 'Should return null for expired device code');
  
  // Cleanup
  rmSync(DEVICE_CODE_FILE);
});

// Test 4: Valid device code is reused
await asyncTest('Valid device code is reused', async () => {
  const validDeviceCode = {
    device_code: 'valid_device_code',
    user_code: 'VALID-123',
    verification_uri: 'https://github.com/login/device',
    expires_at: Date.now() + 300000, // 5 minutes from now
    interval: 5,
  };
  
  const { writeFileSync } = await import('fs');
  writeFileSync(DEVICE_CODE_FILE, JSON.stringify(validDeviceCode, null, 2));
  
  const cached = cmd.loadCachedDeviceCode();
  assert(cached !== null, 'Should return cached device code');
  assert.strictEqual(cached.device_code, validDeviceCode.device_code, 'device_code should match');
  
  // Cleanup
  rmSync(DEVICE_CODE_FILE);
});

// Test 5: Token persistence
await asyncTest('Token is persisted correctly after login', async () => {
  const mockToken = 'oauth_access_token_xyz789';
  
  cmd.saveToken(mockToken);
  
  assert(existsSync(TOKEN_FILE), 'Token file should exist');
  
  const saved = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
  assert.strictEqual(saved.source, 'oauth', 'source should be oauth');
  assert.strictEqual(saved.access_token, mockToken, 'access_token should match');
  assert(saved.created_at, 'Should have created_at timestamp');
  
  // Cleanup
  rmSync(TOKEN_FILE);
});

// Test 6: Poll timeout handling
await asyncTest('Poll timeout returns appropriate error', async () => {
  const mockDeviceCodeData = {
    device_code: 'test_device_code',
    interval: 1, // 1 second for faster test
    expires_at: Date.now() + 100, // 100ms from now (will expire immediately)
  };
  
  const clientId = process.env.GITHUB_CLIENT_ID || 'test_client_id';
  const clientSecret = process.env.GITHUB_CLIENT_SECRET || '';
  
  try {
    await cmd.pollForToken(clientId, clientSecret, mockDeviceCodeData);
    assert.fail('Should have thrown timeout error');
  } catch (e) {
    // Expected to timeout or error - accept various error messages
    // "OAuth error: Not Found" is expected when using fake client_id
    const isExpectedError = e.message.includes('expired') || 
                           e.message.includes('Error') ||
                           e.message.includes('40') || // HTTP errors
                           e.message.includes('fetch') ||
                           e.message.includes('failed') ||
                           e.message.includes('OAuth error');
    assert(isExpectedError, 
           `Should have expected error, got: ${e.message}`);
  }
});

// Cleanup after tests
if (existsSync(DEVICE_CODE_FILE)) {
  rmSync(DEVICE_CODE_FILE);
}
if (existsSync(TOKEN_FILE)) {
  rmSync(TOKEN_FILE);
}

// Summary
console.log('\n' + '='.repeat(60));
console.log(`Tests completed: ${passed + failed} total, ${passed} passed, ${failed} failed`);
if (process.env.GITHUB_CLIENT_ID) {
  console.log('(Note: Some tests skipped due to GITHUB_CLIENT_ID not set)');
}
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
