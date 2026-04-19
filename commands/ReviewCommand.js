/**
 * /gtw review — PR Review Command
 *
 * Step 1 only: Duplicate Detection
 * - Checks if new functions in PR duplicate existing functionality
 * - Uses git-aware per-branch codebase index
 * - Specialized LLM call for duplicate verdict
 */

import { Commander } from './Commander.js';
import { getWip, saveWip } from '../utils/wip.js';
import { GitHubClient } from '../utils/github.js';
import { setPrLabel } from '../utils/labels.js';
import { detectDuplicates } from '../utils/duplicate-detector.js';
import { prepareReviewWorktree } from './ReviewWorktree.js';

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

    // Step 1: Duplicate Detection
    let duplicateResults;
    try {
      duplicateResults = await detectDuplicates(
        prNum,
        prData.baseBranch,
        worktreePath,
        repo,
        client,
        this.sessionKey
      );
    } catch (e) {
      console.error(`[ReviewCommand] Duplicate detection failed: ${e.message}`);
      duplicateResults = { items: [], newFunctions: [] };
    }

    // Post comment with results
    const comment = this._buildComment(prNum, prData, duplicateResults);
    let commentId;
    try {
      commentId = await this._postComment(prNum, repo, client, comment);
    } catch (e) {
      console.error(`[ReviewCommand] Failed to post comment: ${e.message}`);
    }

    // Determine verdict
    const criticalItems = duplicateResults.items.filter(
      (i) => i.verdict === 'duplicate' && ['critical', 'high'].includes(i.severity)
    );

    let finalLabel = 'gtw/lgtm';
    if (criticalItems.length > 0) {
      finalLabel = 'gtw/revise';
    }

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
        previousLabel: finalLabel,
        round: 1,
      },
    };
    saveWip({ ...wip, reviewState: newReviewState });

    // Build response
    const verdictEmoji = finalLabel === 'gtw/lgtm' ? '✅' : '⚠️';
    const verdictText = finalLabel === 'gtw/lgtm' ? 'APPROVED' : 'CHANGES NEEDED';

    const summary = [
      `${verdictEmoji} PR #${prNum} ${verdictText}`,
      ``,
      prData.pr.title,
      ``,
      `Functions analyzed: ${duplicateResults.newFunctions.length}`,
      `Duplicates found: ${criticalItems.length}`,
    ];

    if (criticalItems.length > 0) {
      summary.push(``, `Duplicate functions:`);
      for (const item of criticalItems) {
        summary.push(`  - ${item.newFunc} → duplicates ${item.existingFunc}`);
        summary.push(`    Reason: ${item.reason}`);
      }
    }

    return {
      ok: true,
      claimed: true,
      verdict: finalLabel,
      items: duplicateResults.items,
      message: summary.join('\n'),
      display: summary.join('\n'),
    };
  }

  _buildComment(prNum, prData, results) {
    const items = results.items || [];

    // Categorize items by verdict and severity
    const criticalItems = items.filter(
      (i) => i.verdict === 'duplicate' && ['critical', 'high'].includes(i.severity)
    );
    const similarItems = items.filter((i) => i.verdict === 'similar');
    const internalDuplicates = items.filter((i) => i.verdict === 'internal-duplicate');
    const patternItems = items.filter((i) => i.verdict === 'pattern');
    const mediumItems = items.filter(
      (i) => i.verdict === 'duplicate' && i.severity === 'medium'
    );
    const lowItems = items.filter(
      (i) => i.severity === 'low' && ['similar', 'pattern'].includes(i.verdict)
    );

    // Summary counts
    const summary = {
      critical: items.filter((i) => i.severity === 'critical').length,
      high: items.filter((i) => i.severity === 'high').length,
      medium: items.filter((i) => i.severity === 'medium').length,
      low: items.filter((i) => i.severity === 'low').length,
      internal: internalDuplicates.length,
    };

    let comment = '## 🔍 Code Reuse Review — PR #' + prNum + '\n\n';
    comment += '**PR:** #' + prNum + ' — ' + prData.pr.title + '\n';
    comment += '**Base:** ' + prData.baseBranch + '\n\n';

    comment += '### 📊 Summary\n\n';
    comment += '| Type | Count |\n';
    comment += '|------|-------|\n';
    comment += '| 🔴 Critical | ' + summary.critical + ' |\n';
    comment += '| 🟠 High | ' + summary.high + ' |\n';
    comment += '| 🟡 Medium | ' + summary.medium + ' |\n';
    comment += '| 🟢 Low | ' + summary.low + ' |\n';
    comment += '| 💡 Internal Duplicates | ' + summary.internal + ' |\n\n';

    comment += '### Functions Analyzed: ' + (results.newFunctions?.length || 0) + '\n\n';

    // Critical duplicates
    if (criticalItems.length > 0) {
      comment += '### 🚨 Critical Duplicates (' + criticalItems.length + ')\n\n';
      for (const item of criticalItems) {
        const severityEmoji = item.severity === 'critical' ? '🔴' : '🟠';
        comment += '**' + severityEmoji + ' `' + item.newFunc + '`** (' + item.existingFunc + ')\n';
        comment += '> ' + item.reason + '\n\n';
        if (item.code) {
          comment += '```\n' + item.code.slice(0, 200) + (item.code.length > 200 ? '...' : '') + '\n```\n\n';
        }
      }
    }

    // Similar patterns
    if (similarItems.length > 0) {
      comment += '### ⚠️ Similar Patterns (' + similarItems.length + ')\n\n';
      for (const item of similarItems) {
        comment += '- **`' + item.newFunc + '`** → similar to **`' + item.existingFunc + '`**: ' + item.reason + '\n';
      }
      comment += '\n';
    }

    // Internal duplicates
    if (internalDuplicates.length > 0) {
      comment += '### 💡 Internal Duplicates (' + internalDuplicates.length + ')\n\n';
      for (const item of internalDuplicates) {
        const occurrences = item.occurrences || [{ file: 'unknown', line: 0 }];
        const locList = occurrences.map((o) => '  - ' + o.file + ':' + o.line).join('\n');
        comment += '**`' + item.newFunc + '`** appears ' + occurrences.length + '× in this PR:\n' + locList + '\n';
        comment += '> ' + item.reason + '\n\n';
      }
    }

    // Pattern anti-patterns
    if (patternItems.length > 0) {
      comment += '### 🔧 Pattern Anti-Patterns (' + patternItems.length + ')\n\n';
      for (const item of patternItems) {
        comment += '- **`' + item.newFunc + '`**: ' + item.reason + '\n';
      }
      comment += '\n';
    }

    // Medium severity
    if (mediumItems.length > 0) {
      comment += '### 🟡 Medium Priority (' + mediumItems.length + ')\n\n';
      for (const item of mediumItems) {
        comment += '- **`' + item.newFunc + '`** → ' + item.existingFunc + ': ' + item.reason + '\n';
      }
      comment += '\n';
    }

    // Low priority
    if (lowItems.length > 0) {
      comment += '### 🟢 Low Priority (' + lowItems.length + ')\n\n';
      for (const item of lowItems) {
        comment += '- **`' + item.newFunc + '`**: ' + item.reason + '\n';
      }
      comment += '\n';
    }

    if (items.length === 0) {
      comment += '✅ **No duplicates, similar functions, or patterns found.**\n\n';
    }

    comment += '---\n*Code Reuse detection via SimHash + codebase index + fuzzy search + LLM semantic analysis*';

    return comment;
  }

  async _postComment(prNum, repo, client, body) {
    // Find existing comment by bot
    const comments = await client.request('GET', `/repos/${repo}/issues/${prNum}/comments`);
    const myLogin = (await client.request('GET', '/user')).login;
    const existing = comments.find((c) => c.user?.login === myLogin && c.body?.includes('## 🔍 Code Reuse Review'));

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
