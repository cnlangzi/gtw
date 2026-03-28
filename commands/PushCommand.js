import { Commander } from './Commander.js';
import { getWip, saveWip } from '../utils/wip.js';
import { git, getCurrentBranch } from '../utils/git.js';

export class PushCommand extends Commander {
  async execute(args) {
    const wip = getWip();
    if (!wip.workdir) throw new Error('No workdir set. Run /gtw on <workdir> first');

    const workdir = wip.workdir;
    const branch = getCurrentBranch(workdir);

    // git add -A
    git('git add -A', workdir);

    // Check for changes
    const stats = git('git diff --cached --stat', workdir);
    if (!stats) {
      return {
        ok: true,
        branch,
        message: 'No changes to commit',
        display: `✅ No changes to commit\n\nBranch: ${branch}`,
      };
    }

    // Parse changed files
    const files = git('git diff --cached --name-only', workdir).split('\n').filter(Boolean);
    const shortStats = git('git diff --cached --numstat', workdir);
    let totalAdd = 0, totalDel = 0;
    for (const l of shortStats.split('\n').filter(Boolean)) {
      const parts = l.split('\t');
      totalAdd += parseInt(parts[0], 10) || 0;
      totalDel += parseInt(parts[1], 10) || 0;
    }

    // Auto-generate conventional commit message from branch name
    const branchType = branch.includes('fix/') ? 'fix' : branch.includes('feat/') ? 'feat' : 'chore';
    const branchTopic = branch.replace(/^(fix|feat|chore)[/\\-]/, '').replace(/[\\/-]/g, '-') || 'update';
    const commitMsg = `${branchType}(${branchTopic}): ${files.length} file(s) changed (+${totalAdd} -${totalDel})`;

    git(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, workdir);
    git(`git push origin ${branch}`, workdir);

    return {
      ok: true,
      branch,
      stats,
      commit: commitMsg,
      files,
      message: `Committed and pushed: ${commitMsg}`,
      display: `📦 Committed and pushed\n\nBranch: ${branch}\nCommit: ${commitMsg}\nFiles: ${files.join(', ')}\nStats: +${totalAdd} -${totalDel}`,
    };
  }
}
