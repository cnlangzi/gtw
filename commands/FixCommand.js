import { Commander } from './Commander.js';
import { getWip, saveWip } from '../utils/wip.js';
import { git, getDefaultBranch } from '../utils/git.js';

export class FixCommand extends Commander {
  async execute(args) {
    const wip = getWip();
    if (!wip.workdir) throw new Error('No workdir set. Run /gtw on <workdir> first');

    const workdir = wip.workdir;
    const branchName = args[0] || `fix/${Date.now()}`;
    const defaultBranch = getDefaultBranch(workdir);

    git('git fetch origin', workdir);
    git(`git checkout ${defaultBranch}`, workdir);
    git(`git pull --rebase origin ${defaultBranch}`, workdir);
    git(`git checkout -b ${branchName}`, workdir);

    const updated = { ...wip, branch: { name: branchName }, updatedAt: new Date().toISOString() };
    saveWip(updated);

    return {
      ok: true,
      branch: branchName,
      base: defaultBranch,
      workdir,
      message: `Switched to new branch '${branchName}' (rebased on ${defaultBranch})`,
      display: `🌿 Created and checked out new branch\n\nBranch: ${branchName}\nBase: ${defaultBranch}\n\nRun /gtw pr to push, or write code then /gtw push`,
    };
  }
}
