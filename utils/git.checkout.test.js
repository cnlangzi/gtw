/**
 * Integration tests for tryCheckoutRemoteBranch.
 * Tests the three scenarios: remote exists, local-only, not-found.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync as _spawn } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Git command runner — array-style args avoid shell injection
function git(args, cwd) {
  const result = _spawn('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Git ${args[0]} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

// We need to test the actual exported function.
// Import it — it uses the internal git() helper from git.js.
import { tryCheckoutRemoteBranch, currentBranch as getCurrentBranch } from './git.js';

function setupBareRepo(name) {
  const dir = mkdtempSync(join(tmpdir(), `gtw-test-${name}-`));
  git(['init', '--bare'], dir);
  return dir;
}

function setupLocalRepo(name, bareDir) {
  const dir = mkdtempSync(join(tmpdir(), `gtw-test-${name}-`));
  git(['init', '--initial-branch=main'], dir);
  git(['remote', 'add', 'origin', bareDir], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  // Create initial commit on main
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8');
  git(['add', '.'], dir);
  git(['commit', '-m', 'initial'], dir);
  git(['push', '-u', 'origin', 'main'], dir);
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
  it('returns remote-synced when remote branch exists', async () => {
    // Create a remote branch 'fix/test-issue' on origin
    git(['fetch', 'origin'], localDir);
    git(['branch', 'fix/test-issue', 'origin/main'], localDir);
    git(['push', 'origin', 'fix/test-issue'], localDir);

    const result = await tryCheckoutRemoteBranch(localDir, 'fix/test-issue');

    assert.strictEqual(result.status, 'remote-synced', `expected remote-synced, got ${result.status}`);
    assert.strictEqual(result.branch, 'fix/test-issue');
    // Should be on the branch
    assert.strictEqual(await getCurrentBranch(localDir), 'fix/test-issue');
  });

  it('returns local-only when remote branch missing but local exists', async () => {
    // Create a local branch but don't push it
    git(['checkout', '-b', 'fix/local-only'], localDir);
    writeFileSync(join(localDir, 'local.txt'), 'local change\n', 'utf8');
    git(['add', '.'], localDir);
    git(['commit', '-m', 'local commit'], localDir);

    const result = await tryCheckoutRemoteBranch(localDir, 'fix/local-only');

    assert.strictEqual(result.status, 'local-only', `expected local-only, got ${result.status}`);
    assert.strictEqual(result.branch, 'fix/local-only');
    assert.strictEqual(await getCurrentBranch(localDir), 'fix/local-only');
  });

  it('returns not-found when neither remote nor local branch exists', async () => {
    // Make sure we're on main before the call
    git(['checkout', 'main'], localDir);

    const beforeBranch = await getCurrentBranch(localDir);
    const result = await tryCheckoutRemoteBranch(localDir, 'fix/does-not-exist');

    assert.strictEqual(result.status, 'not-found', `expected not-found, got ${result.status}`);
    assert.strictEqual(result.branch, beforeBranch);
    // Should stay on current branch
    assert.strictEqual(await getCurrentBranch(localDir), beforeBranch);
  });

  it('hard-resets to remote when remote branch exists and local also exists (same name)', async () => {
    // Create remote branch via local branch + push, then delete local (avoid tracking)
    git(['checkout', '-b', 'fix/existing'], localDir);
    git(['push', 'origin', 'fix/existing'], localDir);
    const remoteHead = git(['rev-parse', 'origin/fix/existing'], localDir);
    git(['checkout', 'main'], localDir);
    git(['branch', '-D', 'fix/existing'], localDir);

    // Create non-tracking local branch with same name but different content
    git(['branch', '--no-track', 'fix/existing', remoteHead], localDir);
    git(['checkout', 'fix/existing'], localDir);
    writeFileSync(join(localDir, 'extra.txt'), 'extra\n', 'utf8');
    git(['add', '.'], localDir);
    git(['commit', '-m', 'extra file'], localDir);
    const localCommit = git(['rev-parse', 'HEAD'], localDir);

    // Checkout via the function
    const result = await tryCheckoutRemoteBranch(localDir, 'fix/existing');

    assert.strictEqual(result.status, 'remote-synced');
    assert.strictEqual(await getCurrentBranch(localDir), 'fix/existing');
    // Should have reset to remote tip (no extra.txt)
    const headCommit = git(['rev-parse', 'HEAD'], localDir);
    assert.notStrictEqual(headCommit, localCommit, 'local commit should have been reset');
  });

  it('stays on current branch when already checked out to the target branch (remote exists)', async () => {
    // Create remote branch and switch to it
    git(['branch', 'fix/currently-on', 'origin/main'], localDir);
    git(['push', 'origin', 'fix/currently-on'], localDir);
    git(['checkout', 'fix/currently-on'], localDir);
    writeFileSync(join(localDir, 'newfile.txt'), 'on branch\n', 'utf8');
    git(['add', '.'], localDir);
    git(['commit', '-m', 'on branch commit'], localDir);

    const result = await tryCheckoutRemoteBranch(localDir, 'fix/currently-on');

    assert.strictEqual(result.status, 'remote-synced');
    assert.strictEqual(result.branch, 'fix/currently-on');
    // Should still be on the same branch
    assert.strictEqual(await getCurrentBranch(localDir), 'fix/currently-on');
  });
});

describe('tryCheckoutRemoteBranch — no-arg PR branch selection', () => {
  // This is implicitly tested by the PrCommand behavior:
  // /gtw pr (no args) calls currentBranch() directly — no wip.json access.
  // The fix verifies PrCommand.execute([]) uses current branch.
  it('getCurrentBranch returns current branch name', async () => {
    // This test validates the helper used by no-arg PR
    const bare = setupBareRepo('nobare');
    const local = setupLocalRepo('nolocal', bare);
    try {
      const branch = await getCurrentBranch(local);
      assert.strictEqual(branch, 'main');
    } finally {
      try { rmSync(local, { recursive: true, force: true }); } catch {}
      try { rmSync(bare, { recursive: true, force: true }); } catch {}
    }
  });
});
