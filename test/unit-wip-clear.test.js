/**
 * Unit tests for WIP clear behavior consistency
 * 
 * Tests cover:
 * 1. utils/wip.js clearWip() preserves workdir/repo/createdAt
 * 2. scripts/index.js clearWip() has same behavior (source code verification)
 * 3. ESM and CJS implementations match
 */

import { strict as assert } from 'assert';
import { existsSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.openclaw', 'gtw');
const WIP_FILE = join(CONFIG_DIR, 'wip.json');

const { getWip, saveWip, clearWip } = await import('../utils/wip.js');

// Ensure config dir exists
if (!existsSync(CONFIG_DIR)) {
  const { mkdirSync } = await import('fs');
  mkdirSync(CONFIG_DIR, { recursive: true });
}

console.log('🧪 Testing WIP clear behavior consistency\n');

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

// Cleanup before tests
if (existsSync(WIP_FILE)) {
  rmSync(WIP_FILE);
}

// Test 1: clearWip preserves workdir/repo/createdAt
test('clearWip preserves workdir, repo, and createdAt', () => {
  const testWip = {
    workdir: '/Users/bin/code/test-repo',
    repo: 'test/repo',
    createdAt: '2026-04-01T00:00:00.000Z',
    issue: { action: 'create', title: 'Test' },
    pendingPr: { headBranch: 'fix/test' },
    updatedAt: '2026-04-01T00:00:00.000Z',
  };
  
  saveWip(testWip);
  clearWip();
  const afterClear = getWip();
  
  assert.strictEqual(afterClear.workdir, testWip.workdir, 'workdir should be preserved');
  assert.strictEqual(afterClear.repo, testWip.repo, 'repo should be preserved');
  assert.strictEqual(afterClear.createdAt, testWip.createdAt, 'createdAt should be preserved');
  assert.strictEqual(afterClear.issue, undefined, 'issue should be cleared');
  assert.strictEqual(afterClear.pendingPr, undefined, 'pendingPr should be cleared');
  assert.strictEqual(afterClear.updatedAt, undefined, 'updatedAt should be cleared');
});

// Test 2: clearWip works on empty wip.json
test('clearWip handles empty wip.json gracefully', () => {
  saveWip({});
  clearWip();
  const afterClear = getWip();
  assert.deepStrictEqual(afterClear, {}, 'Should handle empty object');
});

// Test 3: clearWip works when wip.json doesn't exist
test('clearWip handles missing wip.json gracefully', () => {
  if (existsSync(WIP_FILE)) {
    rmSync(WIP_FILE);
  }
  // Should not throw
  clearWip();
  assert.strictEqual(existsSync(WIP_FILE), false, 'Should not create file if not exists');
});

// Test 4: scripts/index.js has consistent implementation
test('scripts/index.js clearWip() implementation is consistent', () => {
  const indexContent = readFileSync('./scripts/index.js', 'utf8');
  
  // Should preserve workdir/repo/createdAt
  const hasPreserveLogic = indexContent.includes('const { workdir, repo, createdAt } = wip') &&
                           indexContent.includes('writeJSON(wip_FILE, { workdir, repo, createdAt })');
  
  // Should NOT delete the file
  const doesNotDelete = !indexContent.includes('fs.unlinkSync(wip_FILE)') &&
                        !indexContent.includes('unlinkSync(wip_FILE)');
  
  assert(hasPreserveLogic, 'Should preserve workdir/repo/createdAt');
  assert(doesNotDelete, 'Should not delete wip.json file');
});

// Test 5: wip.json file is not deleted after clear
test('wip.json file exists after clearWip', () => {
  const testWip = {
    workdir: '/test',
    repo: 'test/repo',
    createdAt: '2026-04-01T00:00:00.000Z',
    issue: { title: 'Test' },
  };
  
  saveWip(testWip);
  assert(existsSync(WIP_FILE), 'File should exist before clear');
  
  clearWip();
  assert(existsSync(WIP_FILE), 'File should still exist after clear');
  
  const afterClear = getWip();
  assert(afterClear.workdir !== undefined, 'workdir should be preserved in file');
});

// Test 6: Multiple clearWip calls are idempotent
test('clearWip is idempotent', () => {
  const testWip = {
    workdir: '/test',
    repo: 'test/repo',
    createdAt: '2026-04-01T00:00:00.000Z',
    issue: { title: 'Test' },
  };
  
  saveWip(testWip);
  clearWip();
  const first = getWip();
  
  clearWip();
  const second = getWip();
  
  assert.deepStrictEqual(first, second, 'Multiple clears should produce same result');
});

// Cleanup after tests
if (existsSync(WIP_FILE)) {
  rmSync(WIP_FILE);
}

// Summary
console.log('\n' + '='.repeat(60));
console.log(`Tests completed: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
