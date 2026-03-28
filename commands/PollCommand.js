import { Commander } from './Commander.js';
import { getWip } from '../utils/wip.js';
import { getValidToken, apiRequest } from '../utils/api.js';

export class PollCommand extends Commander {
  async execute(args) {
    const token = await getValidToken();
    const wip = getWip();
    const repo = wip.repo;
    if (!repo) throw new Error('No repo set. Run /gtw on <workdir> first');

    const sub = args[0];

    if (sub === 'issue') {
      const params = new URLSearchParams({ state: 'open', per_page: '10', sort: 'created', direction: 'asc' });
      const data = await apiRequest('GET', `/repos/${repo}/issues?${params}`, token);
      const issues = data.filter((i) => !i.pull_request);
      return {
        ok: true,
        type: 'issue',
        repo,
        issues: issues.map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          url: i.html_url,
          created_at: i.created_at,
          assignee: i.assignee?.login,
        })),
        display: issues.length
          ? issues.map((i) => `[#${i.number}] ${i.title} (${(i.created_at || '').split('T')[0]})`).join('\n')
          : 'No open issues',
      };
    }

    if (sub === 'pr') {
      const params = new URLSearchParams({ state: 'open', per_page: '10', sort: 'created', direction: 'asc' });
      const data = await apiRequest('GET', `/repos/${repo}/pulls?${params}`, token);
      const prData = data.map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        url: pr.html_url,
        created_at: pr.created_at,
        user: pr.user?.login,
      }));
      return {
        ok: true,
        type: 'pr',
        repo,
        prs: prData,
        display: prData.length
          ? prData.map((pr) => `[#${pr.number}] ${pr.title} by @${pr.user} (${(pr.created_at || '').split('T')[0]})`).join('\n')
          : 'No open PRs',
      };
    }

    // Default: both
    const issueParams = new URLSearchParams({ state: 'open', per_page: '10', sort: 'created', direction: 'asc' });
    const prParams = new URLSearchParams({ state: 'open', per_page: '10', sort: 'created', direction: 'asc' });
    const [issuesData, prsData] = await Promise.all([
      apiRequest('GET', `/repos/${repo}/issues?${issueParams}`, token),
      apiRequest('GET', `/repos/${repo}/pulls?${prParams}`, token),
    ]);
    const issues = issuesData.filter((i) => !i.pull_request);
    let display =
      issues.length
        ? '\nOpen Issues (oldest first):\n' + issues.map((i) => `  [#${i.number}] ${i.title} (${(i.created_at || '').split('T')[0]})`).join('\n')
        : '\nOpen Issues: none';
    display +=
      prsData.length
        ? '\n\nOpen PRs (oldest first):\n' + prsData.map((pr) => `  [#${pr.number}] ${pr.title} by @${pr.user?.login} (${(pr.created_at || '').split('T')[0]})`).join('\n')
        : '\nOpen PRs: none';
    if (!issues.length && !prsData.length) display = 'Nothing open.';

    return { ok: true, repo, issues, prs: prsData, display };
  }
}
