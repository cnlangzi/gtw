import { Commander } from './Commander.js';
import { getWip } from '../utils/wip.js';
import { getValidToken } from '../utils/api.js';
import { GitHubClient } from '../utils/github.js';

export class IssueCommand extends Commander {
  async execute(args) {
    const token = await getValidToken();
    const client = new GitHubClient(token);
    const wip = getWip();
    const repo = args[0] && String(args[0]).includes('/') ? args[0] : wip.repo;
    if (!repo) throw new Error('No repo. Run /gtw on <workdir> first, or pass owner/repo');

    const params = new URLSearchParams({ state: 'open', per_page: '50' });
    const data = await client.request('GET', `/repos/${repo}/issues?${params}`);
    const issues = data.filter((i) => !i.pull_request);
    if (!issues.length) {
      return { ok: true, repo, issues: [], message: `No open issues in ${repo}`, display: `📋 No open issues visible` };
    }
    return {
      ok: true,
      repo,
      issues: issues.map((i) => ({ number: i.number, title: i.title, state: i.state, url: i.html_url })),
      display: issues.map((i) => `[#${i.number}] ${i.title}`).join('\n'),
    };
  }
}
