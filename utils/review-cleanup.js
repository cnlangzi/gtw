/**
 * Unnecessary Cleanup Detection — Review flow Step 2.
 *
 * Detects whether a PR makes stylistic/improvement changes to code that was
 * intentionally non-standard (historical reasons, performance, compatibility).
 * Runs in parallel with Step 1 (detectReuse).
 */

import {
  checkIndexFreshness,
  getOrBuildIndex,
  loadIndex,
  getChangedFiles,
} from './codebase-index.js';
import { resolveModel, callAI } from './ai.js';
import { exec } from './exec.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTERNAL_RATIO_THRESHOLD = 0.8;

/**
 * Changes below this confidence are not reported.
 */
const CONFIDENCE_THRESHOLD = 0.80;

// ---------------------------------------------------------------------------
// System prompt for LLM
// ---------------------------------------------------------------------------

const CLEANUP_SYSTEM_PROMPT = `You are reviewing code changes against a GitHub issue.

Issue describes the problem/feature:
{issue_description}

A change is "unnecessary cleanup" if:
- The original code worked correctly (no bug)
- The change makes code "more standard/modern/elegant"
- The issue did not require this improvement

Key signals of unnecessary cleanup:
- "Unusual" pattern replaced with "standard" one
- Manual implementation replaced with library call
- Older style replaced with newer style
- Longer form replaced with shorter form
- The original code might have been intentional

Output ONLY valid JSON:
{
  "cleanups": [
    {
      "file": "path",
      "symbol": "function/class name",
      "before": "original code snippet",
      "after": "changed code snippet",
      "whyCleanup": "why this appears to be stylistic improvement, not required by issue",
      "whyProblematic": "what risk does this introduce",
      "severity": "critical | high | medium | low",
      "suggestion": "revert | review-required",
      "confidence": 0.85
    }
  ]
}

Rules:
- Only report confidence >= 0.80
- critical = original was likely intentional with hidden constraints
- high = clearly unnecessary with potential hidden behavior change
- medium = stylistic cleanup, low risk
- low = minor cleanup, likely safe but still unnecessary
- Output empty array if no cleanups found`;

// ---------------------------------------------------------------------------
// Symbol change detection from diff
// ---------------------------------------------------------------------------

const EXT_TO_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java', rb: 'ruby', cs: 'csharp',
  cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
};

const FUNC_PATTERNS = {
  js: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?(?:async\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(|^(?:export\s+)?class\s+(\w+)/,
  ts: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?(?:async\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(|^(?:export\s+)?class\s+(\w+)/,
  py: /^def\s+(\w+)|^async\s+def\s+(\w+)|^class\s+(\w+)/,
  go: /^func\s+(\w+)|^func\s+\([\w\s]+\*?\w+\)\s+(\w+)/,
  rust: /^pub\s+(?:async\s+)?fn\s+(\w+)|^pub\s+struct\s+(\w+)|^pub\s+enum\s+(\w+)/,
};

/**
 * Get all modified files in a PR, excluding new files and deletions.
 * @param {string} worktreePath
 * @param {string} baseRef
 * @param {string} headRef
 * @returns {string[]} - list of modified file paths
 */
function getModifiedFiles(worktreePath, baseRef, headRef) {
  const allChanged = getChangedFiles(worktreePath, `origin/${baseRef}`, `origin/${headRef}`);

  // Get only modified files (not new, not deleted)
  // We check if file exists in both base and head
  const modified = [];
  for (const file of allChanged) {
    try {
      // Check if file exists in base (wasn't added)
      const baseExists = exec(
        `git show origin/${baseRef}:${file} > /dev/null 2>&1 && echo yes || echo no`,
        { cwd: worktreePath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).toString().trim();

      if (baseExists === 'yes') {
        modified.push(file);
      }
    } catch {
      // If we can't check, skip the file
    }
  }
  return modified;
}

/**
 * Extract changed symbols from a diff for a single file.
 * Returns { before, after, signature, name, line } for each changed function.
 */
function extractChangedSymbols(diff, file) {
  const ext = file.split('.').pop().toLowerCase();
  const lang = EXT_TO_LANG[ext] || 'javascript';
  const pattern = FUNC_PATTERNS[lang === 'typescript' ? 'ts' : lang] || FUNC_PATTERNS.js;

  const changes = [];
  const lines = diff.split('\n');

  let baseLineNum = 0;
  let headLineNum = 0;
  let currentFunc = null;
  let beforeLines = [];
  let afterLines = [];
  let inFunc = false;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Hunk header
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      // Save previous function if any
      if (currentFunc && (beforeLines.length > 0 || afterLines.length > 0)) {
        changes.push({
          name: currentFunc,
          file,
          lang,
          before: beforeLines.join('\n'),
          after: afterLines.join('\n'),
          line: headLineNum,
        });
      }
      baseLineNum = parseInt(hunkMatch[1], 10) - 1;
      headLineNum = parseInt(hunkMatch[3], 10) - 1;
      currentFunc = null;
      beforeLines = [];
      afterLines = [];
      inFunc = false;
      braceDepth = 0;
      continue;
    }

    if (line.startsWith('-')) {
      baseLineNum++;
      const trimmed = line.slice(1);

      // Check for function definition
      if (!inFunc) {
        const match = trimmed.match(pattern);
        if (match) {
          currentFunc = match[1] || match[2] || match[3];
          inFunc = true;
          beforeLines.push(trimmed);
        }
      } else {
        beforeLines.push(trimmed);
      }
    } else if (line.startsWith('+')) {
      headLineNum++;
      const trimmed = line.slice(1);

      if (!inFunc) {
        const match = trimmed.match(pattern);
        if (match) {
          currentFunc = match[1] || match[2] || match[3];
          inFunc = true;
        }
      }

      if (inFunc) {
        afterLines.push(trimmed);
        // Track brace depth for function body
        braceDepth += (trimmed.match(/{/g) || []).length - (trimmed.match(/}/g) || []).length;
        // Function ends when brace depth goes negative (wasn't in body yet) or
        // when we see a new function definition
      }
    } else if (line.startsWith(' ')) {
      baseLineNum++;
      headLineNum++;

      // Context line — if we're in a function, include it
      if (inFunc) {
        const trimmed = line.slice(1);
        beforeLines.push(trimmed);
        afterLines.push(trimmed);
        braceDepth += (trimmed.match(/{/g) || []).length - (trimmed.match(/}/g) || []).length;
      }

      // End of function body
      if (inFunc && braceDepth < 0) {
        if (currentFunc && (beforeLines.length > 0 || afterLines.length > 0)) {
          changes.push({
            name: currentFunc,
            file,
            lang,
            before: beforeLines.join('\n'),
            after: afterLines.join('\n'),
            line: headLineNum,
          });
        }
        currentFunc = null;
        beforeLines = [];
        afterLines = [];
        inFunc = false;
        braceDepth = 0;
      }
    }
  }

  // Don't forget last function
  if (currentFunc && (beforeLines.length > 0 || afterLines.length > 0)) {
    changes.push({
      name: currentFunc,
      file,
      lang,
      before: beforeLines.join('\n'),
      after: afterLines.join('\n'),
      line: headLineNum,
    });
  }

  return changes;
}

/**
 * Build symbol ID from file path and symbol name.
 * Matches the format used in codebase-index.js.
 */
function buildSymbolId(file, name) {
  return `${file}:${name}`;
}

/**
 * Find symbol in base index by name in a specific file.
 * Returns { symbol, symbolId } or null.
 */
function findSymbolInIndex(fileIndex, file, name) {
  const fileSymbols = fileIndex[file];
  if (!fileSymbols) return null;

  for (const sym of fileSymbols) {
    if (sym.name === name) {
      const symbolId = sym.symbolId || `${file}:${sym.kind || 'func'}:${name}`;
      return { symbol: sym, symbolId };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase A: Ref-Based Triage
// ---------------------------------------------------------------------------

/**
 * Phase A triage using codebase-index refs[] data.
 *
 * @param {Array} changedSymbols - [{name, file, lang, before, after, line}]
 * @param {Object} baseIndexData - loaded index data with refs
 * @returns {{ llmCandidates: Array, skipped: Array }}
 */
function phaseATriage(changedSymbols, baseIndexData) {
  const { files: fileIndex, refs } = baseIndexData;
  const llmCandidates = [];
  const skipped = [];

  for (const candidate of changedSymbols) {
    const { name, file, before, after, lang } = candidate;

    // Build possible symbol IDs to look up
    const possibleIds = [
      `${file}:${name}`,
      `${file}:func:${name}`,
      `${file}:${lang}:${name}`,
    ];

    let symbolId = null;
    let symbolData = null;

    for (const sid of possibleIds) {
      if (refs[sid]) {
        symbolId = sid;
        symbolData = { symbolId: sid };
        break;
      }
    }

    // Also try searching by name in the file's symbols
    if (!symbolId) {
      const found = findSymbolInIndex(fileIndex, file, name);
      if (found) {
        symbolId = found.symbolId;
        symbolData = found;
      }
    }

    if (!symbolId || !refs[symbolId]) {
      // Cannot resolve to base index → send to LLM (conservative)
      llmCandidates.push({
        ...candidate,
        symbolId: symbolId || `unresolved:${file}:${name}`,
        triageReason: 'unresolvable',
      });
      continue;
    }

    const symbolRefs = refs[symbolId] || [];
    const totalRefs = symbolRefs.length;

    if (totalRefs === 0) {
      // No external callers → low risk, SKIP
      skipped.push({ ...candidate, symbolId, triageReason: 'no-external-refs' });
      continue;
    }

    // Count refs inside PR (we can't know exactly, so estimate based on file)
    // For triage: if internalRatio > 0.8, skip
    // We approximate internalRatio by counting refs to the same file
    const internalRefs = symbolRefs.filter(r => r.file === file).length;
    const internalRatio = internalRefs / totalRefs;

    if (internalRatio > INTERNAL_RATIO_THRESHOLD) {
      // Overwhelmingly self-contained → low risk, SKIP
      skipped.push({ ...candidate, symbolId, internalRatio, triageReason: 'low-external-impact' });
    } else {
      // External callers exist → needs LLM check
      llmCandidates.push({
        ...candidate,
        symbolId,
        internalRatio,
        totalRefs,
        triageReason: 'external-callers',
      });
    }
  }

  return { llmCandidates, skipped };
}

// ---------------------------------------------------------------------------
// Phase B: LLM Analysis
// ---------------------------------------------------------------------------

/**
 * Call LLM to detect unnecessary cleanups in filtered candidates.
 */
async function phaseBLLMAnalysis(llmCandidates, issueDescription, sessionKey) {
  if (llmCandidates.length === 0) return [];

  // Build prompt with before/after snippets
  const changesText = llmCandidates
    .map(c => {
      let entry = `File: ${c.file}\nSymbol: ${c.name}\n`;
      entry += `Before (original):\n${c.before || '(no before snippet)'}\n\n`;
      entry += `After (changed):\n${c.after || '(no after snippet)'}\n`;
      entry += `Triage reason: ${c.triageReason}\n`;
      return entry;
    })
    .join('\n---\n\n');

  const systemPrompt = CLEANUP_SYSTEM_PROMPT.replace('{issue_description}', issueDescription || '(no linked issue)');

  const userPrompt = `Review these code changes for unnecessary cleanup:\n\n${changesText}\n\nOutput JSON with your findings.`;

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { model } = await resolveModel(sessionKey);
      const response = await callAI(model, systemPrompt, userPrompt, sessionKey);
      const trimmed = response.trim();
      const jsonStr = trimmed.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
      const parsed = JSON.parse(jsonStr);

      if (!parsed.cleanups || !Array.isArray(parsed.cleanups)) {
        throw new Error('Invalid schema: cleanups not array');
      }

      return parsed.cleanups
        .filter(c => (c.confidence || 0) >= CONFIDENCE_THRESHOLD)
        .map(c => ({
          file: c.file,
          symbol: c.symbol,
          before: c.before,
          after: c.after,
          whyCleanup: c.whyCleanup,
          whyProblematic: c.whyProblematic,
          severity: c.severity,
          suggestion: c.suggestion,
          confidence: c.confidence,
        }));
    } catch (e) {
      lastError = e;
      console.error(`[review-cleanup] LLM attempt ${attempt} failed: ${e.message}`);
    }
  }

  console.error(`[review-cleanup] LLM failed after 2 attempts: ${lastError.message}`);
  return [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Main entry point: detect unnecessary cleanup in a PR.
 *
 * @param {number} prNum - PR number
 * @param {string} baseBranch - Target branch (e.g. 'main')
 * @param {string} worktreePath - Worktree path for git operations
 * @param {string} repo - "owner/repo"
 * @param {GitHubClient} client - GitHub API client
 * @param {string} sessionKey - Session key for LLM calls
 * @param {string|null} issueDescription - Linked issue description (for LLM context)
 * @returns {Promise<{ cleanups: Array, llmCandidates: Array, skipped: Array, modifiedFiles: number }>}
 */
export async function detectUnnecessaryCleanup(prNum, baseBranch, worktreePath, repo, client, sessionKey, issueDescription = null) {
  console.log(`[review-cleanup] Starting for PR #${prNum} (base: ${baseBranch})`);

  // If no linked issue, skip (not a real PR for cleanup detection purposes)
  if (!issueDescription) {
    console.log(`[review-cleanup] No linked issue — skipping Step 2`);
    return { cleanups: [], llmCandidates: [], skipped: [], modifiedFiles: 0, noLinkedIssue: true };
  }

  // Ensure base branch index is fresh
  const freshness = checkIndexFreshness(repo, baseBranch, worktreePath);
  console.log(`[review-cleanup] Freshness: ${freshness.fresh} (indexed: ${freshness.indexedCommit?.slice(0, 7)}, current: ${freshness.currentCommit?.slice(0, 7)})`);

  if (!freshness.fresh) {
    console.log(`[review-cleanup] Index stale, rebuilding for ${baseBranch}...`);
    getOrBuildIndex(worktreePath, repo, baseBranch);
  }

  // Load base branch index
  const baseIndexData = loadIndex(repo, baseBranch);
  if (!baseIndexData || !baseIndexData.files || Object.keys(baseIndexData.files).length === 0) {
    console.log(`[review-cleanup] No index found for ${repo}@${baseBranch}`);
    return { cleanups: [], llmCandidates: [], skipped: [], modifiedFiles: 0 };
  }

  // Get PR head ref
  let headRef;
  try {
    const prDetails = await client.request('GET', `/repos/${repo}/pulls/${prNum}`);
    headRef = prDetails.head?.ref;
  } catch (e) {
    console.error(`[review-cleanup] Failed to get PR head ref: ${e.message}`);
    return { cleanups: [], llmCandidates: [], skipped: [], modifiedFiles: 0 };
  }

  if (!headRef) {
    console.log(`[review-cleanup] No head ref for PR #${prNum}`);
    return { cleanups: [], llmCandidates: [], skipped: [], modifiedFiles: 0 };
  }

  // Phase A: Get modified files and extract changed symbols
  const modifiedFiles = getModifiedFiles(worktreePath, baseBranch, headRef);
  console.log(`[review-cleanup] Modified files (excluding new): ${modifiedFiles.length}`);

  if (modifiedFiles.length === 0) {
    return { cleanups: [], llmCandidates: [], skipped: [], modifiedFiles: 0 };
  }

  const allChangedSymbols = [];
  for (const file of modifiedFiles) {
    try {
      const diff = exec(
        `git diff origin/${baseBranch}..origin/${headRef} -- "${file}"`,
        { cwd: worktreePath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const symbols = extractChangedSymbols(diff, file);
      allChangedSymbols.push(...symbols);
    } catch (e) {
      console.error(`[review-cleanup] Failed to diff ${file}: ${e.message}`);
    }
  }

  console.log(`[review-cleanup] Changed symbols extracted: ${allChangedSymbols.length}`);

  if (allChangedSymbols.length === 0) {
    return { cleanups: [], llmCandidates: [], skipped: [], modifiedFiles: modifiedFiles.length };
  }

  // Phase A: Ref-based triage
  const { llmCandidates, skipped } = phaseATriage(allChangedSymbols, baseIndexData);
  console.log(`[review-cleanup] Phase A triage: ${llmCandidates.length} → LLM, ${skipped.length} skipped`);

  // Phase B: LLM Analysis
  const cleanups = await phaseBLLMAnalysis(llmCandidates, issueDescription, sessionKey);
  console.log(`[review-cleanup] Phase B LLM found ${cleanups.length} cleanups`);

  return {
    cleanups,
    llmCandidates,
    skipped,
    modifiedFiles: modifiedFiles.length,
  };
}
