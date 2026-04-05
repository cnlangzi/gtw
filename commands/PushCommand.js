import { Commander } from './Commander.js';
import { getWip, saveWip } from '../utils/wip.js';
import { git, getCurrentBranch, addAll, getStagedDiff, getStagedStats, getStagedNumstat } from '../utils/git.js';
import { callAI, resolveModel } from '../utils/ai.js';

const MAX_DIFF_LEN = 8000;

const BRANCH_TYPE_MAP = {
  fix: 'fix', hotfix: 'fix',
  feat: 'feat', feature: 'feat',
  chore: 'chore',
  docs: 'docs', documentation: 'docs',
  refactor: 'refactor',
  test: 'test',
  perf: 'perf', performance: 'perf',
  ci: 'ci', cd: 'cd',
  build: 'build', deps: 'deps', dependency: 'deps',
};

function getBranchType(branch) {
  for (const [prefix, type] of Object.entries(BRANCH_TYPE_MAP)) {
    if (branch.startsWith(prefix + '/') || branch.startsWith(prefix + '-')) {
      return type;
    }
  }
  return 'chore';
}

function parseCommitResponse(rawText) {
  const strategies = [
    () => JSON.parse(rawText),
    () => { const inner = JSON.parse(rawText); return typeof inner === 'string' ? JSON.parse(inner) : inner; },
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

async function generateCommitMessage(diff, branch, sessionKey) {
  const { model } = await resolveModel(sessionKey);
  const branchType = getBranchType(branch);

  const systemPrompt = `You are a senior software engineer writing professional git commit messages.
You output ONLY valid JSON. No markdown. No explanation. No text outside the JSON object.

Output format:
{"title":"fix(scope): brief description","body":"Extended description. Bullet points are preferred. Be concise, use imperative mood, cover what changed and why."}`;

  const truncated = diff.length > MAX_DIFF_LEN
    ? diff.slice(0, MAX_DIFF_LEN) + `\n\n... (diff truncated, ${diff.length - MAX_DIFF_LEN} chars omitted)`
    : diff;

  const userPrompt = `Generate a conventional commit message for this diff.

Branch: ${branch}
Suggested type: ${branchType}
Available types: fix, feat, chore, docs, refactor, test, perf, ci, build, deps

Diff:
${truncated}

Output ONLY valid JSON.`;

  const rawText = await callAI(model, systemPrompt, userPrompt);
  const parsed = parseCommitResponse(rawText);
  return { title: parsed?.title, body: parsed?.body, rawText };
}

export class PushCommand extends Commander {
  constructor(context) {
    super(context);
    this.sessionKey = context.sessionKey;
  }

  async execute(args) {
    const wip = getWip();
    if (!wip.workdir) throw new Error('No workdir set. Run /gtw on <workdir> first');

    const workdir = wip.workdir;
    const branch = getCurrentBranch(workdir);

    await addAll(workdir);

    const stats = getStagedStats(workdir);
    if (!stats) {
      return { ok: true, branch, message: 'No changes to commit', display: `✅ No changes to commit\n\nBranch: ${branch}` };
    }

    const diff = getStagedDiff(workdir);
    const files = git('git diff --cached --name-only', workdir).split('\n').filter(Boolean);
    const shortStats = getStagedNumstat(workdir);
    let totalAdd = 0, totalDel = 0;
    for (const l of shortStats.split('\n').filter(Boolean)) {
      const parts = l.split('\t');
      totalAdd += parseInt(parts[0], 10) || 0;
      totalDel += parseInt(parts[1], 10) || 0;
    }

    let msg;
    try {
      msg = await generateCommitMessage(diff, branch, this.sessionKey);
    } catch (e) {
      return {
        ok: false,
        branch,
        message: `⚠️ LLM call failed: ${e.message}`,
        display: [
          `❌ LLM generation failed`,
          ``,
          `Error: ${e.message}`,
          ``,
          `Please fix the issue and run /gtw push again.`,
        ].join('\n'),
      };
    }

    if (!msg.title) {
      const preview = msg.rawText?.slice(0, 300).replace(/\n/g, ' ') || '(empty)';
      return {
        ok: false,
        branch,
        message: `⚠️ LLM returned invalid response`,
        display: [
          `❌ LLM returned invalid JSON. Could not extract title.`,
          ``,
          `Raw response (first 300 chars): ${preview}`,
          ``,
          `Please fix the issue and run /gtw push again.`,
        ].join('\n'),
      };
    }

    // Save pending commit to wip
    const pending = {
      ...wip,
      pendingCommit: { title: msg.title, body: msg.body, branch, workdir, stats, files, totalAdd, totalDel },
      updatedAt: new Date().toISOString(),
    };
    saveWip(pending);

    return {
      ok: true,
      branch,
      pendingCommit: pending.pendingCommit,
      message: `🔍 Commit draft ready — run /gtw confirm to push`,
      display: [
        `🔍 Commit draft — run /gtw confirm to push`,
        ``,
        `📝 Commit Message:\n${msg.title}`,
        ``,
        `📄 Extended Description:\n${msg.body}`,
        ``,
        `📊 Changes:\n${stats}`,
        ``,
        `Run /gtw confirm to commit and push.`,
      ].join('\n'),
    };
  }
}
