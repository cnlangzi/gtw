import { Commander } from './Commander.js';
import { getWip, clearWip, saveWip } from '../utils/wip.js';
import { getValidToken } from '../utils/api.js';
import { apiRequest } from '../utils/api.js';
import { git } from '../utils/git.js';

export class ConfirmCommand extends Commander {
  async execute(args) {
    const wip = getWip();

    // Handle pending commit (from /gtw push)
    if (wip.pendingCommit) {
      const { title, body, branch, workdir, files, totalAdd, totalDel } = wip.pendingCommit;

      git(`git commit -m "${title.replace(/"/g, '\\"')}" -m "${body.replace(/"/g, '\\"')}"`, workdir);
      git(`git push -u origin ${branch}`, workdir);

      // Keep workdir/repo, clear pendingCommit
      const { workdir: wd, repo } = wip;
      clearWip();
      saveWip({ workdir: wd, repo, updatedAt: new Date().toISOString() });

      return {
        ok: true,
        branch,
        commit: { title, body },
        display: [
          `📦 Committed and pushed`,
          `Branch: ${branch}`,
          `Commit: ${title}`,
          `Extended: ${body.split('\n')[0] || body.slice(0, 60)}`,
        ].join('\n'),
      };
    }

    // Handle pending issue (from /gtw new)
    if (!wip.repo) throw new Error('No pending action. Run /gtw on + /gtw new first');
    if (!wip.issue?.title) throw new Error('No issue draft. Run /gtw new first');

    const token = await getValidToken();
    const { title, body } = wip.issue;

    const data = await apiRequest('POST', `/repos/${wip.repo}/issues`, token, {
      title,
      body: body || 'Created via gtw',
    });

    clearWip();

    return {
      ok: true,
      issue: { id: data.number, url: data.html_url },
      display: `✅ Issue #${data.number} created\n${data.html_url}`,
    };
  }
}
