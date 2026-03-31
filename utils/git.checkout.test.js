/**
 * Integration tests for tryCheckoutRemoteBranch.
 * Tests the three scenarios: remote exists, local-only, not-found.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We need to test the actual exported function.
// Import it — it uses the internal git() helper from git.js.
import { tryCheckoutRemoteBranch, getCurrentBranch } from './git.js';

function setupBareRepo(name) {
  const dir = mkdtempSync(join(tmpdir(), `gtw-test-${name}-`));
  execSync('git init --bare', { cwd: dir });
  return dir;
}

function setupLocalRepo(name, bareDir) {
  const dir = mkdtempSync(join(tmpdir(), `gtw-test-${name}-`));
  execSync('git init --initial-branch=main', { cwd: dir });
  execSync(`git remote add origin ${bareDir}`, { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  // Create initial commit on main
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8');
  execSync('git add .', { cwd: dir });
  execSync('git commit -m "initial"', { cwd: dir });
  execSync('git push -u origin main', { cwd: dir });
  return dir;
}

describe('tryCheckoutRemoteBranch', () => {
  let bareDir;
  let localDir;

  beforeEach(() => {
    bareDir = setupBareRepo('bare');
    localDir = setupLocalRepo('local', bareDir);
  });

  afterEach(() => {
    try { rmSync(localDir, { recursive: true, force: true }); } catch {}
    try { rmSync(bareDir, { recursive: true, force: true }); } catch {}
  });

  // Scenario: remote exists (simple — create remote branch, call checkout)
  it('returns remote-synced when remote branch exists', () => {
    // Create a remote branch 'fix/test-issue' on origin
    execSync('git fetch origin', { cwd: localDir });
    execSync('git branch fix/test-issue origin/main', { cwd: localDir });
    execSync(`git push origin fix/test-issue`, { cwd: localDir });

    const result = tryCheckoutRemoteBranch(localDir, 'fix/test-issue');

    assert.strictEqual(result.status, 'remote-synced', `expected remote-synced, got ${result.status}`);
    assert.strictEqual(result.branch, 'fix/test-issue');
    // Should be on the branch
    assert.strictEqual(getCurrentBranch(localDir), 'fix/test-issue');
  });

  it('returns local-only when remote branch missing but local exists', () => {
    // Create a local branch but don't push it
    execSync('git checkout -b fix/local-only', { cwd: localDir });
    writeFileSync(join(localDir, 'local.txt'), 'local change\n', 'utf8');
    execSync('git add .', { cwd: localDir });
    execSync('git commit -m "local commit"', { cwd: localDir });

    const result = tryCheckoutRemoteBranch(localDir, 'fix/local-only');

    assert.strictEqual(result.status, 'local-only', `expected local-only, got ${result.status}`);
    assert.strictEqual(result.branch, 'fix/local-only');
    assert.strictEqual(getCurrentBranch(localDir), 'fix/local-only');
  });

  it('returns not-found when neither remote nor local branch exists', () => {
    // Make sure we're on main before the call
    execSync('git checkout main', { cwd: localDir });

    const beforeBranch = getCurrentBranch(localDir);
    const result = tryCheckoutRemoteBranch(localDir, 'fix/does-not-exist');

    assert.strictEqual(result.status, 'not-found', `expected not-found, got ${result.status}`);
    assert.strictEqual(result.branch, beforeBranch);
    // Should stay on current branch
    assert.strictEqual(getCurrentBranch(localDir), beforeBranch);
  });

  it('hard-resets to remote when remote branch exists and local also exists (same name)', () => {
    // Create remote branch via local branch + push, then delete local (avoid tracking)
    execSync('git checkout -b fix/existing', { cwd: localDir });
    execSync('git push origin fix/existing', { cwd: localDir });
    const remoteHead = execSync('git rev-parse origin/fix/existing', { cwd: localDir, encoding: 'utf8' }).trim();
    execSync('git checkout main', { cwd: localDir });
    execSync('git branch -D fix/existing', { cwd: localDir });

    // Create non-tracking local branch with same name but different content
    execSync(`git branch --no-track fix/existing ${remoteHead}`, { cwd: localDir });
    execSync('git checkout fix/existing', { cwd: localDir });
    writeFileSync(join(localDir, 'extra.txt'), 'extra\n', 'utf8');
    execSync('git add .', { cwd: localDir });
    execSync('git commit -m "extra file"', { cwd: localDir });
    const localCommit = execSync('git rev-parse HEAD', { cwd: localDir, encoding: 'utf8' }).trim();

    // Checkout via the function
    const result = tryCheckoutRemoteBranch(localDir, 'fix/existing');

    assert.strictEqual(result.status, 'remote-synced');
    assert.strictEqual(getCurrentBranch(localDir), 'fix/existing');
    // Should have reset to remote tip (no extra.txt)
    const headCommit = execSync('git rev-parse HEAD', { cwd: localDir, encoding: 'utf8' }).trim();
    assert.notStrictEqual(headCommit, localCommit, 'local commit should have been reset');
  });

  it('stays on current branch when already checked out to the target branch (remote exists)', () => {
    // Create remote branch and switch to it
    execSync('git branch fix/currently-on origin/main', { cwd: localDir });
    execSync('git push origin fix/currently-on', { cwd: localDir });
    execSync('git checkout fix/currently-on', { cwd: localDir });
    writeFileSync(join(localDir, 'newfile.txt'), 'on branch\n', 'utf8');
    execSync('git add .', { cwd: localDir });
    execSync('git commit -m "on branch commit"', { cwd: localDir });

    const result = tryCheckoutRemoteBranch(localDir, 'fix/currently-on');

    assert.strictEqual(result.status, 'remote-synced');
    assert.strictEqual(result.branch, 'fix/currently-on');
    // Should still be on the same branch
    assert.strictEqual(getCurrentBranch(localDir), 'fix/currently-on');
  });
});

describe('tryCheckoutRemoteBranch — no-arg PR branch selection', () => {
  // This is implicitly tested by the PrCommand behavior:
  // /gtw pr (no args) calls getCurrentBranch() directly — no wip.json access.
  // The fix verifies PrCommand.execute([]) uses current branch.
  it('getCurrentBranch returns current branch name', () => {
    // This test validates the helper used by no-arg PR
    const bare = setupBareRepo('nobare');
    const local = setupLocalRepo('nolocal', bare);
    try {
      const branch = getCurrentBranch(local);
      assert.strictEqual(branch, 'main');
    } finally {
      try { rmSync(local, { recursive: true, force: true }); } catch {}
      try { rmSync(bare, { recursive: true, force: true }); } catch {}
    }
  });
});
