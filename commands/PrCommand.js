import { Commander } from './Commander.js';
import { getWip, saveWip } from '../utils/wip.js';
import { getCurrentBranch, getDefaultBranch, tryCheckoutRemoteBranch, getCommitLogDiff } from '../utils/git.js';
import { callAI, resolveModel } from '../utils/ai.js';
import { getValidToken } from '../utils/api.js';
import { GitHubClient } from '../utils/github.js';
import { getConfig, getLangLabel } from '../utils/config.js';
import { logParseFailure } from '../utils/log.js';

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

async function generatePrTitleBody({ diff, branch, issueTitle, issueBody, issueId, baseBranch, lang, sessionKey }) {
  const { model } = await resolveModel(sessionKey);

  const langLabel = getLangLabel(lang);

  const systemPrompt = `You are a senior software engineer writing professional pull request descriptions.
You output ONLY valid JSON. No markdown. No explanation. No text outside the JSON object.
Generate the PR title and body in ${langLabel}.

Output format:
{"title":"Brief PR title (50-72 chars)","body":"PR body with: What changed, Why it changed, How to test. Be concise and informative."}`;

  let userPrompt;
  if (issueId) {
    userPrompt = `Generate a PR title and body for this pull request.
Generate the PR title and body in ${langLabel}.

Issue: #${issueId} — ${issueTitle}
${issueBody ? `Issue Description:\n${issueBody}\n` : ''}
Head Branch: ${branch}
Base Branch: ${baseBranch}

Recent commits on ${branch} vs ${baseBranch}:
${diff}

Output ONLY valid JSON.`;
  } else {
    userPrompt = `Generate a PR title and body for this pull request.
Generate the PR title and body in ${langLabel}.

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


// ---------------------------------------------------------------------------
// PrCommand
// ---------------------------------------------------------------------------

export class PrCommand extends Commander {
  constructor(context) {
    super(context);
    this.sessionKey = context.sessionKey;
  }

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
    let checkoutStatus = null; // 'remote-synced' | 'local-only' | 'not-found'
    let derivedBranchName = null; // the fix/<normalized-title> we aimed for

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
        const client = new GitHubClient(token);
        issue = await client.request('GET', `/repos/${wip.repo}/issues/${issueId}`);
      } catch (e) {
        if (e.message.includes('404')) {
          throw new Error(`Issue #${issueId} not found in ${wip.repo}. Check the issue number.`);
        }
        throw new Error(`Failed to fetch issue #${issueId}: ${e.message}`);
      }

      issueTitle = issue.title || '(no title)';
      issueBody = issue.body || '';

      // Derive branch name from issue title (same format as /gtw fix)
      const baseBranchName = formatBranchName(issueTitle);
      if (!baseBranchName) {
        throw new Error('Could not derive branch name from issue title.');
      }

      derivedBranchName = `fix/${baseBranchName}`;

      // Robust checkout: handle remote-exists, local-only, not-found cases
      checkoutStatus = await tryCheckoutRemoteBranch(workdir, derivedBranchName);
      headBranch = checkoutStatus.branch;
    }
    // -------------------------------------------------------------------
    // Mode: /gtw pr (no args) — always use current branch, never wip.json
    // -------------------------------------------------------------------
    else {
      headBranch = await getCurrentBranch(workdir);
      if (!headBranch) {
        throw new Error('Not on any branch. Use /gtw fix <issue_id> to create a branch first.');
      }
      checkoutStatus = { status: 'current-branch', branch: headBranch };
    }

    const baseBranch = getDefaultBranch(workdir);

    // Compute commit log diff
    const diff = getCommitLogDiff(workdir, headBranch, baseBranch);

    if (!diff || !diff.trim()) {
      let noDiffMessage;
      if (checkoutStatus?.status === 'local-only') {
        noDiffMessage = `⚠️  Remote branch missing — please run /gtw push to publish this branch before creating a PR.`;
      } else {
        noDiffMessage = `⚠️  No commits to create a PR from`;
      }
      return {
        ok: true,
        branch: headBranch,
        noDiff: true,
        message: 'No commit differences found between branch and default branch. Nothing to PR.',
        display: [
          noDiffMessage,
          ``,
          `Branch: ${headBranch}`,
          `Base: ${baseBranch}`,
          ``,
          `There are no commits on ${headBranch} that are not on ${baseBranch}.`,
          checkoutStatus?.status === 'local-only'
            ? `Run /gtw push, then /gtw pr again.`
            : `Make some commits first, then run /gtw pr again.`,
        ].join('\n'),
      };
    }

    // Truncate diff if too long
    const truncatedDiff = diff.length > MAX_DIFF_LEN
      ? diff.slice(0, MAX_DIFF_LEN) + `\n\n... (${diff.length - MAX_DIFF_LEN} chars omitted)`
      : diff;

    // Resolve repo language: lang:<owner/repo> from config, default 'en'
    let lang = 'en';
    try {
      const gtwConfig = getConfig();
      const langKey = wip.repo ? `lang:${wip.repo}` : null;
      lang = langKey ? (gtwConfig[langKey] || 'en') : 'en';
    } catch {}

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
        sessionKey: this.sessionKey,
        lang,
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
      // Log raw response for debugging
      logParseFailure('pr', { branch: headBranch, baseBranch, issueId, rawTextLength: prData.rawText?.length, rawText: prData.rawText });

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

    // Build branch note based on checkout status
    let branchNote = '';
    if (checkoutStatus?.status === 'local-only') {
      branchNote = `\n⚠️  Remote branch missing — please run /gtw push to publish this branch`;
    } else if (checkoutStatus?.status === 'not-found' && derivedBranchName) {
      branchNote = `\n⚠️  Branch \`${derivedBranchName}\` not found (remote or local) — using current branch \`${headBranch}\``;
    }

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
