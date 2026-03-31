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
