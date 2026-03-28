import { Commander } from './Commander.js';
import { getWip, clearWip } from '../utils/wip.js';
import { getValidToken } from '../utils/api.js';
import { apiRequest } from '../utils/api.js';

export class ConfirmCommand extends Commander {
  async execute(args) {
    const token = await getValidToken();
    const wip = getWip();
    if (!wip.repo) throw new Error('No pending action. Run /gtw on + /gtw new first');
    if (!wip.issue?.title) throw new Error('No issue draft. Run /gtw new first');

    const { title, body } = wip.issue;

    const data = await apiRequest('POST', `/repos/${wip.repo}/issues`, token, {
      title,
      body: body || 'Created via gtw',
    });

    // Keep workdir/repo, clear everything else
    clearWip();

    return {
      ok: true,
      issue: { id: data.number, url: data.html_url },
      display: `✅ Issue #${data.number} created\n${data.html_url}`,
    };
  }
}
