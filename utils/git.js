import { execSync } from 'child_process';

export function git(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    throw new Error(`Git error: ${e.message}`);
  }
}

export function getRemoteRepo(workdir) {
  const remotes = git('git remote -v', workdir).split('\n');
  const match = remotes.find((l) => l.includes('origin'));
  if (!match) throw new Error('No origin remote found');
  const m = match.match(/git@github\.com:([^/]+\/[^.]+)(\.git)?/) || match.match(/https:\/\/github\.com\/([^/]+\/[^/]+)(\.git)?/);
  if (!m) throw new Error(`Cannot parse remote: ${match}`);
  return m[1];
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
