/**
 * Duplicate Detection — Step 1 of the new review flow.
 *
 * Detects whether new functions in a PR duplicate existing functionality
 * in the target branch.
 */

import { exec } from './exec.js';
import {
  checkIndexFreshness,
  getOrBuildIndex,
  loadIndex,
  searchSymbols,
  getRemoteBranchHead,
  getChangedFiles,
} from './codebase-index.js';
import { resolveModel, callAI } from './ai.js';
import { GitHubClient } from './github.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DUPLICATE_SYSTEM_PROMPT = `You are a duplicate detection specialist. Your job is to determine whether new functions in a PR duplicate existing functionality in the codebase.

## NEW FUNCTIONS (in this PR — with actual code):
\`\`\`
{newFunctions list}
\`\`\`

## EXISTING CODEBASE FUNCTIONS (from base branch index):
\`\`\`
{candidates list}
\`\`\`

## INTERNAL DUPLICATES (within this PR):
{internal duplicates list}

## PATTERN ANTI-PATTERNS (detected in PR code):
{patterns list}

For each new function:
1. Compare against candidates (sorted by similarity score)
2. Determine if functionality truly overlaps
3. Consider: name similarity, parameter overlap, docstring semantics, file location, and ACTUAL CODE CONTENT (not just signatures)
4. Check for PR-internal duplicates
5. Identify pattern anti-patterns

Output ONLY valid JSON:
{
  "items": [
    {
      "newFunc": "functionName",
      "existingFunc": "existingFunctionName or null",
      "verdict": "duplicate" | "similar" | "distinct" | "internal-duplicate" | "pattern",
      "severity": "critical" | "high" | "medium" | "low",
      "reason": "brief explanation",
      "code": "actual code snippet if available",
      "diff": "optional diff comparison"
    }
  ]
}

Rules:
- duplicate: clear functional overlap, should reuse existing
- similar: some overlap, consider refactoring but not blocking
- distinct: no meaningful overlap
- internal-duplicate: same logic appears in multiple files within this PR
- pattern: matches known anti-pattern (chained ops, nested replace, etc.)
- If verdict is "duplicate", severity must be high or critical
- If 3+ occurrences in PR, severity must be critical
- Only include items that are duplicate, similar, internal-duplicate, or pattern (distinct = skip)
- Include actual code content in the "code" field when available`;

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
// Pattern Anti-Pattern Detection Rules
// ---------------------------------------------------------------------------

const PATTERN_RULES = [
  {
    id: 'chained-string-ops',
    name: 'Chained String Operations',
    severity: 'medium',
    pattern: /\.(?:split|map|filter|reduce|join|replace|trim|substring|substr|toLowerCase|toUpperCase)\([^)]*\)\s*\.(?:split|map|filter|reduce|join|replace|trim|substring|substr|toLowerCase|toUpperCase)\(/,
    message: 'Chained string operations detected — consider extracting to a named helper',
  },
  {
    id: 'nested-replace',
    name: 'Nested Replace Chains',
    severity: 'medium',
    pattern: /\.replace\([^)]+\s*\+\s*[^)]+\)/,
    message: 'Nested replace chain detected — consider using a transformation map',
  },
  {
    id: 'redundant-path-ops',
    name: 'Redundant Path Operations',
    severity: 'low',
    pattern: /path\.(?:join|resolve|normalize|absolute)\([^)]*\)\s*\.(?:join|resolve|normalize|absolute)\(/,
    message: 'Redundant path operations detected',
  },
  {
    id: 'console-in-catch',
    name: 'Console Error in Catch Block',
    severity: 'low',
    pattern: /catch\s*\([^)]*\)\s*\{[^}]*console\.(?:error|warn|log)\(/,
    message: 'Console logging in catch block — consider using a proper logger',
  },
  {
    id: 'copy-paste-comment',
    name: 'Potential Copy-Paste',
    severity: 'high',
    pattern: /(?:TODO|FIXME|HACK|XXX|NOTE):.*(?:TODO|FIXME|HACK|XXX|NOTE):/,
    message: 'Possible copy-paste code with遗留 comments',
  },
];

// ---------------------------------------------------------------------------
// SimHash for PR Internal Duplicate Detection
// ---------------------------------------------------------------------------

/**
 * Simple SimHash implementation for code similarity detection.
 * Used to detect PR-internal duplicates.
 */
class SimHash {
  constructor(hashBits = 64) {
    this.hashBits = hashBits;
  }

  /**
   * Tokenize code into features.
   */
  tokenize(code) {
    // Normalize: remove comments, collapse whitespace, lowercase
    const normalized = code
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/#[^\n]*/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    // Extract n-grams (character-level for code)
    const tokens = [];
    const n = 3;
    for (let i = 0; i <= normalized.length - n; i++) {
      tokens.push(normalized.slice(i, i + n));
    }

    // Add keyword-level features
    const keywords = normalized.match(/\b(?:function|const|let|var|return|if|else|for|while|switch|case|break|continue|try|catch|throw|new|class|import|export|async|await|=>)\b/g) || [];
    return [...tokens, ...keywords];
  }

  /**
   * Compute hash for a single token.
   */
  hashToken(token) {
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = ((hash << 5) - hash) + token.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
    }
    // Expand to this.hashBits
    const h = BigInt(hash >>> 0);
    return h;
  }

  /**
   * Compute SimHash for a code string.
   */
  compute(code) {
    const tokens = this.tokenize(code);
    const bits = new Array(this.hashBits).fill(0);

    for (const token of tokens) {
      const hash = this.hashToken(token);
      for (let i = 0; i < this.hashBits; i++) {
        if ((hash >> BigInt(i)) & 1n) {
          bits[i]++;
        } else {
          bits[i]--;
        }
      }
    }

    let fingerprint = 0n;
    for (let i = 0; i < this.hashBits; i++) {
      if (bits[i] > 0) {
        fingerprint |= 1n << BigInt(i);
      }
    }
    return fingerprint;
  }

  /**
   * Compute Hamming distance between two fingerprints.
   */
  hammingDistance(a, b) {
    let diff = a ^ b;
    let distance = 0;
    while (diff) {
      distance += Number(diff & 1n);
      diff >>= 1n;
    }
    return distance;
  }

  /**
   * Find similar code blocks in a collection.
   */
  findSimilar(targetCode, collection, threshold = 0.9) {
    const targetHash = this.compute(targetCode);
    const maxDistance = Math.floor(this.hashBits * (1 - threshold));
    const results = [];

    for (const item of collection) {
      const distance = this.hammingDistance(targetHash, item.hash);
      if (distance <= maxDistance) {
        results.push({
          ...item,
          distance,
          similarity: 1 - (distance / this.hashBits),
        });
      }
    }

    return results.sort((a, b) => a.distance - b.distance);
  }
}

/**
 * Detect PR-internal duplicates using SimHash.
 */
function detectInternalDuplicates(newFunctions) {
  const simhash = new SimHash();
  const codeBlocks = [];

  // Build collection of code blocks with their hashes
  for (const fn of newFunctions) {
    if (fn.code) {
      const hash = simhash.compute(fn.code);
      codeBlocks.push({
        name: fn.name,
        file: fn.file,
        line: fn.line,
        code: fn.code,
        hash,
      });
    }
  }

  if (codeBlocks.length < 2) {
    return [];
  }

  const internalDuplicates = [];
  const processed = new Set();

  for (let i = 0; i < codeBlocks.length; i++) {
    const block = codeBlocks[i];
    const similar = simhash.findSimilar(block.code, codeBlocks.slice(i + 1), 0.85);

    if (similar.length > 0) {
      const key = `${block.name}@${block.file}`;
      if (!processed.has(key)) {
        processed.add(key);
        const occurrences = [block, ...similar.map(s => ({ name: s.name, file: s.file, line: s.line, code: s.code }))];
        internalDuplicates.push({
          newFunc: block.name,
          existingFunc: similar[0].name,
          verdict: 'internal-duplicate',
          severity: occurrences.length >= 3 ? 'critical' : 'high',
          reason: `${block.name} appears ${occurrences.length}x in this PR with similar logic`,
          occurrences: occurrences.map(o => ({ file: o.file, line: o.line })),
          code: block.code,
        });
      }
    }
  }

  return internalDuplicates;
}

/**
 * Detect pattern anti-patterns in code.
 */
function detectPatterns(newFunctions) {
  const findings = [];

  for (const fn of newFunctions) {
    if (!fn.code) continue;

    for (const rule of PATTERN_RULES) {
      if (rule.pattern.test(fn.code)) {
        findings.push({
          newFunc: fn.name,
          existingFunc: null,
          verdict: 'pattern',
          severity: rule.severity,
          reason: rule.message,
          patternId: rule.id,
          code: fn.code,
        });
      }
    }
  }

  return findings;
}

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

  // Step 3: Extract new functions from PR diff (with actual code)
  const newFunctions = await extractNewFunctionsFromDiff(prNum, baseBranch, client, repo, worktreePath);
  console.log(`[duplicate-detector] Found ${newFunctions.length} new functions in PR`);

  if (newFunctions.length === 0) {
    return { items: [], newFunctions: [] };
  }

  // Collect PR-modified files (for filtering candidates)
  const prFiles = new Set(newFunctions.map(fn => fn.file));

  // Step 4: Fuzzy search for each new function
  const candidates = [];
  for (const fn of newFunctions) {
    const results = searchSymbols(baseIndex, `${fn.name} ${fn.signature}`, { threshold: 0.5, limit: 5 });
    // Filter out candidates from files that were modified in this PR
    const duplicates = results.filter(r => !prFiles.has(r.file));
    candidates.push({ newFunc: fn, duplicates });
  }

  // Step 5: PR Internal Duplicate Detection (SimHash)
  const internalDuplicates = detectInternalDuplicates(newFunctions);
  console.log(`[duplicate-detector] Found ${internalDuplicates.length} internal duplicates`);

  // Step 6: Pattern Anti-Pattern Detection
  const patternFindings = detectPatterns(newFunctions);
  console.log(`[duplicate-detector] Found ${patternFindings.length} pattern anti-patterns`);

  // Step 7: Specialized LLM call (now with actual code content)
  const items = await callDuplicateLLM(newFunctions, candidates, sessionKey);
  console.log(`[duplicate-detector] LLM found ${items.length} duplicate/similar items`);

  // Merge all findings
  const allItems = [
    ...internalDuplicates,
    ...patternFindings,
    ...items,
  ];

  return { items: allItems, newFunctions };
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
      const diff = exec(
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

  let patchLines = [];
  let baseLineNum = 0; // Line number in base (old) file
  let headLineNum = 0; // Line number in head (new) file

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Hunk header — process previous hunk
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (patchLines.length > 0) {
        const funcs = extractFromPatch(patchLines, file, lang);
        functions.push(...funcs);
      }
      patchLines = [];
      baseLineNum = parseInt(hunkMatch[1], 10) - 1;
      headLineNum = parseInt(hunkMatch[3], 10) - 1;
      continue;
    }

    if (line.startsWith('+')) {
      headLineNum++;
      patchLines.push({ line: line.slice(1), added: true, lineNumber: headLineNum });
    } else if (line.startsWith('-')) {
      baseLineNum++;
      // Removed line — skip (don't include in context)
    } else if (line.startsWith(' ')) {
      baseLineNum++;
      headLineNum++;
      patchLines.push({ line: line.slice(1), added: false, lineNumber: headLineNum });
    }
  }

  // Process last hunk
  if (patchLines.length > 0) {
    const funcs = extractFromPatch(patchLines, file, lang);
    functions.push(...funcs);
  }

  return functions;
}

/**
 * Extract function signatures from a patch hunk.
 * Looks at both added lines and surrounding context (including non-added lines)
 * to capture multi-line function signatures and docstrings.
 */
function extractFromPatch(patchLines, file, lang) {
  const functions = [];
  const pattern = NEW_FUNC_PATTERNS[lang === 'typescript' ? 'ts' : lang] || NEW_FUNC_PATTERNS.js;

  // Build full line text for context
  const allText = patchLines.map(p => p.line).join('\n');

  // Find added function definition lines
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

    // Collect context: 5 lines before through 10 lines after
    // This captures multi-line signatures and docstrings
    const startIdx = Math.max(0, idx - 5);
    const endIdx = Math.min(patchLines.length, idx + 10);
    const context = patchLines.slice(startIdx, endIdx);

    // Extract docstring lines and parameters from context
    const docLines = [];
    let paramStr = '';
    let foundOpenParen = false;
    let braceDepth = 0;

    for (const p of context) {
      const t = p.line.trim();

      // Docstring detection (all lines, not just added)
      if (t.startsWith('/**') || t.startsWith('*') || t.startsWith('"""') || t.startsWith("'''") || t.startsWith('///')) {
        docLines.push(t.replace(/^(\*?\/?\s*)/, ''));
      }

      // Multi-line parameter detection: collect from ( to )
      if (!foundOpenParen && t.includes('(')) {
        foundOpenParen = true;
      }
      if (foundOpenParen) {
        const openCount = (t.match(/\(/g) || []).length;
        const closeCount = (t.match(/\)/g) || []).length;
        braceDepth += openCount - closeCount;

        if (!paramStr && t.includes('(')) {
          const paramStart = t.indexOf('(');
          paramStr = t.slice(paramStart + 1);
        } else if (paramStr) {
          paramStr += ' ' + t;
        }

        if (braceDepth === 0 && paramStr) {
          // Found closing paren
          const closeIdx = paramStr.indexOf(')');
          if (closeIdx > 0) paramStr = paramStr.slice(0, closeIdx);
          break;
        }
      }
    }

    const docstring = docLines.join(' ').replace(/[*#]+/g, '').trim();
    const signature = paramStr ? `${name}(${paramStr.trim()})` : name;

    // Collect actual code lines from the function body (added lines only)
    // Look for function body starting from the definition line
    const codeLines = [];
    let inBody = false;
    let braceCount = 0;

    for (let i = idx; i < patchLines.length; i++) {
      const p = patchLines[i];
      const t = p.line;

      if (!inBody) {
        // Start of function body
        if (t.includes('{')) {
          inBody = true;
          braceCount = (t.match(/{/g) || []).length - (t.match(/}/g) || []).length;
          if (p.added) codeLines.push(t);
          if (braceCount === 0) break; // Single line function
        } else if (p.added) {
          codeLines.push(t);
        }
      } else {
        if (p.added) codeLines.push(t);
        braceCount += (t.match(/{/g) || []).length - (t.match(/}/g) || []).length;
        if (braceCount <= 0) break;
      }
    }

    const code = codeLines.length > 0 ? codeLines.join('\n') : null;
    // Estimate line number from patch position
    const line = patchLines[idx]?.lineNumber || idx + 1;

    functions.push({
      name,
      signature,
      docstring,
      file,
      lang,
      code,
      line,
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
async function callDuplicateLLM(newFunctions, candidates, sessionKey, internalDuplicates = [], patternFindings = []) {
  if (newFunctions.length === 0) return [];

  // Build prompt with ACTUAL CODE content (not just signatures)
  const newFuncList = newFunctions
    .map(fn => {
      let entry = `Name: ${fn.name}\nSignature: ${fn.signature}\nDocstring: ${fn.docstring || '(none)'}\nFile: ${fn.file}`;
      if (fn.code) {
        entry += `\nActual Code:\n${fn.code}`;
      }
      return entry;
    })
    .join('\n\n---\n\n');

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

  // Build internal duplicates list
  const internalList = internalDuplicates.length > 0
    ? internalDuplicates.map(d => `${d.newFunc} (${d.file}): ${d.occurrences?.map(o => `${o.file}:${o.line}`).join(', ')}`).join('\n')
    : '(none)';

  // Build patterns list
  const patternsList = patternFindings.length > 0
    ? patternFindings.map(p => `- ${p.newFunc}: ${p.reason}`).join('\n')
    : '(none)';

  const systemPrompt = DUPLICATE_SYSTEM_PROMPT
    .replace('{newFunctions list}', newFuncList || '(none)')
    .replace('{candidates list}', candList || '(no candidates found)')
    .replace('{internal duplicates list}', internalList)
    .replace('{patterns list}', patternsList);

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
        code: item.code || null,
        diff: item.diff || null,
      }));
    } catch (e) {
      lastError = e;
      console.error(`[duplicate-detector] LLM attempt ${attempt} failed: ${e.message}`);
    }
  }

  console.error(`[duplicate-detector] LLM failed after 2 attempts: ${lastError.message}`);
  return [];
}
