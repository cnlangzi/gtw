import * as isoGit from 'isomorphic-git';
import { Buffer } from 'buffer';
import { execSync as _exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { join, resolve, dirname } from 'path';
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

async function runGit(fn, workdir, opts = {}) {
  const gitdir = join(findGitRoot(workdir), '.git');
  return fn({ fs, dir: workdir, gitdir, ...opts });
}

function runGitSync(fn, workdir, ...args) {
  const gitdir = join(findGitRoot(workdir), '.git');
  return fn({ fs, dir: workdir, gitdir, ...args });
}

function execGit(cmd, cwd) {
  try {
    return _exec(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    throw new Error(`Git error: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Legacy wrapper — kept for ad-hoc commands isomorphic-git doesn't support
// ---------------------------------------------------------------------------

export function git(cmd, cwd) {
  return execGit(cmd, cwd);
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
  const remotes = git('git remote -v', workdir).split('\n');
  const match = remotes.find((l) => l.includes('origin'));
  if (!match) throw new Error('No origin remote found');
  const { owner, repo } = parseRemoteLine(match);
  return `${owner}/${repo}`;
}

// ---------------------------------------------------------------------------
// currentBranch — async via isomorphic-git
// ---------------------------------------------------------------------------

export async function currentBranch(workdir) {
  return runGit(isoGit.currentBranch, workdir, { depth: 1 });
}

// Alias: getCurrentBranch for backwards compat
export { currentBranch as getCurrentBranch };

// ---------------------------------------------------------------------------
// defaultBranch — read .git/refs/remotes/origin/HEAD or symbolic-ref
// ---------------------------------------------------------------------------

export function getDefaultBranch(workdir) {
  try {
    // Try reading packed-refs first
    const packedRefs = join(findGitRoot(workdir), '.git', 'packed-refs');
    if (existsSync(packedRefs)) {
      const content = readFileSync(packedRefs, 'utf8');
      const m = content.match(/^ref: refs\/remotes\/origin\/HEAD\s+([a-f0-9]+)/);
      if (m) {
        // Resolve the symbolic ref
        const refsDir = join(findGitRoot(workdir), '.git', 'refs', 'remotes', 'origin');
        const headFile = join(refsDir, 'HEAD');
        if (existsSync(headFile)) {
          const line = readFileSync(headFile, 'utf8').trim();
          const parts = line.split('/');
          return parts[parts.length - 1];
        }
      }
    }
    // Try symbolic-ref
    const symRef = _exec('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: workdir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return symRef.split('/').pop();
  } catch (e) {}
  return 'main';
}

// Alias: getDefaultBranch for backwards compat
export { getDefaultBranch as defaultBranch, getDefaultBranch as getDefaultBranchSync };

// ---------------------------------------------------------------------------
// fetch — use _exec (isomorphic-git fetch requires HTTP agent config)
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
// push — async via isomorphic-git
// ---------------------------------------------------------------------------

export async function push(workdir, { remote = 'origin', ref, force = false } = {}) {
  const branch = typeof ref === 'string' ? ref : ref?.ref || await currentBranch(workdir);
  const forceStr = force ? '+' : '';
  return runGit(isoGit.push, workdir, {
    remote,
    ref: branch,
    force,
    // eslint-disable-next-line no-console
    onAuth: () => console.warn('[isoGit.push] Auth callback called — ensure SSH key or token URL is configured'),
  });
}

// ---------------------------------------------------------------------------
// checkout — async via isomorphic-git
// ---------------------------------------------------------------------------

export async function checkout(workdir, ref, { force = false, remote = 'origin' } = {}) {
  // If ref doesn't exist locally but origin/<ref> does, create tracking branch
  const exists = await existsRef(workdir, ref);
  if (!exists) {
    const trackingRef = `origin/${ref}`;
    const trackingExists = await existsRef(workdir, trackingRef);
    if (trackingExists) {
      return runGit(isoGit.checkout, workdir, {
        ref,
        remote: trackingRef,
        force,
      });
    }
  }
  return runGit(isoGit.checkout, workdir, { ref, force });
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

// Alias
export { branchExists as localBranchExists };

// ---------------------------------------------------------------------------
// existsRef — async check if a ref exists via isomorphic-git expandRef
// ---------------------------------------------------------------------------

export async function existsRef(workdir, ref) {
  try {
    const gitdir = join(findGitRoot(workdir), '.git');
    const result = await isoGit.expandRef({ fs, dir: workdir, gitdir, ref });
    return !!result;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// resetHard — sync reset to a ref via _exec (simple and reliable)
// ---------------------------------------------------------------------------

export async function resetHard(workdir, ref = 'HEAD') {
  execGit(`git reset --hard ${ref}`, workdir);
}

// ---------------------------------------------------------------------------
// log — async commit log via isomorphic-git
// ---------------------------------------------------------------------------

export async function log(workdir, { ref, depth = 100, since } = {}) {
  return runGit(isoGit.log, workdir, { ref, depth, since });
}

// ---------------------------------------------------------------------------
// getCommitLogDiff — git log base..head formatted output (used by PrCommand)
// ---------------------------------------------------------------------------

export function getCommitLogDiff(workdir, headBranch, baseBranch) {
  try {
    return execGit(`git log ${baseBranch}..${headBranch} --oneline --format="%h %s"`, workdir);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// tryCheckoutRemoteBranch — async reimplementation using new primitives
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
// addAll — stage all changes using isomorphic-git
// ---------------------------------------------------------------------------

export async function addAll(workdir) {
  return runGit(isoGit.add, workdir, { filepath: '.' });
}

// ---------------------------------------------------------------------------
// index reading helpers — read .git/index and parse entries
// ---------------------------------------------------------------------------

function readIndex(workdir) {
  const gitdir = join(findGitRoot(workdir), '.git');
  const indexFile = join(gitdir, 'index');
  if (!existsSync(indexFile)) return [];
  const buf = readFileSync(indexFile);
  // Simple index parse: skip header (4+4+4+2+2+2+4+4+4 = 32 bytes), then entries
  // Each entry: 62 bytes fixed header + path length
  const entries = [];
  let offset = 4 + 4 + 4 + 2 + 2 + 2 + 4 + 4 + 4; // skip header
  const version = buf.readUInt32BE(4);
  const numEntries = buf.readUInt32BE(8);
  for (let i = 0; i < numEntries; i++) {
    const ctimeSec = buf.readUInt32BE(offset);
    const ctimeNs = buf.readUInt32BE(offset + 4);
    const mtimeSec = buf.readUInt32BE(offset + 8);
    const mtimeNs = buf.readUInt32BE(offset + 12);
    const dev = buf.readUInt32BE(offset + 16);
    const ino = buf.readUInt32BE(offset + 20);
    const mode = buf.readUInt32BE(offset + 24);
    const uid = buf.readUInt32BE(offset + 28);
    const gid = buf.readUInt32BE(offset + 32);
    const size = buf.readUInt32BE(offset + 36);
    const sha1 = buf.slice(offset + 40, offset + 60);
    const flags = buf.readUInt16BE(offset + 60);
    const pathLen = flags & 0xfff;
    const path = buf.slice(offset + 62, offset + 62 + pathLen).toString('utf8');
    entries.push({ ctimeSec, mtimeSec, dev, ino, mode, uid, gid, size, sha1: sha1.toString('hex'), path });
    // Pad to multiple of 8
    const entryLen = 62 + pathLen;
    offset += entryLen + (8 - (entryLen % 8)) % 8;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// getStagedFiles — returns list of staged file paths
// ---------------------------------------------------------------------------

export function getStagedFiles(workdir) {
  const entries = readIndex(workdir);
  // In a simple implementation, all index entries are staged
  return entries.map(e => e.path);
}

// ---------------------------------------------------------------------------
// diffStaged — staged diff using isomorphic-git's built-in diff
// ---------------------------------------------------------------------------

export async function diffStaged(workdir) {
  const { Diff } = await runGit(async ({ fs, dir, gitdir }) => {
    const d = await import('isomorphic-git/internal');
    return d;
  }, workdir);
  // Use isomorphic-git log to get the current commit tree vs index
  const head = await runGit(isoGit.expandRef, workdir, { ref: 'HEAD' }).catch(() => null);
  if (!head) return '';
  try {
    const headTree = await runGit(isoGit.readTree, workdir, { oid: head });
    const headFiles = new Map();
    for (const [path, entry] of flatTree(headTree.tree)) {
      headFiles.set(path, entry);
    }
    const indexEntries = readIndex(workdir);
    const indexFiles = new Map(indexEntries.map(e => [e.path, e]));
    const workdirFiles = new Map();
    collectFiles(workdir, workdir, workdirFiles);
    const changes = [];
    // Compare index to HEAD (staged = index vs HEAD)
    for (const [path, idxEntry] of indexFiles) {
      const headEntry = headFiles.get(path);
      if (!headEntry || headEntry.oid !== idxEntry.sha1) {
        changes.push({ path, type: headEntry ? 'modified' : 'added' });
      }
    }
    for (const path of headFiles.keys()) {
      if (!indexFiles.has(path)) {
        changes.push({ path, type: 'deleted' });
      }
    }
    // Generate unified-like diff output
    let output = '';
    for (const { path, type } of changes) {
      if (type === 'added') output += `+ ${path}\n`;
      else if (type === 'deleted') output += `- ${path}\n`;
      else output += `~ ${path}\n`;
    }
    return output;
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Simple staged diff using git diff --cached
// For complex diffs, fall back to _exec-based diff (safer than incorrect output)
// ---------------------------------------------------------------------------

export function getStagedDiff(workdir) {
  try {
    return execGit('git diff --cached', workdir);
  } catch {
    return '';
  }
}

export function getStagedStats(workdir) {
  try {
    return execGit('git diff --cached --stat', workdir);
  } catch {
    return '';
  }
}

export function getStagedNumstat(workdir) {
  try {
    return execGit('git diff --cached --numstat', workdir);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Worktree operations — direct .git/worktrees filesystem manipulation
// isomorphic-git does not support worktrees
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
      // gitdir points to .git/worktrees/<name> which is a file pointing to the actual .git dir of the worktree
      // The 'gitdir' file contains a path to the actual git dir, and we need the parent of that
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
  const targetGitDir = join(path, '.git');
  // Create the worktree gitdir reference file
  mkdirSync(wtPath, { recursive: true });
  writeFileSync(join(wtPath, 'gitdir'), join(path, '.git') + '\n');
  writeFileSync(join(wtPath, 'commits'), `1 ${execGit('git rev-parse HEAD', workdir)}\n`);
  // Register in .git/worktrees
  execGit(`git worktree add "${path}" "${name}"`, workdir);
}

export function worktreeRemove(workdir, name) {
  validateWorktreeName(name);
  const wtDir = worktreeDir(workdir);
  const wtPath = join(wtDir, name);
  if (!existsSync(wtPath)) {
    throw new Error(`Worktree "${name}" not found`);
  }
  // Remove via git command
  execGit(`git worktree remove "${name}"`, workdir);
}

// ---------------------------------------------------------------------------
// Helper: flatten tree entries (recursive)
// ---------------------------------------------------------------------------

function flatTree(tree, prefix = '') {
  const result = [];
  for (const entry of tree) {
    const fullPath = prefix ? `${prefix}/${entry.path}` : entry.path;
    if (entry.type === 'tree') {
      result.push(...flatTree(entry.tree, fullPath));
    } else {
      result.push([fullPath, entry]);
    }
  }
  return result;
}

function collectFiles(base, dir, map, rel = '') {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const full = join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      collectFiles(base, full, map, relPath);
    } else {
      map.set(relPath, full);
    }
  }
}
