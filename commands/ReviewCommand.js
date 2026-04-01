import { Commander } from './Commander.js';
import { getWip, saveWip } from '../utils/wip.js';
import { getConfig } from '../utils/config.js';
import { getValidToken, apiRequest } from '../utils/api.js';

const GTW_LABELS = ['gtw/ready', 'gtw/wip', 'gtw/lgtm', 'gtw/revise', 'gtw/stuck'];
const CHECKLIST_ITEMS = ['Destructive', 'Out-of-scope'];
const DEFAULT_MAX_ROUNDS = 5;

// ---------------------------------------------------------------------------
// Atomic label operations
// ---------------------------------------------------------------------------

/**
 * Atomically set a gtw label on a PR/issue: removes all other gtw/* labels first.
 * Returns { ok: true } on success.
 * Throws on failure (caller should abort).
 */
export async function setGtwLabel(issueNumber, token, repo, targetLabel, isPR = true) {
  if (!GTW_LABELS.includes(targetLabel)) {
    throw new Error(`Invalid gtw label: ${targetLabel}. Must be one of: ${GTW_LABELS.join(', ')}`);
  }

  const endpointBase = isPR ? `/repos/${repo}/pulls/${issueNumber}` : `/repos/${repo}/issues/${issueNumber}`;

  // Fetch current labels on the PR/issue
  const currentLabels = await apiRequest('GET', `${endpointBase}/labels`, token);

  // Identify which gtw/* labels are currently applied (excluding target)
  const toRemove = currentLabels
    .map((l) => l.name)
    .filter((name) => GTW_LABELS.includes(name) && name !== targetLabel);

  // Remove other gtw labels first
  for (const label of toRemove) {
    try {
      await apiRequest('DELETE', `${endpointBase}/labels/${encodeURIComponent(label)}`, token);
    } catch (e) {
      // If removal fails (e.g. 404 race condition), abort — do not continue
      if (e.message.includes('404') || e.message.includes('Label not found')) {
        // Label already gone, that's fine
      } else {
        throw new Error(`Failed to remove label "${label}" from #${issueNumber}: ${e.message}. Aborting.`);
      }
    }
  }

  // Check if target label is already present (no-op for that label)
  const alreadyHas = currentLabels.some((l) => l.name === targetLabel);
  if (!alreadyHas) {
    try {
      await apiRequest('POST', `${endpointBase}/labels`, token, {
        labels: [targetLabel],
      });
    } catch (e) {
      throw new Error(`Failed to set label "${targetLabel}" on #${issueNumber}: ${e.message}. Aborting.`);
    }
  }
}

/**
 * Fetch PR details including diff summary and linked issue.
 */
export async function fetchPrDetails(prNum, token, repo) {
  const [pr, files] = await Promise.all([
    apiRequest('GET', `/repos/${repo}/pulls/${prNum}`, token),
    apiRequest('GET', `/repos/${repo}/pulls/${prNum}/files?per_page=100`, token),
  ]);

  let linkedIssue = { number: null, title: '', body: '' };
  const match = pr.body?.match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
  if (match) {
    try {
      const li = await apiRequest('GET', `/repos/${repo}/issues/${match[1]}`, token);
      linkedIssue = { number: parseInt(match[1]), title: li.title || '', body: li.body || '' };
    } catch (e) {
      // Linked issue not accessible, that's ok
    }
  }

  return {
    pr: {
      number: pr.number,
      title: pr.title,
      body: pr.body || '',
      url: pr.html_url,
      user: pr.user?.login,
      updatedAt: pr.updated_at,
      state: pr.state,
      labels: pr.labels || [],
    },
    files: files.map((f) => ({
      filename: f.filename,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch || '',
    })),
    linkedIssue,
  };
}

/**
 * Find existing checklist comment by this agent on a PR.
 * Returns the comment object or null.
 */
export async function findChecklistComment(prNum, token, repo, myLogin) {
  const comments = await apiRequest('GET', `/repos/${repo}/issues/${prNum}/comments`, token);
  return (
    comments.find(
      (c) =>
        c.user?.login === myLogin && c.body?.includes('## Review [Round'),
    ) || null
  );
}

/**
 * Extract checked/unchecked state from existing checklist comment.
 * Returns array of { text, checked }.
 */
export function parseChecklistFromComment(body) {
  const result = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*-\s*\[([ x])\]\s*(.+)/);
    if (m) {
      result.push({ text: m[2].trim(), checked: m[1] === 'x' });
    }
  }
  return result;
}

/**
 * Filter previous checklist items: keep only unresolved ones (unchecked).
 * Resolved items (checked) are removed from the list per spec:
 * "compare PR diff to checklist; remove checkboxes that are resolved; keep unresolved ones"
 */
export function mergeChecklistState(prevItems, canonicalItems) {
  // Only include canonical items that are NOT resolved (not checked in prev).
  // Resolved = checked in previous comment = removed from new comment.
  return canonicalItems
    .filter((text) => {
      const prev = prevItems.find((p) => p.text === text);
      return !prev || !prev.checked;
    })
    .map((text) => ({ text, checked: false }));
}

// ---------------------------------------------------------------------------
// ReviewCommand
// ---------------------------------------------------------------------------

export class ReviewCommand extends Commander {
  constructor(context) {
    super(context);
  }

  /**
   * /gtw review           — claim earliest gtw/ready PR from watch list
   * /gtw review <pr>    — review specific PR in current repo (from wip.json)
   */
  async execute(args) {
    const token = await getValidToken();
    const wip = getWip();
    const config = getConfig();
    const maxRounds = config.maxReviewRounds || DEFAULT_MAX_ROUNDS;

    // Parse optional PR number argument
    let targetPrNum = null;
    for (const a of args) {
      const m = String(a).match(/^(\d+)$/);
      if (m) {
        targetPrNum = parseInt(m[1]);
        break;
      }
    }

    const myLogin = (await apiRequest('GET', '/user', token)).login;

    // Determine target repo and PR
    if (targetPrNum) {
      // /gtw review <pr> — use repo from wip.json
      const repo = wip.repo;
      if (!repo) {
        return { ok: false, message: '⚠️ No repo set. Run /gtw on <workdir> first' };
      }
      return this._reviewSpecificPr(targetPrNum, repo, token, myLogin, wip, maxRounds);
    } else {
      // /gtw review — scan watch list for gtw/ready PRs
      return this._reviewNextFromWatchList(token, myLogin, wip, maxRounds);
    }
  }

  /**
   * Scan watch list and claim the earliest gtw/ready PR.
   */
  async _reviewNextFromWatchList(token, myLogin, wip, maxRounds) {
    const config = getConfig();
    const watchList = config.watchList || [];

    if (watchList.length === 0) {
      return {
        ok: true,
        message: '🔍 Watch list is empty. Add repos with /gtw watch add <owner>/<repo>',
        display: '🔍 Watch list is empty.\n\nAdd repos to watch:\n  /gtw watch add <owner>/<repo>',
      };
    }

    // Find all gtw/ready PRs across watched repos
    const candidatePrs = [];
    for (const repo of watchList) {
      try {
        const params = new URLSearchParams({ state: 'open', per_page: 100, sort: 'updated', direction: 'asc' });
        const prs = await apiRequest('GET', `/repos/${repo}/pulls?${params}`, token);

        for (const pr of prs) {
          if (pr.user?.login === myLogin) continue; // skip own PRs
          // Check if PR has gtw/ready label
          const labels = pr.labels || [];
          if (labels.some((l) => l.name === 'gtw/ready')) {
            candidatePrs.push({
              repo,
              pr: {
                number: pr.number,
                title: pr.title,
                url: pr.html_url,
                user: pr.user?.login,
                updatedAt: pr.updated_at,
              },
            });
          }
        }
      } catch (e) {
        // Skip repos we don't have access to
        console.error(`[ReviewCommand] Failed to fetch PRs from ${repo}: ${e.message}`);
      }
    }

    if (candidatePrs.length === 0) {
      return {
        ok: true,
        message: '🔍 No PRs with gtw/ready label found in watched repos',
        display: `🔍 No gtw/ready PRs found\n\nWatched repos: ${watchList.join(', ') || '(none)'}\n\nNo PRs labeled gtw/ready are awaiting review.`,
      };
    }

    // Sort by updated_at ascending (oldest first)
    candidatePrs.sort((a, b) => new Date(a.pr.updatedAt) - new Date(b.pr.updatedAt));

    // Pick the earliest
    const chosen = candidatePrs[0];
    return this._claimAndReviewPr(chosen.repo, chosen.pr.number, token, myLogin, wip, maxRounds);
  }

  /**
   * Review a specific PR by number in a given repo.
   */
  async _reviewSpecificPr(prNum, repo, token, myLogin, wip, maxRounds) {
    // Verify PR exists
    let prData;
    try {
      prData = await fetchPrDetails(prNum, token, repo);
    } catch (e) {
      if (e.message.includes('404')) {
        return { ok: false, message: `⚠️ PR #${prNum} not found in ${repo}` };
      }
      throw e;
    }

    return this._claimAndReviewPr(repo, prNum, token, myLogin, wip, maxRounds, prData);
  }

  /**
   * Core logic: claim PR (set gtw/wip), create/update checklist, track round in wip.
   * If checklist is empty (all items resolved), delete checklist, post approved comment, set gtw/lgtm.
   * If round exceeds max, set gtw/stuck.
   */
  async _claimAndReviewPr(repo, prNum, token, myLogin, wip, maxRounds, prData = null) {
    // Fetch fresh PR data if not provided
    if (!prData) {
      prData = await fetchPrDetails(prNum, token, repo);
    }

    // Read current wip state for this PR (if any)
    const currentWip = getWip();
    const reviewState = currentWip.reviewState || {};
    const thisPrKey = `${repo}#${prNum}`;
    const existingState = reviewState[thisPrKey] || {};

    // Check if already stuck — do not re-review
    const labels = prData.pr.labels || [];
    if (labels.some((l) => l.name === 'gtw/stuck')) {
      return {
        ok: true,
        message: `⏸ PR #${prNum} is stuck (exceeded max review rounds). Manual intervention required.`,
        display: `⏸ PR #${prNum} is stuck\n\n${prData.pr.title}\n\nExceeded ${maxRounds} review rounds without resolution.\n\nPlease review manually and set gtw/lgtm or gtw/revise as appropriate.`,
      };
    }

    // Atomically claim the PR: remove other gtw labels, set gtw/wip
    try {
      await setGtwLabel(prNum, token, repo, 'gtw/wip', true);
    } catch (e) {
      return { ok: false, message: `⚠️ ${e.message}` };
    }

    // Concurrency check: re-fetch PR to verify claim succeeded.
    // If gtw/ready is still present, another runner claimed it — abort.
    const prAfterClaim = await fetchPrDetails(prNum, token, repo);
    if (prAfterClaim.pr.labels.some((l) => l.name === 'gtw/ready')) {
      return {
        ok: false,
        message: `⚠️ PR #${prNum} was claimed by another runner (gtw/ready still present). Aborting.`,
      };
    }

    // Find existing checklist comment
    const existingComment = await findChecklistComment(prNum, token, repo, myLogin);

    let round = 1;
    let checklistItems = CHECKLIST_ITEMS.map((text) => ({ text, checked: false }));
    let commentId = null;

    if (existingComment) {
      // Parse round from title "## Review [Round N]"
      const roundMatch = existingComment.body.match(/## Review \[Round (\d+)\]/);
      round = roundMatch ? parseInt(roundMatch[1]) + 1 : 2;

      // Parse previous checklist state
      const prevItems = parseChecklistFromComment(existingComment.body);

      // Merge: keep unresolved items, drop resolved ones
      checklistItems = mergeChecklistState(prevItems, CHECKLIST_ITEMS);
      commentId = existingComment.id;
    }

    // Check if max rounds exceeded
    if (round > maxRounds) {
      try {
        await setGtwLabel(prNum, token, repo, 'gtw/stuck', true);
      } catch (e) {
        return { ok: false, message: `⚠️ ${e.message}` };
      }

      // Update wip: clear this PR's review state
      const updatedWip = { ...currentWip };
      const newReviewState = { ...(updatedWip.reviewState || {}) };
      delete newReviewState[thisPrKey];
      updatedWip.reviewState = newReviewState;
      updatedWip.updatedAt = new Date().toISOString();
      saveWip(updatedWip);

      return {
        ok: true,
        stuck: true,
        repo,
        pr: prData.pr,
        round,
        maxRounds,
        message: `⚠️ PR #${prNum} is stuck — max rounds (${maxRounds}) exceeded`,
        display: `⚠️ PR #${prNum} stuck — max rounds exceeded\n\n${prData.pr.title}\n\nRound ${round} reached maximum of ${maxRounds}.\n\nManual intervention required.`,
      };
    }

    // All resolved = checklist is empty (resolved items are removed per spec)
    const allResolved = checklistItems.length === 0;
    if (allResolved && existingComment) {
      // Delete checklist comment
      try {
        await apiRequest('DELETE', `/repos/${repo}/issues/comments/${existingComment.id}`, token);
      } catch (e) {
        console.error(`[ReviewCommand] Failed to delete checklist comment: ${e.message}`);
      }

      // Post approved comment
      await apiRequest('POST', `/repos/${repo}/issues/${prNum}/comments`, token, {
        body: `✅ **Approved** — all checklist items resolved.\n\nReviewed by @${myLogin}`,
      });

      // Set gtw/lgtm
      try {
        await setGtwLabel(prNum, token, repo, 'gtw/lgtm', true);
      } catch (e) {
        return { ok: false, message: `⚠️ ${e.message}` };
      }

      // Clear wip review state for this PR
      const updatedWip = { ...currentWip };
      const newReviewState = { ...(updatedWip.reviewState || {}) };
      delete newReviewState[thisPrKey];
      updatedWip.reviewState = newReviewState;
      updatedWip.updatedAt = new Date().toISOString();
      saveWip(updatedWip);

      return {
        ok: true,
        approved: true,
        repo,
        pr: prData.pr,
        round,
        message: `✅ PR #${prNum} approved — all checklist items resolved`,
        display: `✅ PR #${prNum} approved\n\n${prData.pr.title}\n\nAll checklist items resolved. Ready to merge.`,
      };
    }

    // Unresolved items remain → changes needed.
    // Set gtw/revise (replaces gtw/wip). Keep checklist comment intact
    // so round continues to increment when developer re-submits after fixes.
    // PR stays with gtw/revise until developer addresses issues.

    // Apply gtw/revise (replaces gtw/wip) — this is the final state
    try {
      await setGtwLabel(prNum, token, repo, 'gtw/revise', true);
    } catch (e) {
      return { ok: false, message: `⚠️ ${e.message}` };
    }

    // Post a "changes needed" comment
    const unresolvedList = checklistItems.map((i) => `  - [ ] ${i.text}`).join('\n');
    await apiRequest('POST', `/repos/${repo}/issues/${prNum}/comments`, token, {
      body: `⚠️ **Changes needed** (Round ${round}/${maxRounds})\n\n${unresolvedList}\n\n_Please address the above items and resubmit for review._`,
    });

    // Clear wip review state — this review session is done
    const updatedWip = { ...currentWip };
    const newReviewState = { ...(updatedWip.reviewState || {}) };
    delete newReviewState[thisPrKey];
    updatedWip.reviewState = newReviewState;
    updatedWip.updatedAt = new Date().toISOString();
    saveWip(updatedWip);

    // Build diff summary
    const filesSummary = prData.files
      .map((f) => `  - ${f.filename}: +${f.additions} -${f.deletions}`)
      .join('\n');

    const linkedIssueLine =
      prData.linkedIssue.number
        ? `Linked Issue: #${prData.linkedIssue.number} — ${prData.linkedIssue.title || 'none'}`
        : 'Linked Issue: none';

    return {
      ok: true,
      claimed: true,
      repo,
      pr: prData.pr,
      linkedIssue: prData.linkedIssue,
      files: prData.files,
      checklist: checklistItems,
      round,
      maxRounds,
      message: `⚠️ PR #${prNum} needs changes (Round ${round}/${maxRounds})\n\n${prData.pr.title}\n\n${linkedIssueLine}\n\nFiles changed (${prData.files.length}):\n${filesSummary}\n\nUnresolved items (${checklistItems.length}):\n${checklistItems.map((i) => '  - ' + i.text).join('\n')}\n\ngtw/revise set. Review round preserved for next invocation.`,
      display: [
        `⚠️ PR #${prNum} needs changes (Round ${round}/${maxRounds})`,
        ``,
        `${prData.pr.title}`,
        ``,
        linkedIssueLine,
        ``,
        `Files changed (${prData.files.length}):`,
        filesSummary || '(none)',
        ``,
        `Unresolved (${checklistItems.length}):`,
        ...checklistItems.map((i) => `  - [ ] ${i.text}`),
        ``,
        `gtw/revise set. PR stays in gtw/revise until developer addresses issues.`,
      ].join('\n'),
    };
  }
}
