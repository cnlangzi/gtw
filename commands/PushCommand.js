import { Commander } from './Commander.js';
import { getWip, saveWip } from '../utils/wip.js';
import { git, getCurrentBranch } from '../utils/git.js';
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

function buildFallbackMessage(branch, workdir) {
  const files = git('git diff --cached --name-only', workdir).split('\n').filter(Boolean);
  const shortStats = git('git diff --cached --numstat', workdir);
  let totalAdd = 0, totalDel = 0;
  for (const l of shortStats.split('\n').filter(Boolean)) {
    const parts = l.split('\t');
    totalAdd += parseInt(parts[0], 10) || 0;
    totalDel += parseInt(parts[1], 10) || 0;
  }
  const bt = getBranchType(branch);
  const topic = branch.replace(/^(fix|feat|chore|docs|refactor|test|perf|ci|build|deps)[/\\-]/, '').replace(/[\\/-]/g, '-') || 'update';
  return {
    title: `${bt}(${topic}): ${files.length} file(s) changed (+${totalAdd} -${totalDel})`,
    body: '(LLM generation failed — used simple fallback format)',
  };
}

function parseCommitResponse(rawText, branch, workdir) {
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

  return buildFallbackMessage(branch, workdir);
}

async function generateCommitMessage(diff, branch, workdir) {
  const { model } = await resolveModel();
  const branchType = getBranchType(branch);

  const systemPrompt = `You are a senior software engineer writing professional git commit messages.
You output ONLY valid JSON. No markdown. No explanation. No text outside the JSON object.

Output format:
{"title":"fix(scope): brief description","body":"## Summary\\n\\n[one paragraph what changed and why]\\n\\n## Notes\\n\\n[any migration, compatibility, or important notes]"}`;

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
  return parseCommitResponse(rawText, branch, workdir);
}

function parseArgs(args) {
  const flags = { dryRun: true };
  for (const arg of args) {
    if (arg === '--confirm' || arg === '--yes' || arg === '-y' || arg === 'confirm') flags.dryRun = false;
    if (arg === '--dry-run' || arg === 'dry-run') flags.dryRun = true;
    if (arg === '--no-dry-run') flags.dryRun = false;
  }
  return flags;
}

export class PushCommand extends Commander {
  async execute(args) {
    const { dryRun } = parseArgs(args);
    const wip = getWip();
    if (!wip.workdir) throw new Error('No workdir set. Run /gtw on <workdir> first');

    const workdir = wip.workdir;
    const branch = getCurrentBranch(workdir);

    git('git add -A', workdir);

    const stats = git('git diff --cached --stat', workdir);
    if (!stats) {
      return { ok: true, branch, message: 'No changes to commit', display: `✅ No changes to commit\n\nBranch: ${branch}` };
    }

    const diff = git('git diff --cached', workdir);
    const files = git('git diff --cached --name-only', workdir).split('\n').filter(Boolean);
    const shortStats = git('git diff --cached --numstat', workdir);
    let totalAdd = 0, totalDel = 0;
    for (const l of shortStats.split('\n').filter(Boolean)) {
      const parts = l.split('\t');
      totalAdd += parseInt(parts[0], 10) || 0;
      totalDel += parseInt(parts[1], 10) || 0;
    }

    let commitTitle, commitBody, usedFallback = false;

    try {
      const msg = await generateCommitMessage(diff, branch, workdir);
      commitTitle = msg.title;
      commitBody = msg.body;
      if (msg.body && msg.body.includes('LLM generation failed')) usedFallback = true;
    } catch (e) {
      const fb = buildFallbackMessage(branch, workdir);
      commitTitle = fb.title;
      commitBody = `LLM error — fallback format used.\n\nError: ${e.message}`;
      usedFallback = true;
    }

    if (dryRun) {
      const pending = { ...wip, pendingCommit: { title: commitTitle, body: commitBody, branch, usedFallback }, updatedAt: new Date().toISOString() };
      saveWip(pending);

      const diffPreview = diff.length > 2000 ? diff.slice(0, 2000) + '\n\n... (truncated)' : diff;
      return {
        ok: true, branch, dryRun: true, usedFallback,
        commit: { title: commitTitle, body: commitBody }, stats,
        message: `🔍 Dry-run — run /gtw push confirm to commit and push`,
        display: [
          `🔍 Dry-run preview — NOT pushed yet`,
          usedFallback ? '⚠️ LLM failed — using fallback format' : '🤖 LLM-generated message',
          ``,
          `📝 Commit title:\n${commitTitle}`,
          ``,
          `📄 Commit body:\n${commitBody}`,
          ``,
          `📊 Changes:\n${stats}`,
          ``,
          `📁 Files (${files.length}):\n${files.slice(0, 20).join('\n')}${files.length > 20 ? '\n... and more' : ''}`,
          ``,
          `Diff preview:\n\`\`\`\n${diffPreview}\n\`\`\``,
          ``,
          `Run /gtw push confirm to commit and push.`,
        ].join('\n'),
      };
    }

    // Commit and push
    git(`git commit -m "${commitTitle.replace(/"/g, '\\"')}" -m "${commitBody.replace(/"/g, '\\"')}"`, workdir);
    git(`git push origin ${branch}`, workdir);

    return {
      ok: true, branch, dryRun: false, usedFallback,
      commit: { title: commitTitle, body: commitBody }, stats,
      message: `✅ Pushed${usedFallback ? ' (fallback)' : ''}: ${commitTitle}`,
      display: [
        `📦 Committed and pushed${usedFallback ? ' (fallback format)' : ''}`,
        `Branch: ${branch}`,
        `Commit: ${commitTitle}`,
        usedFallback ? `⚠️ ${commitBody.split('\n')[0]}` : '',
        `Files: ${files.join(', ')}`,
        `Stats: +${totalAdd} -${totalDel}`,
      ].filter(Boolean).join('\n'),
    };
  }
}
