/**
 * /gtw review — PR Review Command
 *
 * Step 1: Duplicate Detection (detectReuse)
 * - Checks if new functions in PR duplicate existing functionality
 * - Uses git-aware per-branch codebase index
 * - Specialized LLM call for duplicate verdict
 *
 * Step 2: Unnecessary Cleanup Detection (detectUnnecessaryCleanup)
 * - Detects stylistic/improvement changes to intentionally non-standard code
 * - Phase A: Ref-based triage using codebase-index refs[]
 * - Phase B: LLM analysis of filtered candidates
 */

import { Commander } from './Commander.js';
import { getWip, saveWip } from '../utils/wip.js';
import { GitHubClient } from '../utils/github.js';
import { setPrLabel } from '../utils/labels.js';
import { detectReuse } from '../utils/review-reuse.js';
import { detectUnnecessaryCleanup } from '../utils/review-cleanup.js';
import { prepareReviewWorktree } from './ReviewWorktree.js';

/**
 * Compute verdict and PR label from detection results.
 * Exported for unit testing — mirrors the inline logic in _reviewPr.
 *
 * NOTE: Verdict is based ONLY on items.length and cleanups.length.
 * Error fields are intentionally ignored (detection may error with zero findings).
 */
export function computeReviewVerdict(duplicateResults, cleanupResults) {
  const items = duplicateResults?.items || [];
  const cleanups = cleanupResults?.cleanups || [];

  const totalReuseIssues = items.length;
  const totalCleanupIssues = cleanups.length;

  let finalLabel = 'gtw/lgtm';
  if (totalReuseIssues > 0 || totalCleanupIssues > 0) {
    finalLabel = 'gtw/revise';
  }

  return {
    finalLabel,
    totalReuseIssues,
    totalCleanupIssues,
    verdictText: finalLabel === 'gtw/lgtm' ? 'APPROVED' : 'CHANGES NEEDED',
  };
}

/**
 * Compute comment icons from detection results.
 * Exported for unit testing — mirrors the icon logic in _buildComment.
 */
export function computeReviewIcons(duplicateResults, cleanupResults) {
  const items = duplicateResults?.items || [];
  const cleanups = cleanupResults?.cleanups || [];

  const totalReuseIssues = items.length;
  const totalCleanupIssues = cleanups.length;

  return {
    reuseIcon: totalReuseIssues === 0 ? '☑️' : '❌',
    cleanupIcon: totalCleanupIssues === 0 ? '☑️' : '❌',
    totalReuseIssues,
    totalCleanupIssues,
  };
}

export class ReviewCommand extends Commander {
  constructor(context) {
    super(context);
    this.sessionKey = context.sessionKey;
  }

  async execute(args) {
    const wip = getWip();
    const repo = wip.repo;

    if (!repo) {
      return { ok: false, message: '⚠️ No repo set. Run /gtw on <workdir> first' };
    }

    // Parse optional PR number argument
    let targetPrNum = null;
    for (const a of args) {
      const m = String(a).match(/^(\d+)$/);
      if (m) {
        targetPrNum = parseInt(m[1]);
        break;
      }
    }

    if (!targetPrNum) {
      return { ok: false, message: '⚠️ PR number required. Usage: /gtw review <pr-number>' };
    }

    return this._reviewPr(targetPrNum, repo, wip);
  }

  async _reviewPr(prNum, repo, wip) {
    const token = await this._getToken();
    const client = new GitHubClient(token);

    // Fetch PR details
    let prData;
    try {
      prData = await this._fetchPrDetails(prNum, client, repo);
    } catch (e) {
      return { ok: false, message: `⚠️ Failed to fetch PR #${prNum}: ${e.message}` };
    }

    // Check stuck
    const labels = prData.pr.labels || [];
    if (labels.some((l) => l.name === 'gtw/stuck')) {
      return {
        ok: true,
        message: `⏸ PR #${prNum} is stuck. Manual intervention required.`,
      };
    }

    // Claim PR
    let preempted = false;
    try {
      const result = await setPrLabel({ prNum, repo, client, isPR: true }, 'gtw/wip');
      preempted = result.preempted;
    } catch (e) {
      return { ok: false, message: `⚠️ ${e.message}` };
    }

    if (preempted) {
      return {
        ok: false,
        message: `⚠️ PR #${prNum} was claimed by another runner.`,
      };
    }

    // Create worktree
    let worktreePath;
    try {
      worktreePath = await prepareReviewWorktree(
        repo,
        prNum,
        prData.pr.headRef,
        prData.baseBranch,
        prData.pr.cloneUrl
      );
    } catch (e) {
      // Rollback label on worktree failure
      try {
        await setPrLabel({ prNum, repo, client, isPR: true }, 'gtw/ready');
      } catch (rollbackErr) {
        console.error(`[ReviewCommand] Rollback failed: ${rollbackErr.message}`);
      }
      return {
        ok: false,
        message: `⚠️ Failed to create worktree: ${e.message}`,
      };
    }

    // Run Step 1 (detectReuse) and Step 2 (detectUnnecessaryCleanup) in parallel
    // Step 1 and Step 2 are independent — no shared reasoning
    const [duplicateResults, cleanupResults] = await Promise.all([
      (async () => {
        try {
          return await detectReuse(
            prNum,
            prData.baseBranch,
            worktreePath,
            repo,
            client,
            this.sessionKey
          );
        } catch (e) {
          console.error(`[ReviewCommand] Duplicate detection failed: ${e.message}`);
          return { error: e.message, items: [], newFunctions: [] };
        }
      })(),
      (async () => {
        // Build linked issue description for cleanup detection context
        let issueDescription = null;
        if (prData.linkedIssues && prData.linkedIssues.length > 0) {
          issueDescription = prData.linkedIssues
            .map(i => `Issue #${i.number}: ${i.title}\n${i.body || ''}`)
            .join('\n\n');
        }
        try {
          return await detectUnnecessaryCleanup(
            prNum,
            prData.baseBranch,
            worktreePath,
            repo,
            client,
            this.sessionKey,
            issueDescription
          );
        } catch (e) {
          console.error(`[ReviewCommand] Cleanup detection failed: ${e.message}`);
          return { error: e.message, cleanups: [], llmCandidates: [], skipped: [], modifiedFiles: 0 };
        }
      })(),
    ]);

    // Post comment with results (both steps)
    const comment = this._buildComment(prNum, prData, duplicateResults, cleanupResults);
    let commentId;
    try {
      commentId = await this._postComment(prNum, repo, client, comment);
    } catch (e) {
      console.error(`[ReviewCommand] Failed to post comment: ${e.message}`);
    }

    // Determine verdict — both Step 1 and Step 2 verdicts are independent
    // NOTE: We base the verdict ONLY on actual findings (items.length, cleanups.length),
    // NOT on the presence of an error field. Detection functions may error without
    // producing any findings (e.g., API timeout returns { error, items: [] }), and
    // such errors should NOT flip the label to gtw/revise. This ensures the published
    // comment (which uses the same totals for icons) is always consistent with the label.
    const { finalLabel, totalReuseIssues, totalCleanupIssues } = computeReviewVerdict(
      duplicateResults,
      cleanupResults
    );

    try {
      await setPrLabel({ prNum, repo, client, isPR: true }, finalLabel);
    } catch (e) {
      console.error(`[ReviewCommand] Failed to set label: ${e.message}`);
    }

    // Save review state
    const thisPrKey = `${repo}#${prNum}`;
    const newReviewState = {
      ...(wip.reviewState || {}),
      [thisPrKey]: {
        commentId,
        items: duplicateResults.items,
        cleanups: cleanupResults.cleanups || [],
        previousLabel: finalLabel,
        round: 1,
      },
    };
    saveWip({ ...wip, reviewState: newReviewState });

    // Build response
    // Recompute critical findings for summary display (only duplicate verdicts at critical/high severity block)
    const summaryCriticalItems = (duplicateResults.items || []).filter(
      (i) => i.verdict === 'duplicate' && ['critical', 'high'].includes(i.severity)
    );
    const summaryCriticalCleanups = (cleanupResults.cleanups || []).filter(
      (c) => ['critical', 'high'].includes(c.severity)
    );

    const verdictEmoji = finalLabel === 'gtw/lgtm' ? '✅' : '⚠️';
    const verdictText = finalLabel === 'gtw/lgtm' ? 'APPROVED' : 'CHANGES NEEDED';

    const summary = [
      `${verdictEmoji} PR #${prNum} ${verdictText}`,
      ``,
      prData.pr.title,
      ``,
      `Functions analyzed: ${duplicateResults.newFunctions?.length || 0}`,
      `Reuse issues: ${totalReuseIssues}`,
      `Cleanup issues: ${totalCleanupIssues}`,
    ];

    if (summaryCriticalItems.length > 0) {
      summary.push(``, `Duplicate functions (critical/high):`);
      for (const item of summaryCriticalItems) {
        summary.push(`  - ${item.newFunc} → duplicates ${item.existingFunc}`);
        summary.push(`    Reason: ${item.reason}`);
      }
    }

    if (summaryCriticalCleanups.length > 0) {
      summary.push(``, `Cleanup issues (critical/high):`);
      for (const cleanup of summaryCriticalCleanups) {
        summary.push(`  - ${cleanup.symbol} in ${cleanup.file}: ${cleanup.whyCleanup}`);
      }
    }

    return {
      ok: true,
      claimed: true,
      verdict: finalLabel,
      items: duplicateResults.items,
      cleanups: cleanupResults.cleanups || [],
      message: summary.join('\n'),
      display: summary.join('\n'),
    };
  }

  _sanitizeCell(value) {
    if (value == null) return '';
    return String(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  }

  _buildComment(prNum, prData, results, cleanupResults = {}) {
    const { reuseIcon, cleanupIcon, totalReuseIssues, totalCleanupIssues } = computeReviewIcons(
      results,
      cleanupResults
    );
    const items = results.items || [];
    const cleanups = cleanupResults.cleanups || [];

    let comment = '## GTW Code Review\n\n';

    // Status line: ☑️ when no issues, ❌ when issues present
    const reuseCount = totalReuseIssues > 0 ? ` (${totalReuseIssues})` : '';
    const cleanupCount = totalCleanupIssues > 0 ? ` (${totalCleanupIssues})` : '';
    comment += `${reuseIcon} Reuse Review${reuseCount} | ${cleanupIcon} Cleanup Review${cleanupCount}\n\n`;

    // Separator
    comment += '---\n\n';

    // Reuse Review findings grouped by severity (all verdict types grouped by severity only)
    const criticalItems = items.filter((i) => i.severity === 'critical');
    const highItems = items.filter((i) => i.severity === 'high');
    const mediumItems = items.filter((i) => i.severity === 'medium');
    const lowItems = items.filter((i) => i.severity === 'low');

    if (criticalItems.length > 0 || highItems.length > 0 || mediumItems.length > 0 || lowItems.length > 0) {
      comment += '### Reuse\n\n';

      // Critical
      if (criticalItems.length > 0) {
        comment += '#### Critical\n\n';
        comment += '| Function | File | Symbol | Reason |\n';
        comment += '|----------|------|--------|--------|\n';
        for (const item of criticalItems) {
          comment += `| ${this._sanitizeCell(item.newFunc)} | ${this._sanitizeCell(item.existingFile || '-')} | ${this._sanitizeCell(item.existingFunc)} | ${this._sanitizeCell(item.reason)} |\n`;
        }
        comment += '\n';
      }

      // High
      if (highItems.length > 0) {
        comment += '#### High\n\n';
        comment += '| Function | File | Symbol | Reason |\n';
        comment += '|----------|------|--------|--------|\n';
        for (const item of highItems) {
          comment += `| ${this._sanitizeCell(item.newFunc)} | ${this._sanitizeCell(item.existingFile || '-')} | ${this._sanitizeCell(item.existingFunc)} | ${this._sanitizeCell(item.reason)} |\n`;
        }
        comment += '\n';
      }

      // Medium
      if (mediumItems.length > 0) {
        comment += '#### Medium\n\n';
        comment += '| Function | File | Symbol | Reason |\n';
        comment += '|----------|------|--------|--------|\n';
        for (const item of mediumItems) {
          comment += `| ${this._sanitizeCell(item.newFunc)} | ${this._sanitizeCell(item.existingFile || '-')} | ${this._sanitizeCell(item.existingFunc)} | ${this._sanitizeCell(item.reason)} |\n`;
        }
        comment += '\n';
      }

      // Low
      if (lowItems.length > 0) {
        comment += '#### Low\n\n';
        comment += '| Function | File | Symbol | Reason |\n';
        comment += '|----------|------|--------|--------|\n';
        for (const item of lowItems) {
          comment += `| ${this._sanitizeCell(item.newFunc)} | ${this._sanitizeCell(item.existingFile || '-')} | ${this._sanitizeCell(item.existingFunc || '-')} | ${this._sanitizeCell(item.reason)} |\n`;
        }
        comment += '\n';
      }
    }

    // Cleanup Review findings grouped by severity
    const criticalCleanups = cleanups.filter((c) => c.severity === 'critical');
    const highCleanups = cleanups.filter((c) => c.severity === 'high');
    const mediumCleanups = cleanups.filter((c) => c.severity === 'medium');
    const lowCleanups = cleanups.filter((c) => c.severity === 'low');

    if (criticalCleanups.length > 0 || highCleanups.length > 0 || mediumCleanups.length > 0 || lowCleanups.length > 0) {
      comment += '### Cleanup\n\n';
    }

    if (criticalCleanups.length > 0) {
      comment += '#### Critical\n\n';
      comment += '| File | Symbol | Reason |\n';
      comment += '|------|--------|--------|\n';
      for (const c of criticalCleanups) {
        comment += `| ${this._sanitizeCell(c.file)} | ${this._sanitizeCell(c.symbol)} | ${this._sanitizeCell(c.whyCleanup)} |\n`;
      }
      comment += '\n';
    }

    // High
    if (highCleanups.length > 0) {
      comment += '#### High\n\n';
      comment += '| File | Symbol | Reason |\n';
      comment += '|------|--------|--------|\n';
      for (const c of highCleanups) {
        comment += `| ${this._sanitizeCell(c.file)} | ${this._sanitizeCell(c.symbol)} | ${this._sanitizeCell(c.whyCleanup)} |\n`;
      }
      comment += '\n';
    }

    // Medium
    if (mediumCleanups.length > 0) {
      comment += '#### Medium\n\n';
      comment += '| File | Symbol | Reason |\n';
      comment += '|------|--------|--------|\n';
      for (const c of mediumCleanups) {
        comment += `| ${this._sanitizeCell(c.file)} | ${this._sanitizeCell(c.symbol)} | ${this._sanitizeCell(c.whyCleanup)} |\n`;
      }
      comment += '\n';
    }

    // Low
    if (lowCleanups.length > 0) {
      comment += '#### Low\n\n';
      comment += '| File | Symbol | Reason |\n';
      comment += '|------|--------|--------|\n';
      for (const c of lowCleanups) {
        comment += `| ${this._sanitizeCell(c.file)} | ${this._sanitizeCell(c.symbol)} | ${this._sanitizeCell(c.whyCleanup)} |\n`;
      }
      comment += '\n';
    }

    // Reviewer tag
    comment += '*Reviewed by gtw*';

    return comment;
  }

  async _postComment(prNum, repo, client, body) {
    // Find existing comment by bot
    const comments = await client.request('GET', `/repos/${repo}/issues/${prNum}/comments`);
    const myLogin = (await client.request('GET', '/user')).login;
    const existing = comments.find((c) => c.user?.login === myLogin && c.body?.includes('## GTW Code Review'));

    if (existing) {
      await client.request('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, {
        body,
      });
      return existing.id;
    } else {
      const created = await client.request('POST', `/repos/${repo}/issues/${prNum}/comments`, { body });
      return created.id;
    }
  }

  async _fetchPrDetails(prNum, client, repo) {
    const [pr, files] = await Promise.all([
      client.request('GET', `/repos/${repo}/pulls/${prNum}`),
      client.request('GET', `/repos/${repo}/pulls/${prNum}/files?per_page=100`),
    ]);

    const linkedIssues = await this._findLinkedIssues(prNum, pr.body, client, repo);

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
        cloneUrl: pr.clone_url || `https://github.com/${repo}.git`,
        headRef: pr.head?.ref || '',
      },
      files: files.map((f) => ({
        filename: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch || '',
      })),
      linkedIssues,
      baseBranch: pr.base?.ref || 'main',
    };
  }

  async _findLinkedIssues(prNum, prBody, client, repo) {
    const [owner, repoName] = repo.split('/');

    // GraphQL — official "linked issues" from Development panel
    try {
      const gqlQuery = `query GetLinkedIssues($owner: String!, $repo: String!, $prNum: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $prNum) {
            closingIssuesReferences(first: 20) {
              nodes { number title body }
            }
          }
        }
      }`;
      const data = await client.graphql(gqlQuery, { owner, repo: repoName, prNum });
      const nodes = data?.repository?.pullRequest?.closingIssuesReferences?.nodes || [];
      if (nodes.length > 0) {
        return nodes.map((n) => ({
          number: n.number,
          title: n.title || '',
          body: n.body || '',
        }));
      }
    } catch (e) {
      // Fall through to regex
    }

    // REST regex fallback
    const issuesMap = new Map();
    const bodyMatches = prBody?.matchAll(/(?:closes?|fixes?|resolves?)\s*:?\s*#(\d+)/gi) || [];
    for (const match of bodyMatches) {
      issuesMap.set(parseInt(match[1]), { source: 'body-keyword' });
    }

    const linkedIssues = [];
    for (const [num] of issuesMap) {
      try {
        const issue = await client.request('GET', `/repos/${repo}/issues/${num}`);
        if (issue.pull_request) continue;
        linkedIssues.push({ number: issue.number, title: issue.title || '', body: issue.body || '' });
      } catch {}
    }
    return linkedIssues;
  }

  async _getToken() {
    const { getValidToken } = await import('../utils/api.js');
    return getValidToken();
  }
}
