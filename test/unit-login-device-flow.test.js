/**
 * Unit tests for GitHubClient device code flow
 *
 * Tests cover:
 * 1. GitHubClient class instantiation
 * 2. Device code request
 * 3. Token validation
 *
 * Note: Network calls to GitHub API are mocked via a lightweight
 * in-process httpsRequest stub to ensure tests run reliably offline.
 */

import { strict as assert } from 'assert';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Set GTW_CONFIG_DIR before importing config-dependent modules
process.env.GTW_CONFIG_DIR = join(homedir(), '.gtw');
const { GitHubClient, httpsRequest: originalHttpsRequest, setHttpsRequest } = await import('../utils/github.js');
const { TOKEN_FILE } = await import('../utils/config.js');

// ---------------------------------------------------------------------------
// Mock httpsRequest to intercept GitHub API calls during tests
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} URL → mock response override */
const mockOverrides = new Map();

/**
 * Mocked httpsRequest that intercepts known GitHub API endpoints.
 * Falls back to the real implementation for un-mocked URLs.
 */
async function mockHttpsRequest(method, url, headers = {}, body = null) {
  if (mockOverrides.has(url)) {
    return mockOverrides.get(url);
  }
  return originalHttpsRequest(method, url, headers, body);
}

/**
 * Install URL-specific response mocks.
 * @param {string} url   - Full URL to intercept (e.g. 'https://api.github.com/user')
 * @param {object} reply  - Response to return: { status, data }
 */
function mockUrl(url, reply) {
  mockOverrides.set(url, reply);
}

/**
 * Clear all URL mocks and restore the real httpsRequest.
 */
function restoreMock() {
  mockOverrides.clear();
  setHttpsRequest(originalHttpsRequest);
}

// Install the mock immediately so all subsequent code uses it.
setHttpsRequest(mockHttpsRequest);

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
  // Mock GitHub API /user endpoint to return 401 Unauthorized
  mockUrl('https://api.github.com/user', {
    status: 401,
    data: { message: 'Bad credentials' },
  });
  const client = new GitHubClient('invalid_token_xyz');
  const isValid = await client.validateToken();
  assert.strictEqual(isValid, false, 'Invalid token should return false');
  // Clean up mock so subsequent tests aren't affected
  mockOverrides.delete('https://api.github.com/user');
});

// Test 5: validateToken accepts valid cached token (mocked)
await asyncTest('GitHubClient.validateToken accepts valid cached token', async () => {
  // Mock GitHub API /user endpoint to return 200 OK with a fake user
  mockUrl('https://api.github.com/user', {
    status: 200,
    data: {
      login: 'testuser',
      id: 12345,
      name: 'Test User',
    },
  });
  const client = new GitHubClient('valid_mock_token_abc123');
  const isValid = await client.validateToken();
  assert.strictEqual(isValid, true, 'Valid token should return true');
  // Clean up mock
  mockOverrides.delete('https://api.github.com/user');
});

// Summary
console.log('\n' + '='.repeat(60));
console.log(`Tests completed: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
