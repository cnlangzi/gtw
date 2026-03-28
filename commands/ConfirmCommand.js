import { Commander } from './Commander.js';
import { getWip, saveWip, clearWip } from '../utils/wip.js';
import { getValidToken } from '../utils/api.js';
import { getDefaultBranch, getCurrentBranch } from '../utils/git.js';
import { apiRequest } from '../utils/api.js';

export class ConfirmCommand extends Commander {
  async execute(args) {
    const token = await getValidToken();
    const wip = getWip();
    if (!wip.repo) throw new Error('No pending action. Run /gtw on + /gtw new first');

    const results = [];

    // Create issue
    if (wip.issue?.title) {
      const { action, id, title, body } = wip.issue;
      if (action === 'create') {
        const data = await apiRequest('POST', `/repos/${wip.repo}/issues`, token, {
          title,
          body: body || 'Created via gtw',
        });
        results.push({ type: 'issue', action: 'created', id: data.number, url: data.html_url });
      } else if (action === 'update' && id) {
        const data = await apiRequest('PATCH', `/repos/${wip.repo}/issues/${id}`, token, { title, body });
        results.push({ type: 'issue', action: 'updated', id, url: data.html_url });
      }
    }

    // Create branch
    if (wip.branch?.name && wip.issue?.id) {
      const shaResp = await apiRequest(
        'GET',
        `/repos/${wip.repo}/git/ref/heads/${getDefaultBranch(wip.workdir)}`,
        token
      );
      await apiRequest('POST', `/repos/${wip.repo}/git/refs`, token, {
        ref: `refs/heads/${wip.branch.name}`,
        sha: shaResp.object.sha,
      });
      const [owner, repoName] = wip.repo.split('/');
      try {
        await apiRequest('POST', `/repos/${owner}/${repoName}/issues/${wip.issue.id}/labels`, token, {
          labels: [`branch:${wip.branch.name}`],
        });
      } catch (e) {}
      results.push({ type: 'branch', action: 'created', name: wip.branch.name });
    }

    // Create PR
    if (wip.pr?.title) {
      const baseBranch = getDefaultBranch(wip.workdir);
      const headBranch = wip.branch?.name || getCurrentBranch(wip.workdir);
      const body = wip.pr.body || `Closes #${wip.issue?.id || '?'}`;
      const data = await apiRequest('POST', `/repos/${wip.repo}/pulls`, token, {
        title: wip.pr.title,
        body,
        head: headBranch,
        base: baseBranch,
      });
      results.push({ type: 'pr', action: 'created', id: data.number, url: data.html_url });
    }

    // Clear staging data but keep workdir/repo
    clearWip();

    return {
      ok: true,
      results,
      message: 'Pending actions executed and cleared',
      display: `🚀 Executed all pending actions\n\n${results.map((r) => `• ${r.type} #${r.id || r.name}: ${r.action}`).join('\n')}\n\n📁 workdir kept: ${wip.workdir}`,
    };
  }
}
