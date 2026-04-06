/**
 * Unit tests for getValidToken() behavior
 *
 * getValidToken() only reads from token.json cache.
 */

import { strict as assert } from 'assert';
import { rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Set GTW_CONFIG_DIR before importing config-dependent modules
process.env.GTW_CONFIG_DIR = join(homedir(), '.gtw');
const { getValidToken, readJSON, writeJSON } = await import('../utils/api.js');
const { TOKEN_FILE } = await import('../utils/config.js');

console.log('🧪 Testing getValidToken()\n');

let passed = 0;
let failed = 0;

async function test(name, fn) {
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

// Cleanup before each test
rmSync(TOKEN_FILE, { force: true });

// Test 1: throws when no token file exists
await test('Throws when token.json missing', async () => {
  let err;
  try {
    await getValidToken();
  } catch (e) {
    err = e;
  }
  assert(err instanceof Error, 'Should throw Error');
  assert(err.message.includes('/gtw login'), 'Error should suggest login');
});

// Test 2: returns token from token.json
await test('Returns token from token.json', async () => {
  writeJSON(TOKEN_FILE, {
    source: 'oauth',
    access_token: 'test_token_12345',
    created_at: new Date().toISOString(),
  });
  const token = await getValidToken();
  assert.strictEqual(token, 'test_token_12345');
});

// Test 3: error message is actionable
await test('Error message is actionable', async () => {
  rmSync(TOKEN_FILE, { force: true });
  let err;
  try {
    await getValidToken();
  } catch (e) {
    err = e;
  }
  assert(err instanceof Error, 'Should throw Error');
  assert(err.message.includes('/gtw login'), `Got: ${err.message}`);
});

console.log('\n' + '='.repeat(60));
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
