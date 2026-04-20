/**
 * Break-Change Detection — Review flow Step 2.
 *
 * Detects when PR modifications break existing code that depends on
 * modified functions. Uses regex+grep-based function analysis.
 *
 * Detection types:
 *   - function-deleted:   function exists in base branch, missing in PR
 *   - signature-changed:  params/return type changed
 *   - caller-lost:        base has call sites, PR callers are gone or modified
 *   - export-removed:     exported function/variable removed
 *   - semantic-change:    LLM judges if logic change affects callers
 */

import { exec } from './exec.js';
import { getChangedFiles } from './codebase-index.js';
import { resolveModel, callAI } from './ai.js';


// ---------------------------------------------------------------------------
// LSP Configuration
// ---------------------------------------------------------------------------


// Language file extensions (used for grep-based call-site search)
const LANG_EXTENSIONS = {
  javascript: ['js', 'jsx', 'mjs', 'ts', 'tsx'],
  typescript: ['ts', 'tsx', 'js', 'jsx', 'mjs'],
  python: ['py'],
  go: ['go'],
  rust: ['rs'],
};
// Map file extension to language
const EXT_TO_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java', rb: 'ruby', cs: 'csharp',
  cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
};

// Function definition patterns per language
const FUNC_PATTERNS = {
  javascript: /\b(?:export\s+)?function\s+(\w+)|\b(?:export\s+)?(?:async\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(|\b(?:export\s+)?class\s+(\w+)/,
  typescript: /\b(?:export\s+)?function\s+(\w+)|\b(?:export\s+)?(?:async\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(|\b(?:export\s+)?class\s+(\w+)/,
  python: /^def\s+(\w+)|^async\s+def\s+(\w+)|^class\s+(\w+)/,
  go: /^func\s+(\w+)|^func\s+\([\w\s]+\*?\w+\)\s+(\w+)/,
  rust: /^pub\s+(?:async\s+)?fn\s+(\w+)|^pub\s+struct\s+(\w+)|^pub\s+enum\s+(\w+)/,
};

// Signature extraction patterns
const SIG_PATTERNS = {
  javascript: /(?:function\s+\w+\s*\(([^)]*)\)|(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>(?:[^=]|$))/,
  typescript: /(?:function\s+\w+\s*\(([^)]*)\)|(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>(?:[^=]|$))/,
  python: /def\s+\w+\s*\(([^)]*)\)/,
  go: /func\s+\w+\s*\(([^)]*)\)/,
  rust: /fn\s+\w+\s*\(([^)]*)\)/,
};

// ---------------------------------------------------------------------------
// Extract modified functions from diff
// ---------------------------------------------------------------------------

/**
 * Get file content at a specific git ref.
 */
function getFileAtRef(worktreePath, filePath, ref) {
  try {
    return exec(
      `git show ${ref}:${filePath}`,
      { cwd: worktreePath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch {
    return null;
  }
}

/**
 * Extract all function definitions from file content.
 */
function extractFunctions(content, lang) {
  if (!content) return [];
  const pattern = FUNC_PATTERNS[lang] || FUNC_PATTERNS.javascript;
  const lines = content.split('\n');
  const functions = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const match = trimmed.match(pattern);
    if (!match) continue;

    const name = match[1] || match[2] || match[3];
    if (!name) continue;

    // Extract signature from the line
    const sigMatch = trimmed.match(SIG_PATTERNS[lang] || SIG_PATTERNS.javascript);
    let signature = name;
    if (sigMatch) {
      const params = sigMatch[1] || sigMatch[2] || sigMatch[3] || '';
      signature = `${name}(${params})`;
    }

    functions.push({
      name,
      signature,
      line: i + 1,
      isExported: trimmed.includes('export'),
    });
  }

  return functions;
}

/**
 * Find functions that exist in base but are missing in PR (deleted or renamed).
 * Also detect signature changes for functions that exist in both.
 */
function diffFunctions(baseFuncs, prFuncs) {
  const baseMap = new Map(baseFuncs.map((f) => [f.name, f]));
  const prMap = new Map(prFuncs.map((f) => [f.name, f]));

  const deleted = [];
  const signatureChanged = [];

  for (const [name, baseFn] of baseMap) {
    const prFn = prMap.get(name);
    if (!prFn) {
      // Function exists in base but not in PR
      deleted.push(baseFn);
    } else if (baseFn.signature !== prFn.signature) {
      // Same function but signature changed
      signatureChanged.push({ base: baseFn, pr: prFn });
    }
  }

  return { deleted, signatureChanged };
}

/**
 * Get all changed files from a PR diff, grouped by language.
 */
function getChangedFilesByLanguage(worktreePath, baseRef, headRef) {
  const changedFiles = getChangedFiles(worktreePath, baseRef, headRef);
  const byLang = {};

  for (const file of changedFiles) {
    const ext = file.split('.').pop().toLowerCase();
    const lang = EXT_TO_LANG[ext];
    if (!lang) continue;

    if (!byLang[lang]) byLang[lang] = [];
    byLang[lang].push(file);
  }

  return byLang;
}

// ---------------------------------------------------------------------------
// Call-site analysis (using grep-based approach since LSP is complex)
// ---------------------------------------------------------------------------

/**
 * Find all references to a function in the codebase at a given ref.
 * Uses grep to find call sites.
 */
function findCallSites(worktreePath, funcName, ref, lang) {
  // Build search patterns for different call styles
  const patterns = [
    new RegExp(`\\b${funcName}\\s*\\(`, 'g'),  // funcName(...)
    new RegExp(`\\b${funcName}\\b`, 'g'),      // funcName (anywhere)
  ];

  const callSites = [];

  // Search in all files of the same language
  try {
    // Find files of the same language
    const exts = LANG_EXTENSIONS[lang] || [lang];
    for (const ext of exts) {
      const output = exec(
        `git ls-tree -r --name-only ${ref} | grep '\\.${ext}$'`,
        { cwd: worktreePath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      const files = output.split('\n').filter(Boolean);
      for (const file of files) {
        try {
          const content = exec(
            `git show ${ref}:${file}`,
            { cwd: worktreePath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
          );

          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const pat of patterns) {
              pat.lastIndex = 0;
              if (pat.test(line)) {
                callSites.push({ file, line: i + 1, text: line.trim() });
                break;
              }
            }
          }
        } catch {
          // File might not exist at this ref
        }
      }
    }
  } catch {
    // No files found
  }

  return callSites;
}

/**
 * Check if a call site still exists in PR (i.e., is not removed or modified).
 */
function isCallSiteModified(worktreePath, callSite, baseRef, headRef) {
  try {
    const baseContent = exec(
      `git show ${baseRef}:${callSite.file}`,
      { cwd: worktreePath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const baseLines = baseContent.split('\n');
    const baseLine = baseLines[callSite.line - 1]?.trim() || '';

    // Check if PR version has the same call
    const prContent = getFileAtRef(worktreePath, callSite.file, headRef);
    if (!prContent) return true; // File deleted

    const prLines = prContent.split('\n');
    const prLine = prLines[callSite.line - 1]?.trim() || '';

    // If the line content is the same, call site is preserved
    return baseLine !== prLine;
  } catch {
    return true; // Assume modified if we can't check
  }
}


// ---------------------------------------------------------------------------
// LLM semantic change detection
// ---------------------------------------------------------------------------

const SEMANTIC_CHANGE_PROMPT = `You are a code break-change analyzer. Your job is to determine whether a modification to an existing function's logic could break its callers.

## MODIFIED FUNCTION
Name: {funcName}
File: {file}
Language: {lang}

## BASE VERSION (original):
\`\`\`
{baseCode}
\`\`\`

## PR VERSION (modified):
\`\`\`
{prCode}
\`\`\`

## CALLERS IN BASE BRANCH (functions that call this function):
{callers}

## TASK
Analyze whether the logic change in the PR version could break any of the callers. Consider:
1. Return value type/structure changed?
2. Exception/error behavior changed?
3. Side effects added/removed/changed?
4. Preconditions/postconditions violated?
5. Async behavior changed?

Output ONLY valid JSON:
{
  "breaks": true|false,
  "severity": "critical"|"high"|"medium"|"low",
  "reason": "brief explanation of why this breaks or is safe",
  "affectedCallers": ["caller1", "caller2"] // if breaks=true
}`;

/**
 * Analyze semantic changes using LLM.
 */
async function analyzeSemanticChange(funcName, file, lang, baseCode, prCode, callers, sessionKey) {
  const callerList = callers.length > 0
    ? callers.map((c) => `${c.file}:${c.line} — ${c.text}`).join('\n')
    : '(no known callers in base branch)';

  const prompt = SEMANTIC_CHANGE_PROMPT
    .replace('{funcName}', funcName)
    .replace('{file}', file)
    .replace('{lang}', lang)
    .replace('{baseCode}', baseCode || '(unavailable)')
    .replace('{prCode}', prCode || '(unavailable)')
    .replace('{callers}', callerList);

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { model } = await resolveModel(sessionKey);
      const response = await callAI(model, prompt, '', sessionKey);
      const trimmed = response.trim();
      const jsonStr = trimmed.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
      return JSON.parse(jsonStr);
    } catch (e) {
      lastError = e;
      console.error(`[break-change] LLM attempt ${attempt} failed: ${e.message}`);
    }
  }

  console.error(`[break-change] LLM failed: ${lastError.message}`);
  return { breaks: false, severity: 'low', reason: 'LLM analysis failed, assuming safe', affectedCallers: [] };
}

// ---------------------------------------------------------------------------
// Main detection flow
// ---------------------------------------------------------------------------

/**
 * Main entry point: detect break-changes in a PR.
 *
 * @param {number} prNum - PR number
 * @param {string} baseBranch - Target branch (e.g. 'main')
 * @param {string} worktreePath - Worktree path for git operations
 * @param {string} repo - "owner/repo"
 * @param {GitHubClient} client - GitHub API client
 * @param {string} sessionKey - Session key for LLM calls
 * @returns {Promise<{ items: BreakChangeItem[] }>}
 */
export async function detectBreakChange(prNum, baseBranch, worktreePath, repo, headRef, sessionKey) {
  console.log(`[break-change] Starting for PR #${prNum} (base: ${baseBranch}, head: ${headRef})`);

  const items = [];

  // Get changed files grouped by language
  const changedFilesByLang = getChangedFilesByLanguage(
    worktreePath,
    `origin/${baseBranch}`,
    `origin/${headRef}`
  );

  if (Object.keys(changedFilesByLang).length === 0) {
    return { items: [] };
  }

  // Process each language
  const languages = Object.keys(changedFilesByLang);
  console.log(`[break-change] Languages in PR: ${languages.join(', ')}`);

  for (const [lang, files] of Object.entries(changedFilesByLang)) {
    console.log(`[break-change] Analyzing ${lang} files`);

    for (const file of files) {
      const fileItems = await analyzeFileBreakChange(
        file,
        lang,
        baseBranch,
        worktreePath,
        sessionKey
      );
      items.push(...fileItems);
    }
  }

  console.log(`[break-change] Found ${items.length} break-change items`);
  return { items };
}

/**
 * Analyze a single file for break-changes.
 */
async function analyzeFileBreakChange(file, lang, baseBranch, worktreePath, sessionKey) {
  const items = [];
  const baseRef = `origin/${baseBranch}`;
  const headRef = `HEAD`; // Worktree is on PR branch

  // Get base and PR versions of the file
  const baseContent = getFileAtRef(worktreePath, file, baseRef);
  const prContent = getFileAtRef(worktreePath, file, headRef);

  // If file is new (no base content), it's not a break-change scenario
  if (!baseContent) {
    console.log(`[break-change] ${file} is new, skipping`);
    return items;
  }

  // If file was deleted in PR
  if (!prContent) {
    // Check if file had any exported functions that were used elsewhere
    const baseFuncs = extractFunctions(baseContent, lang);
    for (const fn of baseFuncs) {
      if (fn.isExported) {
        items.push({
          verdict: 'function-deleted',
          severity: 'critical',
          reason: `exported function '${fn.name}' was deleted (file removed)`,
          file,
          funcName: fn.name,
          funcSignature: fn.signature,
        });
      }
    }
    return items;
  }

  // Extract functions from both versions
  const baseFuncs = extractFunctions(baseContent, lang);
  const prFuncs = extractFunctions(prContent, lang);

  // Find deleted and signature-changed functions
  const { deleted, signatureChanged } = diffFunctions(baseFuncs, prFuncs);

  // Process deleted functions
  for (const fn of deleted) {
    // Find call sites in base branch
    const callers = findCallSites(worktreePath, fn.name, baseRef, lang);

    if (callers.length > 0) {
      // Check if all callers were also modified in the PR
      const modifiedCallers = callers.filter((c) => isCallSiteModified(worktreePath, c, baseRef, headRef));
      const lostCallers = callers.filter((c) => !isCallSiteModified(worktreePath, c, baseRef, headRef));

      if (lostCallers.length > 0) {
        items.push({
          verdict: 'caller-lost',
          severity: 'critical',
          reason: `function '${fn.name}' deleted, ${lostCallers.length} call site(s) in base branch are not preserved in PR`,
          file,
          funcName: fn.name,
          funcSignature: fn.signature,
          callSites: lostCallers,
        });
      }
    } else {
      // No known call sites but function was exported
      if (fn.isExported) {
        items.push({
          verdict: 'export-removed',
          severity: 'high',
          reason: `exported function '${fn.name}' was removed`,
          file,
          funcName: fn.name,
          funcSignature: fn.signature,
        });
      }
    }
  }

  // Process signature-changed functions
  for (const { base: baseFn, pr: prFn } of signatureChanged) {
    // Find call sites in base branch
    const callers = findCallSites(worktreePath, baseFn.name, baseRef, lang);

    // Check if callers are preserved in PR
    const lostCallers = callers.filter((c) => !isCallSiteModified(worktreePath, c, baseRef, headRef));

    if (lostCallers.length > 0) {
      items.push({
        verdict: 'signature-changed',
        severity: 'critical',
        reason: `function '${baseFn.name}' signature changed from '${baseFn.signature}' to '${prFn.signature}', but ${lostCallers.length} call site(s) in base branch still use old signature`,
        file,
        funcName: baseFn.name,
        funcSignature: baseFn.signature,
        newSignature: prFn.signature,
        callSites: lostCallers,
      });
    } else if (callers.length > 0) {
      // Callers exist but were all modified in PR — check if they were updated
      items.push({
        verdict: 'signature-changed',
        severity: 'medium',
        reason: `function '${baseFn.name}' signature changed from '${baseFn.signature}' to '${prFn.signature}', but all existing call sites were also modified`,
        file,
        funcName: baseFn.name,
        funcSignature: baseFn.signature,
        newSignature: prFn.signature,
      });
    }
  }

  // For semantic changes: find modified functions where signature is the same
  // but the body changed (logic modification)
  const baseFuncMap = new Map(baseFuncs.map((f) => [f.name, f]));
  const prFuncMap = new Map(prFuncs.map((f) => [f.name, f]));

  const semanticChanges = [];
  for (const [name, baseFn] of baseFuncMap) {
    const prFn = prFuncMap.get(name);
    if (!prFn) continue; // Already handled as deleted

    // Signature same but check if body changed
    if (baseFn.signature === prFn.signature) {
      // Extract function body from base and PR
      const baseBody = extractFunctionBody(baseContent, baseFn.line, lang);
      const prBody = extractFunctionBody(prContent, prFn.line, lang);

      if (baseBody && prBody && baseBody !== prBody) {
        semanticChanges.push({ baseFn, prFn, baseBody, prBody });
      }
    }
  }

  // Analyze semantic changes with LLM
  for (const { baseFn, prFn, baseBody, prBody } of semanticChanges) {
    const callers = findCallSites(worktreePath, baseFn.name, baseRef, lang);

    if (callers.length === 0) continue; // No known callers, skip

    const llmResult = await analyzeSemanticChange(
      baseFn.name,
      file,
      lang,
      baseBody,
      prBody,
      callers,
      sessionKey
    );

    if (llmResult.breaks) {
      items.push({
        verdict: 'semantic-change',
        severity: llmResult.severity || 'high',
        reason: llmResult.reason,
        file,
        funcName: baseFn.name,
        funcSignature: baseFn.signature,
        affectedCallers: llmResult.affectedCallers || callers.map((c) => c.file),
      });
    }
  }

  return items;
}

/**
 * Extract function body from file content given function start line.
 */
function extractFunctionBody(content, startLine, lang) {
  if (!content) return null;
  const lines = content.split('\n');
  if (startLine < 1 || startLine > lines.length) return null;

  const startIdx = startLine - 1;
  const firstLine = lines[startIdx];

  // Detect function start patterns
  const isFuncStart = firstLine.match(/(?:function|def|fn|export\s+(?:async\s+)?function|export\s+(?:async\s+)?const|class)\s+\w+/);

  if (!isFuncStart) return null;

  // Collect the function body
  // For JS/TS: find matching braces
  // For Python: indentation-based
  // For Go/Rust: find matching braces

  if (lang === 'python') {
    const funcLine = lines[startIdx];
    const indentMatch = funcLine.match(/^(\s*)/);
    const baseIndent = indentMatch ? indentMatch[1].length : 0;

    const bodyLines = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') {
        bodyLines.push(line);
        continue;
      }
      const indent = line.match(/^(\s*)/)?.[1]?.length || 0;
      if (indent <= baseIndent && line.trim()) break;
      bodyLines.push(line);
    }
    return bodyLines.join('\n');
  } else {
    // Brace-based languages
    let braceCount = 0;
    const bodyLines = [];
    let foundOpenBrace = false;

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      bodyLines.push(line);

      const openCount = (line.match(/{/g) || []).length;
      const closeCount = (line.match(/}/g) || []).length;

      if (!foundOpenBrace && openCount > 0) {
        foundOpenBrace = true;
        braceCount = openCount - closeCount;
      } else {
        braceCount += openCount - closeCount;
      }

      if (foundOpenBrace && braceCount <= 0) break;
    }

    return bodyLines.join('\n');
  }
}
