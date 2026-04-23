import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { Commander } from './Commander.js';
import { getSessionFile } from '../utils/session.js';
import { getWip, saveWip } from '../utils/wip.js';
import { git, getDefaultBranch, getRemoteRepo, fetch, checkout, branchExists } from '../utils/git.js';
import { getValidToken } from '../utils/api.js';
import { GitHubClient } from '../utils/github.js';
import { resolveModel } from '../utils/ai.js';
import { WIP_FILE } from '../utils/config.js';
import https from 'https';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// Fetch a GitHub issue by number from the repo configured in wip
async function fetchIssue(issueId, repo, client) {
  const data = await client.request('GET', `/repos/${repo}/issues/${issueId}`);
  return data;
}

// Claim an issue by adding the "gtw/wip" label.
// Returns { ok: true } on success.
// Returns { ok: false, reason: 'already_claimed' } if the label is already present.
async function claimIssue(issueId, repo, client) {
  // First check if gtw/wip label already exists on this issue
  const labelsData = await client.request('GET', `/repos/${repo}/issues/${issueId}/labels`);
  const hasWip = labelsData.some(l => l.name === 'gtw/wip');
  if (hasWip) {
    return { ok: false, reason: 'already_claimed' };
  }
  // Try to add the label
  try {
    await client.request('POST', `/repos/${repo}/issues/${issueId}/labels`, {
      labels: ['gtw/wip'],
    });
    return { ok: true };
  } catch (e) {
    // 422 = label already exists (race condition), treat as already claimed
    if (e.message.includes('422')) {
      return { ok: false, reason: 'already_claimed' };
    }
    throw e;
  }
}

// Remove the "gtw/wip" label from an issue (for cleanup after fix done/failed).
async function unclaimIssue(issueId, repo, client) {
  try {
    await client.request('DELETE', `/repos/${repo}/issues/${issueId}/labels/gtw/wip`);
  } catch (e) {
    // 404 = label wasn't there, ignore
    if (!e.message.includes('404')) {
      console.error(`[FixCommand] Warning: failed to unclaim issue #${issueId}: ${e.message}`);
    }
  }
}

// Get the main agent session file path
// Inject a directive message into the main session transcript
function injectFixDirective(sessionKey, sessionFile, issueId, workdir, branchName, issueTitle, issueBody) {
  const directive = [
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

  try {
    const entry = JSON.stringify({
      type: 'message',
      id: `gtw-fix-${Date.now()}`,
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text: directive }],
      },
    });
    appendFileSync(sessionFile, entry + '\n');
    return true;
  } catch (e) {
    return false;
  }
}

// Check if the main session has been injected with a gtw fix directive
function wasInjected(sessionFile) {
  try {
    const content = readFileSync(sessionFile, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const text = Array.isArray(entry.message?.content)
          ? entry.message.content.map(c => c.type === 'text' ? c.text : '').join('')
          : String(entry.message?.content || '');
        if (entry.message?.role === 'user' && text.includes('[gtw fix] Subagent fix workflow triggered')) {
          return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

// ---------------------------------------------------------------------------
// FixCommand
// ---------------------------------------------------------------------------

export class FixCommand extends Commander {
  constructor(context) {
    super(context);
    this.api = context.api;
    this.config = context.config;
    this.sessionKey = context.sessionKey;
    this.injectMessage = context.injectMessage;
  }

  async execute(args) {
    // Step 1: Validate issue_id
    const issueIdArg = args[0];
    if (!issueIdArg) {
      return { ok: false, message: '⚠️ Usage: /gtw fix <issue_id>\nExample: /gtw fix 13' };
    }
    const issueId = parseInt(issueIdArg, 10);
    if (isNaN(issueId) || issueId <= 0) {
      return { ok: false, message: `⚠️ Invalid issue ID: "${issueIdArg}". Must be a positive integer.` };
    }

    // Step 2: Check wip for workdir + repo
    const wip = getWip();
    if (!wip.workdir) {
      return { ok: false, message: '⚠️ No workdir set. Run /gtw on <workdir> first' };
    }
    if (!wip.repo) {
      return { ok: false, message: '⚠️ No repo set. Run /gtw on <workdir> first' };
    }

    const workdir = wip.workdir;
    const repo = wip.repo;

    // Get token once and reuse throughout the command
    const token = await getValidToken();
    const client = new GitHubClient(token);

    // Step 3: Fetch issue from GitHub
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

    // Step 4: Claim the issue (add gtw/wip label) before any work
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

    // Step 5: Derive branch name
    const baseBranchName = formatBranchName(issueTitle);
    if (!baseBranchName) {
      return { ok: false, message: '⚠️ Could not derive branch name from issue title. Title may contain only special characters.' };
    }

    // Step 6: Git setup — fetch, checkout default branch, pull, create branch
    let branchName;
    try {
      await fetch(workdir, { remote: 'origin' });
      const defaultBranch = getDefaultBranch(workdir);
      await checkout(workdir, defaultBranch);
      git(`git reset --hard origin/${defaultBranch}`, workdir);
      branchName = ensureUniqueBranch(workdir, baseBranchName);
      await checkout(workdir, branchName, { force: true });
    } catch (e) {
      // Best-effort attempt to remove the gtw/wip label before returning the failure.
      // Errors from unclaimIssue() are logged but do not mask the original git error.
      try {
        await unclaimIssue(issueId, repo, client);
      } catch (unclaimErr) {
        console.error('[FixCommand] Warning: unclaimIssue() failed during git error recovery', unclaimErr);
      }
      return { ok: false, message: `⚠️ Git branch creation failed: ${e.message}` };
    }

    // Step 6: Save wip with fix metadata (minimal — do NOT store full issue body)
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

    // Step 7: Inject directive into main session to trigger subagent workflow
    const sessionFile = getSessionFile(this.sessionKey);
    if (sessionFile) {
      const injected = injectFixDirective(
        this.sessionKey,
        sessionFile,
        issueId,
        workdir,
        branchName,
        issueTitle,
        wip.issue?.body || '',
      );
      if (!injected) {
        console.error('[FixCommand] Warning: failed to inject directive into main session');
      }
    }

    const displayLines = [
      `🌿 Fix workflow started`,
      ``,
      `Issue: #${issueId}`,
      `Title: ${issueTitle}`,
      `Branch: ${branchName}`,
      ``,
      `GitHub: https://github.com/${repo}/issues/${issueId}`,
      ``,
      `⏳ Subagent spawned — the main session will now:`,
      `1. Spawn coding subagent to fix the issue`,
      `2. Wait for subagent to finish`,
      `3. Run push + confirm automatically`,
      ``,
      `You'll be notified when push completes.`,
    ];

    return {
      ok: true,
      branch: branchName,
      issueId,
      issueTitle,
      workdir,
      message: '🌿 Fix workflow started — subagent is being spawned',
      display: displayLines.join('\n'),
    };
  }
}
