import { Commander } from './Commander.js';
import { getWip } from '../utils/wip.js';
import { getValidToken, apiRequest } from '../utils/api.js';

const REVIEW_ITEMS = [
  'Does the implementation match the Issue requirements?',
  'Are there any out-of-scope changes?',
  'Are there any missing pieces?',
];

export class ReviewCommand extends Commander {
  async execute(args) {
    const token = await getValidToken();
    const wip = getWip();
    const verdictArg = args.find((a) => a === 'approved' || a === 'changes') || null;
    const repo = wip.repo || args.find((a) => String(a).includes('/')) || '';

    if (!repo) throw new Error('No repo set. Run /gtw on <workdir> first');

    const myLogin = (await apiRequest('GET', '/user', token)).login;

    // Parse PR number
    let targetPrNum = null;
    for (const a of args) {
      const m = String(a).match(/^#?(\d+)$/);
      if (m) { targetPrNum = parseInt(m[1]); break; }
    }

    let targetPr = null;
    if (targetPrNum) {
      try {
        targetPr = await apiRequest('GET', `/repos/${repo}/pulls/${targetPrNum}`, token);
      } catch (e) {
        throw new Error(`PR #${targetPrNum} not found`);
      }
    } else {
      const params = new URLSearchParams({ state: 'open', per_page: '50', sort: 'created', direction: 'asc' });
      const prs = await apiRequest('GET', `/repos/${repo}/pulls?${params}`, token);
      for (const pr of prs) {
        if (pr.user?.login === myLogin) continue;
        const comments = await apiRequest('GET', `/repos/${repo}/issues/${pr.number}/comments`, token);
        if (!comments.some((c) => c.body?.includes('eyes'))) { targetPr = pr; break; }
      }
    }

    if (!targetPr) {
      return { ok: true, message: 'No unclaimed PRs found', repo, display: `🔍 No unclaimed PRs found` };
    }

    const prNum = targetPr.number;

    // Get linked issue
    let linkedIssue = { title: '', body: '' };
    const match = targetPr.body?.match(/(?:closes|fixes|cloze)s?\s+#(\d+)/i);
    if (match) {
      try {
        const li = await apiRequest('GET', `/repos/${repo}/issues/${match[1]}`, token);
        linkedIssue = { title: li.title || '', body: li.body || '' };
      } catch (e) {}
    }

    const allComments = await apiRequest('GET', `/repos/${repo}/issues/${prNum}/comments`, token);
    const myPrevComments = allComments.filter((c) => c.user?.login === myLogin);

    // Second call with verdict
    if (verdictArg) {
      const emoji = verdictArg;
      const reviewState = verdictArg === 'approved' ? 'APPROVED' : 'CHANGES_REQUESTED';
      for (const c of myPrevComments) {
        await apiRequest('DELETE', `/repos/${repo}/issues/comments/${c.id}`, token).catch(() => {});
      }
      await apiRequest('POST', `/repos/${repo}/issues/${prNum}/comments`, token, {
        body: `${emoji} **Review complete** by @${myLogin} — ${verdictArg === 'approved' ? 'approves' : 'requests changes'}`,
      });
      await apiRequest('POST', `/repos/${repo}/pulls/${prNum}/reviews`, token, { body: emoji, event: reviewState });
      return {
        ok: true,
        verdict: verdictArg,
        pr: { number: prNum, title: targetPr.title, url: targetPr.html_url },
        repo,
        message: `${emoji} Review complete for PR #${prNum} — claim released`,
        display:
          verdictArg === 'approved'
            ? `✅ PR #${prNum} approved\n\n${targetPr.title}\n\nClaim released, ready to merge`
            : `❌ PR #${prNum} changes requested\n\n${targetPr.title}\n\nClaim released, developer can submit revisions`,
      };
    }

    // First call — claim
    const prevChecked = {};
    for (const c of myPrevComments) {
      for (const line of c.body.split('\n')) {
        const m = line.match(/^\s*-\s*\[([ x])\]\s*(.+)/);
        if (m) prevChecked[m[2].trim()] = m[1] === 'x';
      }
    }
    const checklistItems = REVIEW_ITEMS.map((item) => ({ text: item, checked: !!prevChecked[item] }));
    const checklistLines = checklistItems.map((i) => `  - [${i.checked ? 'x' : ' '}] ${i.text}`).join('\n');

    await apiRequest('POST', `/repos/${repo}/issues/${prNum}/comments`, token, {
      body: `eyes **Review claimed** by @${myLogin}\n\n_Emoji: eyes = in progress, approved = done, changes = needs changes_\n\n## Review Checklist\n\n${checklistLines}\n\n---\n_Agent: review the diff and linked issue, then call:\n  /gtw review #${prNum} approved   # or changes_`,
    });

    const files = await apiRequest('GET', `/repos/${repo}/pulls/${prNum}/files?per_page=100`, token);
    const filesSummary = files.map((f) => `  - ${f.filename}: +${f.additions} -${f.deletions}`).join('\n');

    return {
      ok: true,
      claimed: true,
      pr: { number: prNum, title: targetPr.title, url: targetPr.html_url, user: targetPr.user?.login },
      linkedIssue,
      files: files.map((f) => ({ filename: f.filename, additions: f.additions, deletions: f.deletions, patch: f.patch })),
      checklist: checklistItems,
      hasPrevReview: myPrevComments.length > 0,
      repo,
      verdictNeeded: `/gtw review #${prNum} approved   # or changes`,
      message: `eyes Claimed PR #${prNum}: ${targetPr.title}\n\nLinked Issue: ${linkedIssue.title || 'none'}\n\nFiles changed (${files.length}):\n${filesSummary}\n\nReview the diff against the issue requirements, then call:\n/gtw review #${prNum} approved   # or changes`,
    };
  }
}
