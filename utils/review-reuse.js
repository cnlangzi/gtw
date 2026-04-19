/**
 * Code Reuse Detection — Review flow Step 1.
 *
 * Detects whether new functions in a PR reuse (or should reuse) existing
 * functionality in the target branch, and identifies reuse opportunities.
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

const REUSE_SYSTEM_PROMPT = `You are a code reuse detection specialist. Your job is to determine whether new functions in a PR could reuse — or should reuse — existing functionality in the codebase, and identify missed reuse opportunities.

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

## STRUCTURAL MATCHES (similar call patterns — same utilities, different names):
{structural matches list}

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
    message: 'Possible copy-paste code with duplicate TODO/FIXME comments',
  },
];

// ---------------------------------------------------------------------------
// Call Pattern Extraction (Structural Match)
// ---------------------------------------------------------------------------

/**
 * Extract call patterns from code — what methods are called on what objects.
 * Used for structural matching: two functions with different names but similar
 * call patterns may be functional duplicates.
 *
 * Examples:
 *   'path.join(a, b).resolve(c)'  → ['path.join', 'path.resolve']
 *   'fs.readFileSync(x).toString()'  → ['fs.readFileSync', 'toString']
 *   'JSON.parse(x).filter(y)'  → ['JSON.parse', 'filter']
 */
function extractCallPatterns(code) {
  if (!code) return [];

  // Remove strings and comments to avoid false positives
  const normalized = code
    .replace(/['"`][^'"`]*['"`]/g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const patterns = [];

  // Match chained method calls: obj.method().method()
  // Pattern: identifier.identifier (possibly chained)
  const chainPattern = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\.\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\(|\[|\.|$)/g;
  let match;
  while ((match = chainPattern.exec(normalized)) !== null) {
    const obj = match[1];
    const method = match[2];
    // Skip common non-useful patterns
    if (['if', 'else', 'for', 'while', 'switch', 'case', 'return', 'throw', 'new', 'typeof', 'void'].includes(obj)) continue;
    if (['length', 'size', 'prototype', 'constructor', '__proto__'].includes(method)) continue;
    patterns.push(`${obj}.${method}`);
  }

  // Also extract standalone function calls (no object prefix)
  const funcCallPattern = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(\s*[^)]*\)/g;
  while ((match = funcCallPattern.exec(normalized)) !== null) {
    const func = match[1];
    if (!patterns.some(p => p.endsWith(func)) && !['if', 'else', 'for', 'while', 'switch', 'case', 'return', 'throw', 'new', 'require', 'import', 'export', 'async', 'await'].includes(func)) {
      patterns.push(func);
    }
  }

  return [...new Set(patterns)].sort();
}

/**
 * Compute Jaccard similarity between two call pattern sets.
 */
function patternSimilarity(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = a.filter(p => setB.has(p)).length;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Find structurally similar functions from the base index.
 * Two functions are structurally similar if they call the same underlying
 * utilities, even if their names are different.
 */
function findStructuralMatches(targetPatterns, baseIndex, threshold = 0.4) {
  const matches = [];

  for (const [filePath, symbols] of Object.entries(baseIndex)) {
    for (const symbol of symbols) {
      // Skip if we don't have code or if this is the same symbol
      if (!symbol._callPatterns) {
        // Compute call patterns from signature and docstring (best effort)
        const text = [symbol.name, symbol.signature, symbol.docstring].filter(Boolean).join(' ');
        symbol._callPatterns = extractCallPatterns(text);
      }

      const sim = patternSimilarity(targetPatterns, symbol._callPatterns);
      if (sim >= threshold) {
        matches.push({
          symbol,
          file: filePath,
          similarity: sim,
        });
      }
    }
  }

  return matches.sort((a, b) => b.similarity - a.similarity);
}

// ---------------------------------------------------------------------------
// Inline Code Block Detection
// ---------------------------------------------------------------------------

/**
 * Inline code block patterns to extract from diffs.
 * These are non-function code snippets that warrant review.
 */
const INLINE_BLOCK_RULES = [
  {
    id: 'chained-string-ops',
    name: 'Chained String Operations',
    severity: 'medium',
    pattern: /\.[a-zA-Z]+\([^)]*\)\s*\.\s*(?:split|map|filter|reduce|join|replace|trim|substring|substr|toLowerCase|toUpperCase)\s*\([^)]*\)/g,
    description: 'Chain of string operations — consider extracting to helper',
  },
  {
    id: 'nested-replace',
    name: 'Nested Replace Chain',
    severity: 'medium',
    pattern: /\.replace\s*\([^,]+,\s*[^)]+\s*\+\s*[^)]+\s*\)/g,
    description: 'Nested replace with concatenation — use transformation map',
  },
  {
    id: 'path-join-resolve',
    name: 'Redundant Path Operations',
    severity: 'low',
    pattern: /path\s*\.\s*(?:join|resolve|normalize|absolute)\s*\([^)]+\)\s*\.\s*(?:join|resolve|normalize|absolute)\s*\(/g,
    description: 'Consecutive path operations that could be combined',
  },
];

/**
 * Extract inline code blocks from a diff (not inside function definitions).
 * Returns blocks that match known anti-patterns, excluding code that
 * belongs to newly added functions (those are handled separately).
 *
 * @param {string} diff - Raw git diff string
 * @param {string} file - File path
 * @param {string} lang - Language identifier
 * @param {Array} functions - Parsed functions with {name, line, code} to exclude
 */
function extractInlineBlocksFromDiff(diff, file, lang, functions = []) {
  const blocks = [];

  // Build a Set of line numbers that belong to function bodies.
  // These will be excluded from inline block scanning.
  const funcLineNumbers = new Set();
  for (const fn of functions) {
    if (!fn.code) continue;
    // fn.line is the starting line; estimate body end by counting braces
    let endLine = fn.line;
    let braceDepth = 0;
    for (const cl of fn.code.split('\n')) {
      braceDepth += (cl.match(/{/g) || []).length - (cl.match(/}/g) || []).length;
      if (braceDepth > 0) endLine++;
      else if (braceDepth === 0 && braceDepth !== 0) break; // Already closed
    }
    for (let l = fn.line; l <= endLine; l++) funcLineNumbers.add(l);
  }

  // Parse diff to get added lines with line numbers
  const lines = diff.split('\n');
  let baseLineNum = 0;
  let headLineNum = 0;
  const addedLines = []; // { lineNumber, text }

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      baseLineNum = parseInt(hunkMatch[1], 10) - 1;
      headLineNum = parseInt(hunkMatch[3], 10) - 1;
      continue;
    }
    if (line.startsWith('+')) {
      headLineNum++;
      if (!funcLineNumbers.has(headLineNum)) {
        addedLines.push({ lineNumber: headLineNum, text: line.slice(1) });
      }
    } else if (line.startsWith('-')) {
      baseLineNum++;
    } else if (line.startsWith(' ')) {
      baseLineNum++;
      headLineNum++;
    }
  }

  if (addedLines.length === 0) return blocks;

  for (const rule of INLINE_BLOCK_RULES) {
    // Reset regex lastIndex
    rule.pattern.lastIndex = 0;
    for (const { lineNumber, text } of addedLines) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(text)) {
        const snippet = text.trim();
        // Avoid duplicate blocks with same snippet
        if (!blocks.some(b => b.snippet === snippet)) {
          blocks.push({
            type: 'inline-block',
            ruleId: rule.id,
            ruleName: rule.name,
            snippet,
            file,
            lang,
            line: lineNumber,
            severity: rule.severity,
            description: rule.description,
            verdict: 'pattern',
            newFunc: `${rule.name} (${file}:${lineNumber})`,
            existingFunc: null,
            reason: rule.description,
          });
        }
      }
    }
  }

  return blocks;
}

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
   * Produces a full 64-bit hash using a two-round MixHash approach.
   */
  hashToken(token) {
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = ((hash << 5) - hash) + token.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
    }
    // Round 1: 32-bit hash
    const h1 = BigInt(hash >>> 0);
    // Round 2: mix bits to produce upper 32 bits
    let hash2 = 0;
    for (let i = 0; i < token.length; i++) {
      hash2 = ((hash2 << 5) - hash2) ^ token.charCodeAt(i);
      hash2 = hash2 & hash2;
    }
    const h2 = BigInt(hash2 >>> 0) << 32n;
    return h1 | h2;
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
 * Detect PR-internal reuse opportunities using SimHash.
 */
function detectInternalReuse(newFunctions) {
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
          file: block.file,
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
function detectAntiPatterns(newFunctions) {
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
export async function detectReuse(prNum, baseBranch, worktreePath, repo, client, sessionKey) {
  console.log(`[review-reuse] Starting for PR #${prNum} (base: ${baseBranch})`);

  // Step 1: Ensure base branch index is fresh
  const freshness = checkIndexFreshness(repo, baseBranch, worktreePath);
  console.log(`[review-reuse] Freshness: ${freshness.fresh} (indexed: ${freshness.indexedCommit?.slice(0, 7)}, current: ${freshness.currentCommit?.slice(0, 7)})`);

  if (!freshness.fresh) {
    console.log(`[review-reuse] Index stale, rebuilding for ${baseBranch}...`);
    getOrBuildIndex(worktreePath, repo, baseBranch);
  }

  // Step 2: Load base branch index
  const { files: baseIndex } = loadIndex(repo, baseBranch);
  if (!baseIndex || Object.keys(baseIndex).length === 0) {
    console.log(`[review-reuse] No index found for ${repo}@${baseBranch}, building...`);
    getOrBuildIndex(worktreePath, repo, baseBranch);
    const idx = loadIndex(repo, baseBranch);
    return { items: [], newFunctions: [] };
  }

  // Step 3: Extract new functions + inline blocks from PR diff (with actual code)
  const { functions: newFunctions, inlineBlocks } = await extractNewFunctionsFromDiff(prNum, baseBranch, client, repo, worktreePath);
  console.log(`[review-reuse] Found ${newFunctions.length} new functions and ${inlineBlocks.length} inline blocks in PR`);

  if (newFunctions.length === 0 && inlineBlocks.length === 0) {
    return { items: [], newFunctions: [], inlineBlocks: [] };
  }

  // Collect PR-modified files (for filtering candidates)
  const prFiles = new Set(newFunctions.map(fn => fn.file));

  // Step 3.5: Structural Match — find functions with similar call patterns
  const structuralCandidates = [];
  for (const fn of newFunctions) {
    if (!fn.code) continue;
    const callPatterns = extractCallPatterns(fn.code);
    if (callPatterns.length < 2) continue; // Need at least 2 call patterns to match
    const matches = findStructuralMatches(callPatterns, baseIndex, 0.4);
    // Filter out candidates from PR-modified files
    const filtered = matches.filter(m => !prFiles.has(m.file));
    if (filtered.length > 0) {
      structuralCandidates.push({
        newFunc: fn,
        structuralMatches: filtered.slice(0, 3),
      });
    }
  }
  console.log(`[review-reuse] Found ${structuralCandidates.length} structural matches`);

  // Step 4: Fuzzy search for each new function
  const candidates = [];
  for (const fn of newFunctions) {
    const results = searchSymbols(baseIndex, `${fn.name} ${fn.signature}`, { threshold: 0.5, limit: 5 });
    // Filter out candidates from files that were modified in this PR
    const duplicates = results.filter(r => !prFiles.has(r.file));
    candidates.push({ newFunc: fn, duplicates });
  }

  // Step 5: PR Internal Duplicate Detection (SimHash)
  const internalDuplicates = detectInternalReuse(newFunctions);
  console.log(`[review-reuse] Found ${internalDuplicates.length} internal duplicates`);

  // Step 6: Pattern Anti-Pattern Detection
  const patternFindings = detectAntiPatterns(newFunctions);
  console.log(`[review-reuse] Found ${patternFindings.length} pattern anti-patterns`);

  // Step 6.5: Inline block findings (from inline code block extraction)
  const inlineFindings = inlineBlocks.map(block => ({
    newFunc: block.newFunc,
    existingFunc: block.existingFunc,
    verdict: block.verdict,
    severity: block.severity,
    reason: block.description,
    code: block.snippet,
  }));

  // Step 7: Specialized LLM call (now with actual code + structural matches)
  const items = await requestReuseVerdict(newFunctions, candidates, sessionKey, internalDuplicates, patternFindings, structuralCandidates);
  console.log(`[review-reuse] LLM found ${items.length} reuse/similar items`);

  // Merge all findings
  const structuralItems = structuralCandidates
    .filter(sc => sc.structuralMatches && sc.structuralMatches.length > 0)
    .map(sc => ({
      newFunc: sc.newFunc.name,
      existingFunc: sc.structuralMatches[0].symbol.name,
      verdict: 'similar',
      severity: 'medium',
      reason: `Structural match: both call ${sc.structuralMatches[0].similarity >= 0.7 ? 'similar' : 'partially overlapping'} utility patterns (${sc.structuralMatches[0].similarity.toFixed(2)} similarity)`,
      code: sc.newFunc.code ? sc.newFunc.code.slice(0, 150) : null,
    }));

  const allItems = [
    ...internalDuplicates,
    ...patternFindings,
    ...inlineFindings,
    ...structuralItems,
    ...items,
  ];

  // Deduplicate: same (newFunc, existingFunc, verdict) → keep highest severity first
  // For 'pattern' verdict, also include patternId so distinct anti-patterns on the
  // same function are preserved rather than collapsed into one.
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const seen = new Map();
  for (const item of allItems) {
    const patternDiscriminator = item.verdict === 'pattern' ? (item.patternId || item.ruleId || '') : '';
    const key = `${item.newFunc}::${item.existingFunc || ''}::${item.verdict}::${patternDiscriminator}`;
    const existing = seen.get(key);
    if (!existing || severityRank[item.severity] < severityRank[existing.severity]) {
      seen.set(key, item);
    }
  }
  const deduplicated = Array.from(seen.values());

  return { items: deduplicated, newFunctions, inlineBlocks };
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
    return { functions: [], inlineBlocks: [] };
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
      return { functions: [], inlineBlocks: [] };
    }
  }

  if (changedFiles.length === 0) {
    console.log(`[duplicate-detector] No changed files found`);
    return { functions: [], inlineBlocks: [] };
  }

  // Get diff for each changed file
  const newFunctions = [];
  const allInlineBlocks = [];

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

      // Extract inline code blocks (non-function patterns)
      // Pass parsed functions so we can exclude lines inside their bodies
      const inlineBlocks = extractInlineBlocksFromDiff(diff, file, lang, funcs);
      allInlineBlocks.push(...inlineBlocks);
    } catch (e) {
      console.log(`[duplicate-detector] Failed to diff ${file}: ${e.message}`);
    }
  }

  return { functions: newFunctions, inlineBlocks: allInlineBlocks };
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
async function requestReuseVerdict(newFunctions, candidates, sessionKey, internalDuplicates = [], patternFindings = [], structuralCandidates = []) {
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

  // Build structural matches list
  const structuralList = structuralCandidates.length > 0
    ? structuralCandidates
        .map(sc => {
          if (!sc.structuralMatches || sc.structuralMatches.length === 0) return '';
          const matches = sc.structuralMatches
            .map(m => `  - ${m.symbol.name} (${m.file}, similarity: ${m.similarity.toFixed(2)})`)
            .join('\n');
          return `NEW FUNCTION: ${sc.newFunc.name}\n${matches}`;
        })
        .filter(Boolean)
        .join('\n\n')
    : '(none)';

  const systemPrompt = REUSE_SYSTEM_PROMPT
    .replace('{newFunctions list}', newFuncList || '(none)')
    .replace('{candidates list}', candList || '(no candidates found)')
    .replace('{internal duplicates list}', internalList)
    .replace('{patterns list}', patternsList)
    .replace('{structural matches list}', structuralList);

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
