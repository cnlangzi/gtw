/**
 * git.js — Git operations via native git CLI.
 *
 * All git operations are wrappers around the `git` CLI.
 * Uses execGit (spawnSync) internally — no isomorphic-git dependency.
 */
import { execSync as _exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { join, resolve, dirname, basename } from 'path';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'fs';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function findGitRoot(workdir) {
  let dir = resolve(workdir);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    dir = dirname(dir);
  }
  return workdir;
}

/**
 * Execute a git command and return stdout.
 * Throws on non-zero exit.
 */
// git — alias for execGit, used by ConfirmCommand and other legacy callers
export function git(cmd, cwd) {
  return execGit(cmd, cwd);
}

function execGit(cmd, cwd) {
  try {
    return _exec(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    throw new Error(`Git error: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// parseRemoteLine — unchanged
// ---------------------------------------------------------------------------

export function parseRemoteLine(line) {
  if (!line || typeof line !== 'string') {
    throw new Error('Invalid remote line: empty or not a string');
  }
  const clean = line.replace(/\s+\([^)]+\)$/, '').trim();
  const url = clean.replace(/^[^\s]+\s+/, '').trim();
  let owner, repo;
  const sshMatch = url.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    [owner, repo] = [sshMatch[1], sshMatch[2]];
  } else {
    const httpsMatch = url.match(/^(?:https?|ssh):\/\/[^\/]+\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch) {
      [owner, repo] = [httpsMatch[1], httpsMatch[2]];
    } else {
      throw new Error(`Cannot parse remote URL from line: "${line}" → "${url}"`);
    }
  }
  if (!owner || !repo) {
    throw new Error(`Invalid remote: owner="${owner}" repo="${repo}" from "${line}"`);
  }
  return { owner, repo };
}

export function getRemoteRepo(workdir) {
  const remotes = execGit('git remote -v', workdir).split('\n');
  const match = remotes.find((l) => l.includes('origin'));
  if (!match) throw new Error('No origin remote found');
  const { owner, repo } = parseRemoteLine(match);
  return `${owner}/${repo}`;
}

// ---------------------------------------------------------------------------
// currentBranch — async via git CLI
// ---------------------------------------------------------------------------

export async function currentBranch(workdir) {
  return execGit('git branch --show-current', workdir);
}

export { currentBranch as getCurrentBranch };

// ---------------------------------------------------------------------------
// defaultBranch — symbolic-ref or packed-refs
// ---------------------------------------------------------------------------

export function getDefaultBranch(workdir) {
  try {
    const packedRefs = join(findGitRoot(workdir), '.git', 'packed-refs');
    if (existsSync(packedRefs)) {
      const content = readFileSync(packedRefs, 'utf8');
      const m = content.match(/^ref: refs\/remotes\/origin\/HEAD\s+([a-f0-9]+)/);
      if (m) {
        const refsDir = join(findGitRoot(workdir), '.git', 'refs', 'remotes', 'origin');
        const headFile = join(refsDir, 'HEAD');
        if (existsSync(headFile)) {
          const line = readFileSync(headFile, 'utf8').trim();
          const parts = line.split('/');
          return parts[parts.length - 1];
        }
      }
    }
    const symRef = _exec('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: workdir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return symRef.split('/').pop();
  } catch (e) {}
  return 'main';
}

export { getDefaultBranch as defaultBranch, getDefaultBranch as getDefaultBranchSync };

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

export async function fetch(workdir, { remote = 'origin', ref, depth, tags = true } = {}) {
  let cmd = `git fetch ${remote}`;
  if (ref) cmd += ` ${ref}`;
  if (depth) cmd += ` --depth=${depth}`;
  if (!tags) cmd += ` --no-tags`;
  execGit(cmd, workdir);
  return true;
}

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

export async function push(workdir, { remote = 'origin', ref, force = false } = {}) {
  const branch = typeof ref === 'string' ? ref : ref?.ref || await currentBranch(workdir);
  const forceStr = force ? ' -f' : '';
  execGit(`git push${forceStr} ${remote} ${branch}`, workdir);
  return true;
}

// ---------------------------------------------------------------------------
// checkout — async via git CLI
// ---------------------------------------------------------------------------

export async function checkout(workdir, ref, { force = false, remote = 'origin' } = {}) {
  const exists = await existsRef(workdir, ref);
  if (!exists) {
    const trackingRef = `${remote}/${ref}`;
    const trackingExists = await existsRef(workdir, trackingRef);
    if (trackingExists) {
      execGit(`git checkout -B ${ref} -t ${trackingRef}`, workdir);
      return true;
    }
  }
  execGit(`git checkout -B ${ref}`, workdir);
  return true;
}

// ---------------------------------------------------------------------------
// branchExists — sync check using rev-parse (fast)
// ---------------------------------------------------------------------------

export function branchExists(workdir, branchName) {
  try {
    execGit(`git rev-parse --verify ${branchName}`, workdir);
    return true;
  } catch {
    return false;
  }
}

export { branchExists as localBranchExists };

// ---------------------------------------------------------------------------
// existsRef — async check if a ref exists
// ---------------------------------------------------------------------------

export async function existsRef(workdir, ref) {
  try {
    execGit(`git rev-parse --verify ${ref}`, workdir);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// resetHard — sync reset to a ref via execGit
// ---------------------------------------------------------------------------

export async function resetHard(workdir, ref = 'HEAD') {
  execGit(`git reset --hard ${ref}`, workdir);
}

// ---------------------------------------------------------------------------
// log — async commit log
// ---------------------------------------------------------------------------

export async function log(workdir, { ref, depth = 100, since } = {}) {
  let cmd = `git log --oneline -n ${depth}`;
  if (ref) cmd += ` ${ref}`;
  if (since) cmd += ` --since="${since}"`;
  return execGit(cmd, workdir);
}

// ---------------------------------------------------------------------------
// getCommitLogDiff — base..head formatted output (used by PrCommand)
// ---------------------------------------------------------------------------

export function getCommitLogDiff(workdir, headBranch, baseBranch) {
  try {
    return execGit(`git log ${baseBranch}..${headBranch} --oneline --format="%h %s"`, workdir);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// tryCheckoutRemoteBranch — async reimplementation using primitives above
// ---------------------------------------------------------------------------

export async function tryCheckoutRemoteBranch(workdir, branchName) {
  const current = await currentBranch(workdir);

  try {
    await fetch(workdir, { remote: 'origin' });
  } catch {
    return { status: 'not-found', branch: current };
  }

  const remoteRef = `origin/${branchName}`;
  const remoteExists = await existsRef(workdir, remoteRef);

  if (remoteExists) {
    if (current === branchName) {
      await resetHard(workdir, remoteRef);
    } else {
      const localExists = branchExists(workdir, branchName);
      if (localExists) {
        await checkout(workdir, branchName, { force: true });
        await resetHard(workdir, remoteRef);
      } else {
        await checkout(workdir, branchName, { remote: remoteRef });
      }
    }
    return { status: 'remote-synced', branch: branchName };
  }

  const localExists = branchExists(workdir, branchName);
  if (localExists) {
    await checkout(workdir, branchName);
    return { status: 'local-only', branch: branchName };
  }

  return { status: 'not-found', branch: current };
}

// ---------------------------------------------------------------------------
// addAll — stage all changes
// ---------------------------------------------------------------------------

export async function addAll(workdir) {
  execGit('git add .', workdir);
}

// ---------------------------------------------------------------------------
// getStagedFiles — returns list of staged file paths
// ---------------------------------------------------------------------------

export function getStagedFiles(workdir) {
  try {
    const output = execGit('git diff --cached --name-only', workdir);
    return output ? output.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// diffStaged — staged diff output
// ---------------------------------------------------------------------------

export function diffStaged(workdir) {
  try {
    return execGit('git diff --cached', workdir);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// getStagedDiff — unified diff for staged changes
// ---------------------------------------------------------------------------

export function getStagedDiff(workdir) {
  return diffStaged(workdir);
}

// ---------------------------------------------------------------------------
// getStagedStats — stat summary of staged changes
// ---------------------------------------------------------------------------

export function getStagedStats(workdir) {
  try {
    return execGit('git diff --cached --stat', workdir);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// getStagedNumstat — machine-readable staged stats
// ---------------------------------------------------------------------------

export function getStagedNumstat(workdir) {
  try {
    return execGit('git diff --cached --numstat', workdir);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Worktree operations — .git/worktrees filesystem manipulation
// ---------------------------------------------------------------------------

function worktreeDir(workdir) {
  return join(findGitRoot(workdir), '.git', 'worktrees');
}

function validateWorktreeName(name) {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid worktree name: "${name}". Use only alphanumeric, dots, underscores, hyphens.`);
  }
  if (name === 'main' || name === 'master') {
    throw new Error(`Reserved worktree name: "${name}"`);
  }
}

export function worktreeList(workdir) {
  const wtDir = worktreeDir(workdir);
  if (!existsSync(wtDir)) return [];
  const entries = readdirSync(wtDir).filter(n => n !== 'maint');
  const result = [];
  for (const name of entries) {
    const wtPathFile = join(wtDir, name, 'gitdir');
    const wtCommitsFile = join(wtDir, name, 'commits');
    let path = null;
    try {
      const link = readFileSync(wtPathFile, 'utf8').trim();
      path = dirname(link.replace(/\/\.git$/, ''));
    } catch {}
    const head = existsSync(wtCommitsFile)
      ? readFileSync(wtCommitsFile, 'utf8').trim().split('\n')[0]?.split(' ')[1] || null
      : null;
    result.push({ name, path, head });
  }
  return result;
}

export function worktreeAdd(workdir, name, path) {
  validateWorktreeName(name);
  const wtDir = worktreeDir(workdir);
  if (!existsSync(wtDir)) mkdirSync(wtDir, { recursive: true });
  const wtPath = join(wtDir, name);
  if (existsSync(wtPath)) {
    throw new Error(`Worktree "${name}" already exists`);
  }
  mkdirSync(wtPath, { recursive: true });
  writeFileSync(join(wtPath, 'gitdir'), join(path, '.git') + '\n');
  writeFileSync(join(wtPath, 'commits'), `1 ${execGit('git rev-parse HEAD', workdir)}\n`);
  execGit(`git worktree add "${path}" "${name}"`, workdir);
}

export function worktreeRemove(workdir, name) {
  validateWorktreeName(name);
  execGit(`git worktree remove --force "${name}"`, workdir);
}

/**
 * Remove a worktree given its filesystem path (not its .worktrees/ name).
 * Uses git worktree remove --force with the path.
 */
export function worktreeRemoveByPath(worktreePath, gitRoot) {
  if (!worktreePath) return;
  const entryName = worktreePath.includes('/') ? basename(worktreePath) : worktreePath;
  const wtDir = join(gitRoot, '.git', 'worktrees');
  const wtEntry = join(wtDir, entryName);

  // Step 1: try git worktree remove (cleans up both dir AND git registry)
  try {
    execGit(`git worktree remove --force "${worktreePath}"`, gitRoot);
    return;
  } catch {}

  // Step 2: git remove failed — manually clean up registry entry + directory
  if (existsSync(wtEntry)) {
    try { rmSync(wtEntry, { recursive: true, force: true }); } catch {}
  }
  if (existsSync(worktreePath)) {
    try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
  }
  // Step 3: git prune cleans up any other orphaned registry entries
  try { execGit('git worktree prune', gitRoot); } catch {}
}
