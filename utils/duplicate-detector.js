/**
 * Duplicate Detection — Step 1 of the new review flow.
 *
 * Detects whether new functions in a PR duplicate existing functionality
 * in the target branch.
 */

import { execSync } from 'child_process';
import {
  checkIndexFreshness,
  getOrBuildIndex,
  loadIndex,
  searchSymbols,
  findPotentialDuplicates,
  getRemoteBranchHead,
  getChangedFiles,
} from './codebase-index.js';
import { resolveModel, callAI } from './ai.js';
import { GitHubClient } from './github.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DUPLICATE_SYSTEM_PROMPT = `You are a duplicate detection specialist. Your job is to determine whether new functions in a PR duplicate existing functionality in the codebase.

NEW FUNCTIONS (in this PR):
\`\`\`
{newFunctions list}
\`\`\`

EXISTING CODEBASE FUNCTIONS (from base branch index):
\`\`\`
{candidates list}
\`\`\`

For each new function:
1. Compare against candidates (sorted by similarity score)
2. Determine if functionality truly overlaps
3. Consider: name similarity, parameter overlap, docstring semantics, file location

Output ONLY valid JSON:
{
  "items": [
    {
      "newFunc": "functionName",
      "existingFunc": "existingFunctionName or null",
      "verdict": "duplicate" | "similar" | "distinct",
      "severity": "critical" | "high" | "medium" | "low",
      "reason": "brief explanation"
    }
  ]
}

Rules:
- duplicate: clear functional overlap, should reuse existing
- similar: some overlap, consider refactoring but not blocking
- distinct: no meaningful overlap
- If verdict is "duplicate", severity must be high or critical
- Only include items that are duplicate or similar (distinct = skip)`;

const NEW_FUNC_PATTERNS = {
  js: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?(?:async\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(|^(?:export\s+)?class\s+(\w+)/,
  ts: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?(?:async\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(|^(?:export\s+)?class\s+(\w+)/,
  py: /^def\s+(\w+)|^async\s+def\s+(\w+)|^class\s+(\w+)/,
  go: /^func\s+(\w+)|^func\s+\([\w\s]+\*?\w+\)\s+(\w+)/,
  rust: /^pub\s+(?:async\s+)?fn\s+(\w+)|^pub\s+struct\s+(\w+)|^pub\s+enum\s+(\w+)/,
};

const EXT_TO_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java', rb: 'ruby', cs: 'csharp',
  cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Main entry point: detect duplicate functions in a PR.
 *
 * @param {number} prNum - PR number
 * @param {string} baseBranch - Target branch (e.g. 'main')
 * @param {string} worktreePath - Worktree path for git operations
 * @param {string} repo - "owner/repo"
 * @param {GitHubClient} client - GitHub API client
 * @param {string} sessionKey - Session key for LLM calls
 * @returns {Promise<{ items: DuplicateItem[], newFunctions: NewFunction[] }>}
 */
export async function detectDuplicates(prNum, baseBranch, worktreePath, repo, client, sessionKey) {
  console.log(`[duplicate-detector] Starting for PR #${prNum} (base: ${baseBranch})`);

  // Step 1: Ensure base branch index is fresh
  const freshness = checkIndexFreshness(repo, baseBranch, worktreePath);
  console.log(`[duplicate-detector] Freshness: ${freshness.fresh} (indexed: ${freshness.indexedCommit?.slice(0, 7)}, current: ${freshness.currentCommit?.slice(0, 7)})`);

  if (!freshness.fresh) {
    console.log(`[duplicate-detector] Index stale, rebuilding for ${baseBranch}...`);
    getOrBuildIndex(worktreePath, repo, baseBranch);
  }

  // Step 2: Load base branch index
  const { files: baseIndex } = loadIndex(repo, baseBranch);
  if (!baseIndex || Object.keys(baseIndex).length === 0) {
    console.log(`[duplicate-detector] No index found for ${repo}@${baseBranch}, building...`);
    getOrBuildIndex(worktreePath, repo, baseBranch);
    const idx = loadIndex(repo, baseBranch);
    return { items: [], newFunctions: [] };
  }

  // Step 3: Extract new functions from PR diff
  const newFunctions = await extractNewFunctionsFromDiff(prNum, baseBranch, client, repo, worktreePath);
  console.log(`[duplicate-detector] Found ${newFunctions.length} new functions in PR`);

  if (newFunctions.length === 0) {
    return { items: [], newFunctions: [] };
  }

  // Step 4: Fuzzy search for each new function
  const candidates = [];
  for (const fn of newFunctions) {
    const results = searchSymbols(baseIndex, `${fn.name} ${fn.signature}`, { threshold: 0.5, limit: 5 });
    // Filter out files that are changed by the PR (not in base)
    const duplicates = results.filter(r => !newFunctions.some(nf => nf.file === r.file));
    candidates.push({ newFunc: fn, duplicates });
  }

  // Step 5: Specialized LLM call
  const items = await callDuplicateLLM(newFunctions, candidates, sessionKey);
  console.log(`[duplicate-detector] LLM found ${items.length} duplicate/similar items`);

  return { items, newFunctions };
}

// ---------------------------------------------------------------------------
// Extract new functions from PR diff
// ---------------------------------------------------------------------------

/**
 * Extract newly added functions from PR diff.
 * Uses git diff to find changed files, then parses patch to identify new function definitions.
 */
async function extractNewFunctionsFromDiff(prNum, baseBranch, client, repo, worktreePath) {
  const prDetails = await client.request('GET', `/repos/${repo}/pulls/${prNum}`);
  const headRef = prDetails.head?.ref;
  const baseRef = baseBranch;

  if (!headRef) {
    console.log(`[duplicate-detector] No head ref for PR #${prNum}`);
    return [];
  }

  // Get list of changed files
  let changedFiles;
  try {
    changedFiles = getChangedFiles(worktreePath, `origin/${baseRef}`, `origin/${headRef}`);
  } catch {
    try {
      // Fallback: try local branches
      changedFiles = getChangedFiles(worktreePath, baseRef, headRef);
    } catch (e) {
      console.log(`[duplicate-detector] Failed to get changed files: ${e.message}`);
      return [];
    }
  }

  if (changedFiles.length === 0) {
    console.log(`[duplicate-detector] No changed files found`);
    return [];
  }

  // Get diff for each changed file
  const newFunctions = [];

  for (const file of changedFiles) {
    const ext = file.split('.').pop().toLowerCase();
    const lang = EXT_TO_LANG[ext];
    if (!lang) continue;

    try {
      const diff = execSync(
        `git diff origin/${baseRef}..origin/${headRef} -- "${file}"`,
        { cwd: worktreePath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      // Parse diff to find new function definitions
      const funcs = parseFunctionsFromDiff(diff, file, lang);
      newFunctions.push(...funcs);
    } catch (e) {
      console.log(`[duplicate-detector] Failed to diff ${file}: ${e.message}`);
    }
  }

  return newFunctions;
}

/**
 * Parse new function definitions from a git diff patch.
 */
function parseFunctionsFromDiff(diff, file, lang) {
  const functions = [];
  const lines = diff.split('\n');

  let inHunk = false;
  let hunkStart = 0;
  let contextBefore = [];
  let patchLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Hunk header
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      // Process previous hunk
      if (patchLines.length > 0) {
        const funcs = extractFromPatch(contextBefore, patchLines, file, lang);
        functions.push(...funcs);
      }
      inHunk = true;
      hunkStart = parseInt(hunkMatch[3]);
      contextBefore = [];
      patchLines = [];
      continue;
    }

    if (inHunk) {
      if (line.startsWith('+')) {
        patchLines.push({ line: line.slice(1), added: true });
      } else if (line.startsWith('-')) {
        // Removed line — skip
      } else if (line.startsWith(' ')) {
        patchLines.push({ line: line.slice(1), added: false });
      }
    }
  }

  // Process last hunk
  if (patchLines.length > 0) {
    const funcs = extractFromPatch(contextBefore, patchLines, file, lang);
    functions.push(...funcs);
  }

  return functions;
}

/**
 * Extract function signatures from a patch hunk.
 */
function extractFromPatch(contextBefore, patchLines, file, lang) {
  const functions = [];
  const pattern = NEW_FUNC_PATTERNS[lang === 'typescript' ? 'ts' : lang] || NEW_FUNC_PATTERNS.js;

  // Collect added lines and their positions
  const addedLines = patchLines
    .map((p, idx) => ({ ...p, idx }))
    .filter(p => p.added);

  for (const { line, idx } of addedLines) {
    const trimmed = line.trim();
    const match = trimmed.match(pattern);
    if (!match) continue;

    // Get function name from match groups
    const name = match[1] || match[2] || match[3];
    if (!name) continue;

    // Collect surrounding lines for docstring context
    const startIdx = Math.max(0, idx - 3);
    const endIdx = Math.min(patchLines.length, idx + 10);
    const context = patchLines.slice(startIdx, endIdx);

    // Build function description from context
    const docLines = [];
    let paramStr = '';

    for (const p of context) {
      const t = p.line.trim();
      if (t.startsWith('/**') || t.startsWith('*') || t.startsWith('"""') || t.startsWith("'''")) {
        docLines.push(t.replace(/^(\*?\/?\s*)/, ''));
      }
      if (t.includes('(') && !paramStr) {
        const paramMatch = t.match(/\(([^)]*)\)/);
        if (paramMatch) paramStr = paramMatch[1];
      }
    }

    const docstring = docLines.join(' ').replace(/[*#]+/g, '').trim();
    const signature = paramStr ? `${name}(${paramStr})` : name;

    functions.push({
      name,
      signature,
      docstring,
      file,
      lang,
    });
  }

  return functions;
}

// ---------------------------------------------------------------------------
// Specialized LLM call
// ---------------------------------------------------------------------------

/**
 * Call LLM to determine duplicate verdicts.
 */
async function callDuplicateLLM(newFunctions, candidates, sessionKey) {
  if (newFunctions.length === 0) return [];

  // Build prompt
  const newFuncList = newFunctions
    .map(fn => `Name: ${fn.name}\nSignature: ${fn.signature}\nDocstring: ${fn.docstring || '(none)'}\nFile: ${fn.file}`)
    .join('\n\n');

  const candList = candidates
    .map(({ newFunc, duplicates }) => {
      if (duplicates.length === 0) return '';
      return `NEW FUNCTION: ${newFunc.name}\n` +
        duplicates
          .map(d => `  - ${d.symbol.name} (score: ${(1 - d.score).toFixed(2)})\n    File: ${d.file}\n    Signature: ${d.symbol.signature}\n    Docstring: ${d.symbol.docstring || '(none)'}`)
          .join('\n');
    })
    .filter(Boolean)
    .join('\n\n');

  const systemPrompt = DUPLICATE_SYSTEM_PROMPT
    .replace('{newFunctions list}', newFuncList || '(none)')
    .replace('{candidates list}', candList || '(no candidates found)');

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { model } = await resolveModel(sessionKey);
      const response = await callAI(model, systemPrompt, '', sessionKey);
      const trimmed = response.trim();
      const jsonStr = trimmed.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
      const parsed = JSON.parse(jsonStr);

      if (!Array.isArray(parsed.items)) {
        throw new Error('Invalid schema: items not array');
      }

      return parsed.items.map(item => ({
        newFunc: item.newFunc,
        existingFunc: item.existingFunc,
        verdict: item.verdict,
        severity: item.severity,
        reason: item.reason,
      }));
    } catch (e) {
      lastError = e;
      console.error(`[duplicate-detector] LLM attempt ${attempt} failed: ${e.message}`);
    }
  }

  console.error(`[duplicate-detector] LLM failed after 2 attempts: ${lastError.message}`);
  return [];
}
