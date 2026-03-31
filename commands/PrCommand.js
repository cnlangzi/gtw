import { Commander } from './Commander.js';
import { getWip, saveWip } from '../utils/wip.js';
import { git, getCurrentBranch, getDefaultBranch } from '../utils/git.js';
import { callAI, resolveModel } from '../utils/ai.js';
import { getValidToken, apiRequest } from '../utils/api.js';

const MAX_DIFF_LEN = 8000;

// ---------------------------------------------------------------------------
// Branch name formatting (same as FixCommand)
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

// ---------------------------------------------------------------------------
// LLM response parsing
// ---------------------------------------------------------------------------

function parsePrResponse(rawText) {
  const strategies = [
    () => JSON.parse(rawText),
    () => {
      const inner = JSON.parse(rawText);
      return typeof inner === 'string' ? JSON.parse(inner) : inner;
    },
    () => {
      const clean = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const match = clean.match(/\{[\s\S]*?\}/);
      return match ? JSON.parse(match[0]) : null;
    },
  ];

  for (const strategy of strategies) {
    try {
      const obj = strategy();
      if (obj && typeof obj === 'object' && !Array.isArray(obj) && (obj.title || obj.body)) {
        return { title: (obj.title || '').trim(), body: (obj.body || '').trim() };
      }
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Generate PR title/body via LLM
// ---------------------------------------------------------------------------

async function generatePrTitleBody({ diff, branch, issueTitle, issueBody, issueId, baseBranch }) {
  const { model } = await resolveModel();

  const systemPrompt = `You are a senior software engineer writing professional pull request descriptions.
You output ONLY valid JSON. No markdown. No explanation. No text outside the JSON object.

Output format:
{"title":"Brief PR title (50-72 chars)","body":"PR body with: What changed, Why it changed, How to test. Be concise and informative."}`;

  let userPrompt;
  if (issueId) {
    userPrompt = `Generate a PR title and body for this pull request.

Issue: #${issueId} — ${issueTitle}
${issueBody ? `Issue Description:\n${issueBody}\n` : ''}
Head Branch: ${branch}
Base Branch: ${baseBranch}

Recent commits on ${branch} vs ${baseBranch}:
${diff}

Output ONLY valid JSON.`;
  } else {
    userPrompt = `Generate a PR title and body for this pull request.

Head Branch: ${branch}
Base Branch: ${baseBranch}

Recent commits on ${branch} vs ${baseBranch}:
${diff}

Output ONLY valid JSON.`;
  }

  const rawText = await callAI(model, systemPrompt, userPrompt);
  const parsed = parsePrResponse(rawText);
  return { ...parsed, rawText };
}

// ---------------------------------------------------------------------------
// Get commit log diff between two branches
// ---------------------------------------------------------------------------

function getCommitLogDiff(workdir, headBranch, baseBranch) {
  try {
    return git(`git log ${baseBranch}..${headBranch} --oneline --format="%h %s"`, workdir);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Try to checkout a remote tracking branch (no local creation).
// If the remote branch doesn't exist, stay on the current branch silently.
// ---------------------------------------------------------------------------

function tryCheckoutRemoteBranch(workdir, branchName) {
  const current = getCurrentBranch(workdir);
  try {
    // Fetch all remote refs first
    git('git fetch origin', workdir);
    // Try to create a tracking branch from remote
    git(`git checkout -b ${branchName} origin/${branchName}`, workdir);
    return { switched: true, branch: branchName };
  } catch {
    // Remote branch doesn't exist — stay on current branch, no error
    return { switched: false, branch: current };
  }
}

// ---------------------------------------------------------------------------
// PrCommand
// ---------------------------------------------------------------------------

export class PrCommand extends Commander {
  async execute(args) {
    const wip = getWip();
    if (!wip.workdir) throw new Error('No workdir set. Run /gtw on <workdir> first');
    if (!wip.repo) throw new Error('No repo set. Run /gtw on <workdir> first');

    const workdir = wip.workdir;
    const issueIdArg = args[0];

    let headBranch;
    let issueId = null;
    let issueTitle = null;
    let issueBody = null;
    let derivedFromIssue = false;

    // -------------------------------------------------------------------
    // Mode: /gtw pr <issue_id>
    // -------------------------------------------------------------------
    if (issueIdArg) {
      issueId = parseInt(issueIdArg, 10);
      if (isNaN(issueId) || issueId <= 0) {
        throw new Error(`Invalid issue ID: "${issueIdArg}". Must be a positive integer.`);
      }

      // Fetch issue from GitHub
      let issue;
      try {
        const token = await getValidToken();
        issue = await apiRequest('GET', `/repos/${wip.repo}/issues/${issueId}`, token);
      } catch (e) {
        if (e.message.includes('404')) {
          throw new Error(`Issue #${issueId} not found in ${wip.repo}. Check the issue number.`);
        }
        throw new Error(`Failed to fetch issue #${issueId}: ${e.message}`);
      }

      issueTitle = issue.title || '(no title)';
      issueBody = issue.body || '';
      derivedFromIssue = true;

      // Derive branch name from issue title
      const baseBranchName = formatBranchName(issueTitle);
      if (!baseBranchName) {
        throw new Error('Could not derive branch name from issue title.');
      }

      headBranch = `fix/${baseBranchName}`;

      // Try to checkout remote tracking branch (never creates locally)
      const currentBeforeFetch = getCurrentBranch(workdir);
      const checkout = tryCheckoutRemoteBranch(workdir, headBranch);
      headBranch = checkout.branch;

      if (!checkout.switched) {
        // Remote branch didn't exist — stay on current branch, notify user
        const current = getCurrentBranch(workdir);
        if (current) headBranch = current;
        // Will surface in display below
      }
    }

    // Inform user if we couldn't switch to the issue-derived branch
    const couldNotSwitch = issueIdArg && headBranch !== `fix/${formatBranchName(issueTitle)}`;
    const switchedAwayFrom = issueIdArg ? `fix/${formatBranchName(issueTitle)}` : null;
    // -------------------------------------------------------------------
    // Mode: /gtw pr (no args)
    // -------------------------------------------------------------------
    else {
      headBranch = getCurrentBranch(workdir);
      if (!headBranch) {
        throw new Error('Not on any branch. Use /gtw fix <issue_id> to create a branch first.');
      }
    }

    const baseBranch = getDefaultBranch(workdir);

    // Compute commit log diff
    const diff = getCommitLogDiff(workdir, headBranch, baseBranch);

    if (!diff || !diff.trim()) {
      return {
        ok: true,
        branch: headBranch,
        noDiff: true,
        message: 'No commit differences found between branch and default branch. Nothing to PR.',
        display: [
          `⚠️  No commits to create a PR from`,
          ``,
          `Branch: ${headBranch}`,
          `Base: ${baseBranch}`,
          ``,
          `There are no commits on ${headBranch} that are not on ${baseBranch}.`,
          `Make some commits first, then run /gtw pr again.`,
        ].join('\n'),
      };
    }

    // Truncate diff if too long
    const truncatedDiff = diff.length > MAX_DIFF_LEN
      ? diff.slice(0, MAX_DIFF_LEN) + `\n\n... (${diff.length - MAX_DIFF_LEN} chars omitted)`
      : diff;

    // Generate PR title/body via LLM
    let prData;
    try {
      prData = await generatePrTitleBody({
        diff: truncatedDiff,
        branch: headBranch,
        issueTitle,
        issueBody,
        issueId,
        baseBranch,
      });
    } catch (e) {
      return {
        ok: false,
        branch: headBranch,
        message: `LLM generation failed: ${e.message}`,
        display: [
          `❌ LLM generation failed`,
          ``,
          `Error: ${e.message}`,
          ``,
          `Please try again or check your model configuration (/gtw model).`,
        ].join('\n'),
      };
    }

    if (!prData.title) {
      const preview = prData.rawText?.slice(0, 300).replace(/\n/g, ' ') || '(empty)';
      return {
        ok: false,
        branch: headBranch,
        message: `LLM returned invalid response`,
        display: [
          `❌ LLM returned invalid JSON. Could not extract PR title.`,
          ``,
          `Raw response (first 300 chars): ${preview}`,
          ``,
          `Please try again.`,
        ].join('\n'),
      };
    }

    // Save pending PR to wip
    const pendingPr = {
      headBranch,
      baseBranch,
      title: prData.title,
      body: prData.body,
      issueId,
      issueTitle,
      workdir,
      createdAt: new Date().toISOString(),
    };

    const updated = {
      ...wip,
      pendingPr,
      updatedAt: new Date().toISOString(),
    };
    saveWip(updated);

    // Build preview
    const issueSection = issueId
      ? `\nIssue: #${issueId} — ${issueTitle}`
      : '';

    const branchNote = couldNotSwitch
      ? `\n⚠️  Remote branch \`${switchedAwayFrom}\` not found — using current branch \`${headBranch}\``
      : '';

    const bodySection = prData.body ? `\n\n📄 PR Body:\n${prData.body}` : '';

    return {
      ok: true,
      branch: headBranch,
      pendingPr,
      message: `🔍 PR draft ready — run /gtw confirm to create PR`,
      display: [
        `🔍 PR draft — run /gtw confirm to create PR`,
        ``,
        `📝 Title:\n${prData.title}`,
        bodySection,
        ``,
        `🌿 Branch: ${headBranch}${branchNote}`,
        `📚 Base: ${baseBranch}${issueSection}`,
        ``,
        `Run /gtw confirm to create the PR on GitHub.`,
      ].join('\n'),
    };
  }
}
