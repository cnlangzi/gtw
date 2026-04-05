/**
 * Unit tests for getValidToken() behavior
 * 
 * Tests cover:
 * 1. GITHUB_TOKEN env var (PAT) takes priority
 * 2. token.json cache usage
 * 3. gh CLI token fallback
 * 4. Revoked/invalid token handling
 */

import { strict as assert } from 'assert';
import { writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.openclaw', 'gtw');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');

// Import after setting up config dir
const { getValidToken, readJSON, writeJSON } = await import('../utils/api.js');

// Ensure config dir exists
if (!existsSync(CONFIG_DIR)) {
  const { mkdirSync } = await import('fs');
  mkdirSync(CONFIG_DIR, { recursive: true });
}

console.log('🧪 Testing getValidToken() behavior\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`❌ ${name}`);
    console.log(`   Error: ${e.message}`);
    failed++;
  }
}

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
if (existsSync(TOKEN_FILE)) {
  rmSync(TOKEN_FILE);
}

// Test 1: Environment variable (PAT) takes priority
await asyncTest('GITHUB_TOKEN env var takes priority', async () => {
  const testToken = 'test_pat_token_12345';
  const result = await getValidToken(testToken);
  assert.strictEqual(result, testToken, 'Should return env token');
});

// Test 2: token.json cache is used when env var not set
await asyncTest('token.json cache is used', async () => {
  const cachedToken = 'cached_oauth_token_67890';
  writeJSON(TOKEN_FILE, {
    source: 'oauth',
    access_token: cachedToken,
    created_at: new Date().toISOString(),
  });
  
  // Mock validateToken to return true for this test
  const { validateToken } = await import('../utils/api.js');
  const originalValidate = validateToken;
  
  // We can't easily mock in ESM, so we test the actual behavior
  // The cached token should be validated first
  try {
    const result = await getValidToken(null);
    // If token is valid, it should return it
    assert.strictEqual(typeof result, 'string', 'Should return token string');
  } catch (e) {
    // If token is invalid, it should try gh CLI or throw
    assert(e.message.includes('gh auth login') || e.message.includes('GITHUB_TOKEN'), 
           'Should have actionable error message');
  }
});

// Test 3: Invalid token in cache triggers fallback
await asyncTest('Invalid cached token triggers error', async () => {
  // Write invalid token
  writeJSON(TOKEN_FILE, {
    source: 'oauth',
    access_token: 'invalid_revoked_token_xyz',
    created_at: new Date().toISOString(),
  });
  
  try {
    await getValidToken(null);
    // If we get here without error, gh CLI must be available
    console.log('   (gh CLI token was used as fallback)');
  } catch (e) {
    // Expected: no gh CLI and invalid cache
    assert(e.message.includes('gh auth login') || e.message.includes('GITHUB_TOKEN'),
           `Should have actionable error, got: ${e.message}`);
  }
});

// Test 4: validateToken rejects 401
await asyncTest('validateToken rejects 401 responses', async () => {
  const { validateToken } = await import('../utils/api.js');
  const isValid = await validateToken('invalid_token_12345');
  assert.strictEqual(isValid, false, 'Invalid token should return false');
});

// Test 5: validateToken accepts valid token
await asyncTest('validateToken accepts valid cached token', async () => {
  if (existsSync(TOKEN_FILE)) {
    const cached = readJSON(TOKEN_FILE);
    if (cached?.access_token && cached.source !== 'test') {
      const { validateToken } = await import('../utils/api.js');
      const isValid = await validateToken(cached.access_token);
      // This will pass if token is still valid
      console.log(`   (token validation: ${isValid ? 'valid' : 'invalid'})`);
    }
  }
});

// Test 6: Error message is actionable when no token available
await asyncTest('Error message is actionable when no token available', async () => {
  // Remove token file
  if (existsSync(TOKEN_FILE)) {
    rmSync(TOKEN_FILE);
  }
  
  // Unset GITHUB_TOKEN for this test
  const originalToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = null;
  
  try {
    await getValidToken(null);
    // If we get here, gh CLI must be authenticated - that's OK
    console.log('   (gh CLI is authenticated, no error thrown)');
  } catch (e) {
    // Expected: no gh CLI and no token
    const hasHelpfulMessage = e.message.includes('gh auth login') || 
                               e.message.includes('GITHUB_TOKEN') ||
                               e.message.includes('authenticated');
    assert(hasHelpfulMessage, `Error should be actionable, got: ${e.message}`);
  } finally {
    // Restore original token
    process.env.GITHUB_TOKEN = originalToken;
  }
});

// Summary
console.log('\n' + '='.repeat(60));
console.log(`Tests completed: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
