import { execSync } from 'child_process';

export function git(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    throw new Error(`Git error: ${e.message}`);
  }
}

/**
 * Parse a "remote  url (fetch/push)" line and extract "owner/repo".
 * Handles: SSH (git@host:owner/repo), HTTPS (https://host/owner/repo),
 * SSH with explicit protocol (ssh://git@host/owner/repo), optional .git suffix,
 * and optional (fetch)/(push) labels.
 *
 * @param {string} line - e.g. "origin  git@github.com:cnlangzi/gfwproxy (fetch)"
 * @returns {{ owner: string, repo: string }} - e.g. { owner: "cnlangzi", repo: "gfwproxy" }
 * @throws {Error} if the line cannot be parsed
 */
export function parseRemoteLine(line) {
  if (!line || typeof line !== 'string') {
    throw new Error('Invalid remote line: empty or not a string');
  }

  // 1. Strip trailing "(fetch)" / "(push)" labels
  const clean = line.replace(/\s+\([^)]+\)$/, '').trim();

  // 2. Remove leading "remote-name  " prefix (everything before the URL)
  const url = clean.replace(/^[^\s]+\s+/, '').trim();

  let owner, repo;

  // SSH: git@host:owner/repo[.git]
  const sshMatch = url.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    [owner, repo] = [sshMatch[1], sshMatch[2]];
  } else {
    // HTTPS / SSH with explicit protocol: [protocol://][user@]host/owner/repo[.git]
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

export function getCurrentBranch(cwd) {
  return git('git branch --show-current', cwd);
}

export function getDefaultBranch(cwd) {
  try {
    return execSync('git symbolic-ref refs/remotes/origin/HEAD', { encoding: 'utf8' })
      .trim()
      .split('/')
      .pop();
  } catch (e) {}
  return 'main';
}

// ---------------------------------------------------------------------------
// Robust branch checkout for PR preparation
// ---------------------------------------------------------------------------

/**
 * Robust branch checkout for PR preparation.
 *
 * Returns a status object describing what happened:
 *   - { status: 'remote-synced', branch: <branchName> }
 *       Remote exists: fetched + checked out + hard-reset to origin/<branchName>.
 *   - { status: 'local-only', branch: <branchName> }
 *       Remote missing but local branch exists: checked out local branch.
 *       Caller should warn user to run /gtw push.
 *   - { status: 'not-found', branch: <currentBranch> }
 *       Neither remote nor local branch exists: stayed on current branch.
 *       Caller should proceed with current branch.
 */
export function tryCheckoutRemoteBranch(workdir, branchName) {
  const current = getCurrentBranch(workdir);

  // Fetch to get accurate remote ref info
  try {
    git('git fetch origin', workdir);
  } catch {
    return { status: 'not-found', branch: current };
  }

  const remoteRef = `origin/${branchName}`;
  let remoteExists = false;
  try {
    git(`git rev-parse --verify ${remoteRef}`, workdir);
    remoteExists = true;
  } catch {
    remoteExists = false;
  }

  if (remoteExists) {
    // Remote exists — sync to it
    if (current === branchName) {
      // Already on this branch — hard-reset to remote
      git(`git reset --hard ${remoteRef}`, workdir);
    } else {
      // Check if local branch already exists
      let localExists = false;
      try {
        git(`git rev-parse --verify ${branchName}`, workdir);
        localExists = true;
      } catch {
        localExists = false;
      }

      if (localExists) {
        // Local exists with same name — checkout and reset
        git(`git checkout ${branchName}`, workdir);
        git(`git reset --hard ${remoteRef}`, workdir);
      } else {
        // No local branch — create tracking branch from remote
        git(`git checkout -b ${branchName} ${remoteRef}`, workdir);
      }
    }
    return { status: 'remote-synced', branch: branchName };
  }

  // Remote does not exist — check if local branch exists
  let localExists = false;
  try {
    git(`git rev-parse --verify ${branchName}`, workdir);
    localExists = true;
  } catch {
    localExists = false;
  }

  if (localExists) {
    // Local exists but remote is missing — checkout and let user push
    git(`git checkout ${branchName}`, workdir);
    return { status: 'local-only', branch: branchName };
  }

  // Neither remote nor local — stay on current branch
  return { status: 'not-found', branch: current };
}

