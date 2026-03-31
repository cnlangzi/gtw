import { execSync } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { Commander } from './Commander.js';
import { getWip, saveWip } from '../utils/wip.js';
import { git, getDefaultBranch, getRemoteRepo } from '../utils/git.js';
import { apiRequest, getValidToken } from '../utils/api.js';
import { resolveModel } from '../utils/ai.js';
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
  while (true) {
    try {
      execSync(`git rev-parse --verify ${name}`, { cwd: workdir, stdio: 'pipe' });
      // branch exists
      suffix++;
      name = `fix/${baseName}-${suffix}`;
    } catch {
      // branch does not exist, we're good
      break;
    }
  }
  return name;
}

// Fetch a GitHub issue by number from the repo configured in wip
async function fetchIssue(issueId, token, repo) {
  const data = await apiRequest('GET', `/repos/${repo}/issues/${issueId}`, token);
  return data;
}

// Get the main agent session file path
function getMainSessionFile() {
  const sessionsPath = join(homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
  if (!existsSync(sessionsPath)) return null;
  try {
    const data = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    // Try main:main key first
    const key = 'agent:main:main';
    const entry = data[key];
    if (entry?.sessionFile && existsSync(entry.sessionFile)) {
      return { key, file: entry.sessionFile };
    }
    // Fallback: find first entry that has a sessionFile
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith('agent:') && v?.sessionFile && existsSync(v.sessionFile)) {
        return { key: k, file: v.sessionFile };
      }
    }
  } catch {}
  return null;
}

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
    `1. Spawn a coding subagent (mode=run) in the workdir "${workdir}" with the following task:`,
    ``,
    `   Task:`,
    `   ===`,
    `   You are fixing GitHub issue #${issueId}: "${issueTitle}"`,
    ``,
    `   Repository: ${workdir}`,
    `   Branch: ${branchName}`,
    ``,
    `   Issue description:`,
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
    `4. After push completes (or if no changes), update ${join(homedir(), '.openclaw', 'gtw', 'wip.json')}:`,
    `   - Set latestFixStatus to "success" if push succeeded, "no-changes" if nothing to commit, or "failure" if error`,
    `   - Add fields: latestFixBranch, latestFixCommitTitle, latestFixPushedAt`,
    ``,
    `5. Reply to this message with a summary of what was done`,
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

    // Step 3: Fetch issue from GitHub
    let issue;
    try {
      const token = await getValidToken();
      issue = await fetchIssue(issueId, token, repo);
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

    // Step 4: Derive branch name
    const baseBranchName = formatBranchName(issueTitle);
    if (!baseBranchName) {
      return { ok: false, message: '⚠️ Could not derive branch name from issue title. Title may contain only special characters.' };
    }

    // Step 5: Git setup — fetch, checkout default branch, pull, create branch
    let branchName;
    try {
      git('git fetch origin', workdir);
      const defaultBranch = getDefaultBranch(workdir);
      git(`git checkout ${defaultBranch}`, workdir);
      git(`git pull --rebase origin ${defaultBranch}`, workdir);
      branchName = ensureUniqueBranch(workdir, baseBranchName);
      git(`git checkout -b ${branchName}`, workdir);
    } catch (e) {
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
      latestFixStatus: 'fix-spawned',
      updatedAt: now,
    };
    saveWip(updated);

    // Step 7: Inject directive into main session to trigger subagent workflow
    const mainSession = getMainSessionFile();
    if (mainSession) {
      const injected = injectFixDirective(
        mainSession.key,
        mainSession.file,
        issueId,
        workdir,
        branchName,
        issueTitle,
        issueBody,
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
