/**
 * Unnecessary Cleanup Detection — Review flow Step 2.
 *
 * Detects whether a PR makes stylistic/improvement changes to code that was
 * intentionally non-standard (historical reasons, performance, compatibility).
 */

import { exec } from './exec.js';
import {
  checkIndexFreshness,
  getOrBuildIndex,
  loadIndex,
} from './codebase-index.js';
import { resolveModel, callAI } from './ai.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTERNAL_RATIO_THRESHOLD = 0.8;
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
// Language and pattern definitions
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
  javascript: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?(?:async\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(|^(?:export\s+)?class\s+(\w+)/,
  typescript: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?(?:async\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(|^(?:export\s+)?class\s+(\w+)/,
  python: /^def\s+(\w+)|^async\s+def\s+(\w+)|^class\s+(\w+)/,
  go: /^func\s+(\w+)|^func\s+\([\w\s]+\*?\w+\)\s+(\w+)/,
  rust: /^pub\s+(?:async\s+)?fn\s+(\w+)|^pub\s+struct\s+(\w+)|^pub\s+enum\s+(\w+)/,
};

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Get only MODIFIED files in a PR (excludes new files and deletions).
 * @param {string} worktreePath
 * @param {string} baseRef
 * @param {string} headRef
 * @returns {string[]}
 */
function getModifiedFiles(worktreePath, baseRef, headRef) {
  const output = exec(
    `git diff origin/${baseRef}..origin/${headRef} --name-only --diff-filter=M`,
    { cwd: worktreePath, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  return output.toString().split('\n').map(f => f.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Symbol extraction from diff
// ---------------------------------------------------------------------------

/**
 * Extract changed functions from a unified diff.
 * Returns [{ name, file, lang, before, after, line }].
 * Tracks brace depth to know when a function body ends.
 *
 * @param {string} diff
 * @param {string} file
 * @returns {Array}
 */
function extractChangedSymbols(diff, file) {
  const ext = file.split('.').pop().toLowerCase();
  const lang = EXT_TO_LANG[ext] || 'javascript';
  const pattern = FUNC_PATTERNS[lang] || FUNC_PATTERNS['javascript'];

  const changes = [];
  const lines = diff.split('\n');

  let baseLineNum = 0;
  let headLineNum = 0;
  let currentFunc = null;
  let beforeLines = [];
  let afterLines = [];
  let inFunc = false;
  let braceDepth = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (currentFunc && braceDepth > 0) {
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
      if (!inFunc) {
        const match = trimmed.match(pattern);
        if (match) {
          currentFunc = match[1] || match[2] || match[3];
          inFunc = true;
        }
      }
      if (inFunc) {
        beforeLines.push(trimmed);
        braceDepth += (trimmed.match(/{/g) || []).length - (trimmed.match(/}/g) || []).length;
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
        braceDepth += (trimmed.match(/{/g) || []).length - (trimmed.match(/}/g) || []).length;
      }
    } else if (line.startsWith(' ')) {
      baseLineNum++;
      headLineNum++;
      const trimmed = line.slice(1);
      if (inFunc) {
        beforeLines.push(trimmed);
        afterLines.push(trimmed);
        braceDepth += (trimmed.match(/{/g) || []).length - (trimmed.match(/}/g) || []).length;
        if (braceDepth <= 0) {
          changes.push({
            name: currentFunc,
            file,
            lang,
            before: beforeLines.join('\n'),
            after: afterLines.join('\n'),
            line: headLineNum,
          });
          currentFunc = null;
          beforeLines = [];
          afterLines = [];
          inFunc = false;
          braceDepth = 0;
        }
      }
    }
  }

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

// ---------------------------------------------------------------------------
// Phase A: Ref-Based Triage
// ---------------------------------------------------------------------------

/**
 * Filter changed symbols based on reference data from the base index.
 *
 * @param {Array} changedSymbols
 * @param {Object} baseIndexData - { files, refs }
 * @returns {{ llmCandidates: Array, skipped: Array }}
 */
function phaseATriage(changedSymbols, baseIndexData) {
  const { refs } = baseIndexData;
  const llmCandidates = [];
  const skipped = [];

  for (const candidate of changedSymbols) {
    const { name, file } = candidate;
    const symbolId = `${file}:func:${name}`;

    if (!refs[symbolId]) {
      skipped.push({ ...candidate, symbolId, triageReason: 'no-external-refs' });
      continue;
    }

    const symbolRefs = refs[symbolId] || [];
    const totalRefs = symbolRefs.length;

    if (totalRefs === 0) {
      skipped.push({ ...candidate, symbolId, triageReason: 'no-external-refs' });
      continue;
    }

    const internalRefs = symbolRefs.filter(r => r.file === file).length;
    const internalRatio = totalRefs > 0 ? internalRefs / totalRefs : 0;

    if (internalRatio > INTERNAL_RATIO_THRESHOLD) {
      skipped.push({ ...candidate, symbolId, internalRatio, triageReason: 'low-external-impact' });
    } else {
      llmCandidates.push({ ...candidate, symbolId, internalRatio, totalRefs, triageReason: 'external-callers' });
    }
  }

  return { llmCandidates, skipped };
}

// ---------------------------------------------------------------------------
// Phase B: LLM Analysis
// ---------------------------------------------------------------------------

/**
 * Send candidates to LLM for unnecessary cleanup analysis.
 *
 * @param {Array} llmCandidates
 * @param {string} issueDescription
 * @param {string} sessionKey
 * @returns {Promise<Array>}
 */
async function phaseBLLMAnalysis(llmCandidates, issueDescription, sessionKey) {
  if (llmCandidates.length === 0) return [];

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
 * @param {number} prNum
 * @param {string} baseBranch
 * @param {string} worktreePath
 * @param {string} repo - "owner/repo"
 * @param {object} client - GitHub API client
 * @param {string} sessionKey
 * @param {string|null} issueDescription
 * @returns {Promise<{ cleanups: Array, llmCandidates: Array, skipped: Array, modifiedFiles: number, noLinkedIssue: boolean }>}
 */
export async function detectUnnecessaryCleanup(prNum, baseBranch, worktreePath, repo, client, sessionKey, issueDescription = null) {
  console.log(`[review-cleanup] Starting for PR #${prNum} (base: ${baseBranch})`);

  if (!issueDescription) {
    console.log(`[review-cleanup] No linked issue — skipping Step 2`);
    return { cleanups: [], llmCandidates: [], skipped: [], modifiedFiles: 0, noLinkedIssue: true };
  }

  const freshness = checkIndexFreshness(repo, baseBranch, worktreePath);
  console.log(`[review-cleanup] Freshness: ${freshness.fresh} (indexed: ${freshness.indexedCommit?.slice(0, 7)}, current: ${freshness.currentCommit?.slice(0, 7)})`);

  if (!freshness.fresh) {
    console.log(`[review-cleanup] Index stale, rebuilding for ${baseBranch}...`);
    getOrBuildIndex(worktreePath, repo, baseBranch);
  }

  const baseIndexData = loadIndex(repo, baseBranch);
  if (!baseIndexData || !baseIndexData.files || Object.keys(baseIndexData.files).length === 0) {
    console.log(`[review-cleanup] No index found for ${repo}@${baseBranch}`);
    return { cleanups: [], llmCandidates: [], skipped: [], modifiedFiles: 0, noLinkedIssue: false };
  }

  let headRef;
  try {
    const prDetails = await client.request('GET', `/repos/${repo}/pulls/${prNum}`);
    headRef = prDetails.head?.ref;
  } catch (e) {
    console.error(`[review-cleanup] Failed to get PR head ref: ${e.message}`);
    return { cleanups: [], llmCandidates: [], skipped: [], modifiedFiles: 0, noLinkedIssue: false };
  }

  if (!headRef) {
    console.log(`[review-cleanup] No head ref for PR #${prNum}`);
    return { cleanups: [], llmCandidates: [], skipped: [], modifiedFiles: 0, noLinkedIssue: false };
  }

  const modifiedFiles = getModifiedFiles(worktreePath, baseBranch, headRef);
  console.log(`[review-cleanup] Modified files (excluding new): ${modifiedFiles.length}`);

  if (modifiedFiles.length === 0) {
    return { cleanups: [], llmCandidates: [], skipped: [], modifiedFiles: 0, noLinkedIssue: false };
  }

  const allChangedSymbols = [];
  for (const file of modifiedFiles) {
    try {
      const diff = exec(
        `git diff origin/${baseBranch}..origin/${headRef} -- "${file}"`,
        { cwd: worktreePath, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const symbols = extractChangedSymbols(diff.toString(), file);
      allChangedSymbols.push(...symbols);
    } catch (e) {
      console.error(`[review-cleanup] Failed to diff ${file}: ${e.message}`);
    }
  }

  console.log(`[review-cleanup] Changed symbols extracted: ${allChangedSymbols.length}`);

  if (allChangedSymbols.length === 0) {
    return { cleanups: [], llmCandidates: [], skipped: [], modifiedFiles: modifiedFiles.length, noLinkedIssue: false };
  }

  const { llmCandidates, skipped } = phaseATriage(allChangedSymbols, baseIndexData);
  console.log(`[review-cleanup] Phase A triage: ${llmCandidates.length} → LLM, ${skipped.length} skipped`);

  const cleanups = await phaseBLLMAnalysis(llmCandidates, issueDescription, sessionKey);
  console.log(`[review-cleanup] Phase B LLM found ${cleanups.length} cleanups`);

  return {
    cleanups,
    llmCandidates,
    skipped,
    modifiedFiles: modifiedFiles.length,
    noLinkedIssue: false,
  };
}
