/**
 * Unit tests for CheckoutCommand (formerly SyncCommand).
 * Run: node --test commands/SyncCommand.test.js
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { CheckoutCommand } from './CheckoutCommand.js';
import { getWip, saveWip, clearWip } from '../utils/wip.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { exec } from '../utils/exec.js';

// ---------------------------------------------------------------------------
// Fixtures — real bare git repos for integration testing
// ---------------------------------------------------------------------------

const REPOS = join(tmpdir(), 'gtw-sync-test');
const REPO_A = join(REPOS, 'repo-a');   // remote (bare)
const REPO_W = join(REPOS, 'repo-w');   // worktree (clone)

function setupRemote(name) {
  exec(`git init --bare ${name}`, { stdio: 'pipe' });
  // Bootstrap: init a real repo, push to bare to have real refs
  const bootstrap = join(tmpdir(), `gtw-bootstrap-${Date.now()}`);
  mkdirSync(bootstrap);
  exec(`git init`, { cwd: bootstrap, stdio: 'pipe' });
  exec(`git config user.email "test@gtw"`, { cwd: bootstrap, stdio: 'pipe' });
  exec(`git config user.name "GTW Test"`, { cwd: bootstrap, stdio: 'pipe' });
  writeFileSync(join(bootstrap, 'f'), 'first commit\n');
  exec(`git add .`, { cwd: bootstrap, stdio: 'pipe' });
  exec(`git commit -m "init"`, { cwd: bootstrap, stdio: 'pipe' });
  exec(`git remote add origin ${name}`, { cwd: bootstrap, stdio: 'pipe' });
  exec(`git push origin main`, { cwd: bootstrap, stdio: 'pipe' });
  rmSync(bootstrap, { recursive: true, force: true });
}

function cloneRemote(remote, worktree) {
  exec(`git clone ${remote} ${worktree}`, { stdio: 'pipe' });
  exec(`git config user.email "test@gtw"`, { cwd: worktree, stdio: 'pipe' });
  exec(`git config user.name "GTW Test"`, { cwd: worktree, stdio: 'pipe' });
}

function commitOnBranch(worktree, branch, filename, content) {
  exec(`git checkout ${branch}`, { cwd: worktree, stdio: 'pipe' });
  writeFileSync(join(worktree, filename), content);
  exec(`git add .`, { cwd: worktree, stdio: 'pipe' });
  exec(`git commit -m "commit ${filename}"`, { cwd: worktree, stdio: 'pipe' });
  exec(`git push origin ${branch}`, { cwd: worktree, stdio: 'pipe' });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  rmSync(REPOS, { recursive: true, force: true });
  mkdirSync(REPOS, { recursive: true });
  setupRemote(REPO_A);
  cloneRemote(REPO_A, REPO_W);
  // Set wip to our test worktree
  saveWip({ workdir: REPO_W });
});

afterEach(() => {
  rmSync(REPOS, { recursive: true, force: true });
  clearWip();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CheckoutCommand', () => {
  it('sync current branch — no args — pulls latest on current branch', async () => {
    commitOnBranch(REPO_W, 'main', 'f1', 'v2\n');

    const cmd = new SyncCommand({ api: {}, config: {}, sessionKey: 'test' });
    const result = await cmd.execute([]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.branch, 'main');
    assert.ok(result.message.includes('Synced'));
    assert.ok(existsSync(join(REPO_W, 'f1')));
  });

  it('sync specific branch — checks out and pulls remote branch', async () => {
    exec(`git checkout -b feat`, { cwd: REPO_W, stdio: 'pipe' });
    writeFileSync(join(REPO_W, 'featfile'), 'feat content\n');
    exec(`git add .`, { cwd: REPO_W, stdio: 'pipe' });
    exec(`git commit -m "feat commit"`, { cwd: REPO_W, stdio: 'pipe' });
    exec(`git push origin feat`, { cwd: REPO_W, stdio: 'pipe' });

    const cmd = new SyncCommand({ api: {}, config: {}, sessionKey: 'test' });
    const result = await cmd.execute(['feat']);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.branch, 'feat');
    assert.ok(existsSync(join(REPO_W, 'featfile')));
  });

  it('sync specific branch — resets existing local branch to origin', async () => {
    // Set up: reset-test branch has "old.txt" on both local and origin,
    // but origin has an additional "new.txt" that local doesn't.
    // After sync, local should match origin (gaining new.txt, keeping old.txt).
    exec(`git checkout -b reset-test`, { cwd: REPO_W, stdio: 'pipe' });
    writeFileSync(join(REPO_W, 'old.txt'), 'old content\n');
    exec(`git add old.txt`, { cwd: REPO_W, stdio: 'pipe' });
    exec(`git commit -m "old commit"`, { cwd: REPO_W, stdio: 'pipe' });
    exec(`git push origin reset-test`, { cwd: REPO_W, stdio: 'pipe' });

    // Advance origin/reset-test with an extra file (via temp clone to keep REPO_W clean)
    const tempClone = join(REPOS, 'temp-push');
    exec(`git clone ${REPO_A} ${tempClone}`, { stdio: 'pipe' });
    exec(`git config user.email "test@gtw"`, { cwd: tempClone, stdio: 'pipe' });
    exec(`git config user.name "GTW Test"`, { cwd: tempClone, stdio: 'pipe' });
    exec(`git checkout reset-test`, { cwd: tempClone, stdio: 'pipe' });
    writeFileSync(join(tempClone, 'new.txt'), 'new content\n');
    exec(`git add new.txt`, { cwd: tempClone, stdio: 'pipe' });
    exec(`git commit -m "new commit on origin"`, { cwd: tempClone, stdio: 'pipe' });
    exec(`git push origin reset-test`, { cwd: tempClone, stdio: 'pipe' });
    rmSync(tempClone, { recursive: true, force: true });

    // REPO_W is still on old commit (no new.txt)
    assert.ok(!existsSync(join(REPO_W, 'new.txt')), 'precondition: new.txt not local yet');

    // Sync reset-test — checkout -B should advance local to origin/reset-test
    const cmd = new SyncCommand({ api: {}, config: {}, sessionKey: 'test' });
    const result = await cmd.execute(['reset-test']);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.branch, 'reset-test');
    // After sync, new.txt should exist locally (fetched from origin)
    assert.ok(existsSync(join(REPO_W, 'new.txt')), 'new.txt should appear after sync');
    assert.ok(existsSync(join(REPO_W, 'old.txt')), 'old.txt should still exist');
  });

  it('sync fails when remote branch does not exist', async () => {
    const cmd = new SyncCommand({ api: {}, config: {}, sessionKey: 'test' });
    const result = await cmd.execute(['nonexistent-branch']);

    assert.strictEqual(result.ok, false);
    assert.ok(result.message.includes('does not exist') || result.message.includes('not find'));
  });

  it('sync fails when no workdir is set', async () => {
    // Override wip to empty before running
    const { saveWip } = await import('../utils/wip.js');
    saveWip({});
    const cmd = new SyncCommand({ api: {}, config: {}, sessionKey: 'test' });
    const result = await cmd.execute([]);
    assert.strictEqual(result.ok, false);
    assert.ok(result.message.includes('No workdir'));
  });
});
