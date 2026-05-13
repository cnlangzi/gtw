import { read, write, exists } from '../utils/fs.js';
import { join } from 'path';
import { Commander } from './Commander.js';
import { getWip, saveWip } from '../utils/wip.js';
import { git, getDefaultBranch, getRemoteRepo, fetch, checkout, branchExists } from '../utils/git.js';
import { getValidToken } from '../utils/api.js';
import { GitHubClient } from '../utils/github.js';
import { WIP_FILE } from '../utils/config.js';

function formatBranchName(title) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
  return base;
}

function ensureUniqueBranch(workdir, baseName) {
  let name = `fix/${baseName}`;
  let suffix = 0;
  while (branchExists(workdir, name)) {
    suffix++;
    name = `fix/${baseName}-${suffix}`;
  }
  return name;
}

async function fetchIssue(issueId, repo, client) {
  const data = await client.request('GET', `/repos/${repo}/issues/${issueId}`);
  return data;
}

async function claimIssue(issueId, repo, client) {
  const labelsData = await client.request('GET', `/repos/${repo}/issues/${issueId}/labels`);
  const hasWip = labelsData.some(l => l.name === 'gtw/wip');
  if (hasWip) {
    return { ok: false, reason: 'already_claimed' };
  }
  try {
    await client.request('POST', `/repos/${repo}/issues/${issueId}/labels`, {
      labels: ['gtw/wip'],
    });
    return { ok: true };
  } catch (e) {
    if (e.message.includes('422')) {
      return { ok: false, reason: 'already_claimed' };
    }
    throw e;
  }
}

async function unclaimIssue(issueId, repo, client) {
  try {
    await client.request('DELETE', `/repos/${repo}/issues/${issueId}/labels/gtw/wip`);
  } catch (e) {
    if (!e.message.includes('404')) {
      console.error(`[FixCommand] Warning: failed to unclaim issue #${issueId}: ${e.message}`);
    }
  }
}

export class FixCommand extends Commander {
  async execute(args) {
    const issueIdArg = args[0];
    if (!issueIdArg) {
      return { ok: false, message: '⚠️ Usage: /gtw fix <issue_id>\nExample: /gtw fix 13' };
    }
    const issueId = parseInt(issueIdArg, 10);
    if (isNaN(issueId) || issueId <= 0) {
      return { ok: false, message: `⚠️ Invalid issue ID: "${issueIdArg}". Must be a positive integer.` };
    }

    const wip = getWip();
    if (!wip.workdir) {
      return { ok: false, message: '⚠️ No workdir set. Run /gtw on <workdir> first' };
    }
    if (!wip.repo) {
      return { ok: false, message: '⚠️ No repo set. Run /gtw on <workdir> first' };
    }

    const workdir = wip.workdir;
    const repo = wip.repo;

    const token = await getValidToken();
    const client = new GitHubClient(token);

    let issue;
    try {
      issue = await fetchIssue(issueId, repo, client);
    } catch (e) {
      if (e.message.includes('404')) {
        return { ok: false, message: `⚠️ Issue #${issueId} not found in ${repo}. Check the issue number or repo.` };
      }
      if (e.message.includes('401') || e.message.includes('403')) {
        return { ok: false, message: '⚠️ GitHub API auth failed. Run: gh auth login' };
      }
      return { ok: false, message: `⚠️ Failed to fetch issue #${issueId}: ${e.message}` };
    }

    const issueTitle = issue.title || '(no title)';
    const issueBody = issue.body || '';

    try {
      const claimResult = await claimIssue(issueId, repo, client);
      if (!claimResult.ok) {
        return {
          ok: false,
          message: `⚠️ Issue #${issueId} is already claimed by another process (gtw/wip label present). Aborting to avoid conflicts.`,
        };
      }
    } catch (e) {
      if (e.message.includes('401') || e.message.includes('403')) {
        return { ok: false, message: '⚠️ GitHub API auth failed. Run: gh auth login' };
      }
      return { ok: false, message: `⚠️ Failed to claim issue #${issueId}: ${e.message}` };
    }

    const baseBranchName = formatBranchName(issueTitle);
    if (!baseBranchName) {
      return { ok: false, message: '⚠️ Could not derive branch name from issue title. Title may contain only special characters.' };
    }

    let branchName;
    try {
      await fetch(workdir, { remote: 'origin' });
      const defaultBranch = getDefaultBranch(workdir);
      await checkout(workdir, defaultBranch);
      git(`git reset --hard origin/${defaultBranch}`, workdir);
      branchName = ensureUniqueBranch(workdir, baseBranchName);
      await checkout(workdir, branchName, { force: true });
    } catch (e) {
      try {
        await unclaimIssue(issueId, repo, client);
      } catch (unclaimErr) {
        console.error('[FixCommand] Warning: unclaimIssue() failed during git error recovery', unclaimErr);
      }
      return { ok: false, message: `⚠️ Git branch creation failed: ${e.message}` };
    }

    const now = new Date().toISOString();
    const updated = {
      ...wip,
      issueId,
      branch: { name: branchName, createdAt: now },
      workdir,
      repo,
      claimed: true,
      latestFixStatus: 'fix-spawned',
      updatedAt: now,
    };
    saveWip(updated);

    const directive = this._buildFixDirective(issueId, workdir, branchName, issueTitle, issueBody);
    const injected = await this.enqueueDirective(directive);
    if (!injected) {
      console.error('[FixCommand] Failed to enqueue fix directive — subagent will not be spawned');
      return {
        ok: false,
        message: 'Failed to enqueue fix directive — subagent will not be spawned',
        branch: branchName,
        issueId,
        issueTitle,
        workdir,
      };
    }

    const displayLines = [
      `🌿 Fix workflow scheduled`,
      ``,
      `Issue: #${issueId}`,
      `Title: ${issueTitle}`,
      `Branch: ${branchName}`,
      ``,
      `GitHub: https://github.com/${repo}/issues/${issueId}`,
      ``,
      `⏳ Directive enqueued — subagent will be spawned when you confirm.`,
    ];

    return {
      ok: true,
      branch: branchName,
      issueId,
      issueTitle,
      workdir,
      message: '🌿 Fix workflow scheduled — confirm to spawn subagent',
      display: displayLines.join('\n'),
    };
  }

  _buildFixDirective(issueId, workdir, branchName, issueTitle, issueBody) {
    return [
      `📋 [gtw fix] Subagent fix workflow triggered for issue #${issueId}`,
      ``,
      `Branch: ${branchName}`,
      `Workdir: ${workdir}`,
      ``,
      `Please perform the following steps in order:`,
      ``,
      `1. Spawn a coding subagent (mode=run, runTimeoutSeconds=1800) in the workdir "${workdir}" with the following task:`,
      ``,
      `   Task:`,
      `   ===`,
      `   You are fixing GitHub issue #${issueId}: "${issueTitle}"`,
      ``,
      `   Repository: ${workdir}`,
      `   Branch: ${branchName}`,
      ``,
      `   Issue description (Implementation Brief):`,
      `   ${issueBody || '(no description)'}`,
      ``,
      `   Your job:`,
      `   - Read and understand the issue description above`,
      `   - Explore the codebase to understand what needs to be fixed`,
      `   - Make the necessary code changes`,
      `   - Do NOT run /gtw push or /gtw confirm`,
      `   - Report what you changed when done`,
      `   ===`,
      ``,
      `2. After the subagent finishes, check if any files were modified (git status)`,
      ``,
      `3. If files were modified:`,
      `   a. Run: git -C "${workdir}" add -A`,
      `   b. Run: git -C "${workdir}" diff --cached --stat`,
      `   c. Generate a commit message using AI (conventional commit format)`,
      `   d. Run: git -C "${workdir}" commit -m "title" -m "body"`,
      `   e. Run: git -C "${workdir}" push -u origin ${branchName}`,
      ``,
      `4. After push completes (or if no changes), update ${WIP_FILE}:`,
      `   - Set latestFixStatus to "success" if push succeeded, "no-changes" if nothing to commit, or "failure" if error`,
      `   - Add fields: latestFixBranch, latestFixCommitTitle, latestFixPushedAt`,
      ``,
      `5. After step 4 (regardless of outcome), remove the "gtw/wip" label from issue #${issueId} on GitHub:`,
      `   - Run: gh issue edit ${issueId} --remove-label gtw/wip`,
      `   - This cleanup step must run even if push failed or no changes were made`,
      ``,
      `6. Reply to this message with a summary of what was done (include whether label was cleaned up)`,
      ``,
      `IMPORTANT: Do this work now, step by step. Do not skip any step.`,
    ].join('\n');
  }
}