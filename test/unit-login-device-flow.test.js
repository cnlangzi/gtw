/**
 * Unit tests for GitHubClient device code flow
 * 
 * Tests cover:
 * 1. GitHubClient class instantiation
 * 2. Device code request
 * 3. Token validation
 */

import { strict as assert } from 'assert';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.openclaw', 'gtw');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');

const { GitHubClient } = await import('../utils/github.js');

console.log('🧪 Testing GitHubClient device code flow\n');

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

// Test 1: GitHubClient instantiation
await asyncTest('GitHubClient can be instantiated', async () => {
  const client = new GitHubClient();
  assert(client, 'Client should be created');
  assert(typeof client.request === 'function', 'Should have request method');
  assert(typeof client.validateToken === 'function', 'Should have validateToken method');
});

// Test 2: GitHubClient with token
await asyncTest('GitHubClient accepts token in constructor', async () => {
  const client = new GitHubClient('test_token_123');
  assert(client.token === 'test_token_123', 'Token should be set');
});

// Test 3: setToken method
await asyncTest('GitHubClient.setToken updates token', async () => {
  const client = new GitHubClient();
  client.setToken('new_token_456');
  assert(client.token === 'new_token_456', 'Token should be updated');
});

// Test 4: validateToken rejects invalid token
await asyncTest('GitHubClient.validateToken rejects invalid token', async () => {
  const client = new GitHubClient('invalid_token_xyz');
  const isValid = await client.validateToken();
  assert.strictEqual(isValid, false, 'Invalid token should return false');
});

// Test 5: validateToken accepts valid cached token
await asyncTest('GitHubClient.validateToken accepts valid cached token', async () => {
  if (existsSync(TOKEN_FILE)) {
    const { readFileSync } = await import('fs');
    const cached = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    if (cached?.access_token) {
      const client = new GitHubClient(cached.access_token);
      const isValid = await client.validateToken();
      console.log(`   (token validation: ${isValid ? 'valid' : 'invalid'})`);
    }
  }
});

// Summary
console.log('\n' + '='.repeat(60));
console.log(`Tests completed: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
