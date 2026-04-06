import { Commander } from './Commander.js';
import { getWip } from '../utils/wip.js';
import { getValidToken } from '../utils/api.js';
import { GitHubClient } from '../utils/github.js';

export class ShowCommand extends Commander {
  async execute(args) {
    const token = await getValidToken();
    const client = new GitHubClient(token);
    const wip = getWip();
    const id = parseInt(args[0], 10);
    if (isNaN(id)) throw new Error('Usage: /gtw show #<id>');
    const repo = args[1] && String(args[1]).includes('/') ? args[1] : wip.repo;
    if (!repo) throw new Error('No repo set. Run /gtw on <workdir> first');

    const data = await client.request('GET', `/repos/${repo}/issues/${id}`);
    return {
      ok: true,
      issue: {
        number: data.number,
        title: data.title,
        body: data.body,
        state: data.state,
        url: data.html_url,
        assignee: data.assignee?.login,
      },
      display: `[#${data.number}] ${data.title}\n\n${data.body || ''}\n\nState: ${data.state}\nURL: ${data.html_url}`,
    };
  }
}
