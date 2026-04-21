/**
 * Break-Change Detection — Review flow Step 2.
 *
 * Uses LSP (Language Server Protocol) for accurate function and reference analysis.
 * - On-demand: Start LSP process when needed, close after use
 * - No fallback: If LSP for a language is not found, skip entirely
 * - Supported: TypeScript/JavaScript (tsserver), Go (gopls), Rust (rust-analyzer), Python (pylsp)
 *
 * Detection types:
 *   - function-deleted:   function exists in base branch, missing in PR
 *   - signature-changed:  params/return type changed
 *   - caller-lost:        base has call sites, PR callers are gone or modified
 *   - export-removed:    exported function/variable removed
 *   - semantic-change:    LLM judges if logic change affects callers
 */

import { exec } from './exec.js';
import { getChangedFiles } from './codebase-index.js';
import { resolveModel, callAI } from './ai.js';
import { spawn } from 'child_process';


// ---------------------------------------------------------------------------
// LSP Configuration
// ---------------------------------------------------------------------------

const LSP_BINARIES = {
  javascript: 'typescript-language-server',
  typescript: 'typescript-language-server',
  python: 'pylsp',
  go: 'gopls',
  rust: 'rust-analyzer',
};

const LSP_INIT_TIMEOUT = 15000;
const LSP_REQUEST_TIMEOUT = 10000;


// ---------------------------------------------------------------------------
// LSP Session Class
// ---------------------------------------------------------------------------

/**
 * LSP session manager — wraps a language server process with RPC semantics.
 */
class LspSession {
  constructor(process, lang) {
    this.process = process;
    this.lang = lang;
    this.messageBuffer = '';
    this.pendingRequests = new Map();
    this.nextId = 1;
    this.initialized = false;
    this._resolveInit = null;
    this._initPromise = new Promise((r) => { this._resolveInit = r; });

    process.stdout.on('readable', () => this._receive());
    process.stderr.on('data', () => {}); // Discard stderr
  }

  /**
   * Send an LSP request and wait for response.
   */
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request '${method}' (id=${id}) timed out`));
      }, LSP_REQUEST_TIMEOUT);

      this.pendingRequests.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message || 'LSP error'));
        else resolve(msg.result || null);
      });

      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /**
   * Wait for LSP to be initialized.
   */
  waitReady() {
    return this._initPromise;
  }

  /**
   * Send shutdown and kill process.
   */
  close() {
    try {
      if (this.initialized) {
        this.request('shutdown', {}).catch(() => {});
      }
    } catch {}
    setTimeout(() => {
      try { this.process.kill(); } catch {}
    }, 500);
  }

  _send(msg) {
    if (this.process && this.process.stdin && !this.process.stdin.destroyed) {
      this.process.stdin.write(JSON.stringify(msg) + '\n');
    }
  }

  _receive() {
    let chunk;
    while ((chunk = this.process.stdout.read()) !== null) {
      this.messageBuffer += chunk;
      const lines = this.messageBuffer.split('\n');
      this.messageBuffer = lines.pop() || '';

      for (const raw of lines) {
        if (!raw.trim()) continue;
        try {
          const msg = JSON.parse(raw);
          this._handle(msg);
        } catch {}
      }
    }
  }

  _handle(msg) {
    // Response to our request
    if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
      const resolve = this.pendingRequests.get(msg.id);
      this.pendingRequests.delete(msg.id);
      resolve(msg);
      return;
    }

    // Server-initiated message
    if (msg.method === 'initialized') {
      this.initialized = true;
      this._resolveInit(this);
    } else if (msg.method === 'shutdown') {
      this._send({ jsonrpc: '2.0', id: msg.id, result: null });
    }
  }
}

/**
 * Start an LSP server and perform handshake.
 * Returns ready LspSession or null if failed.
 */
async function startLsp(lang, cwd) {
  const binary = LSP_BINARIES[lang];
  if (!binary) return null;

  // Check binary exists
  try {
    exec(`which ${binary}`, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(binary, ['--stdio'], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }

    const session = new LspSession(proc, lang);

    // Initialize handshake
    session.request('initialize', {
      processId: proc.pid,
      rootUri: `file://${cwd}`,
      capabilities: {},
    }).then(() => {
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
    }).catch(() => {});

    // Timeout if init fails
    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve(null);
    }, LSP_INIT_TIMEOUT);

    session.waitReady().then((s) => {
      clearTimeout(timer);
      resolve(s);
    }).catch(() => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}


// ---------------------------------------------------------------------------
// Remote resolution
// ---------------------------------------------------------------------------

function resolveRemote(worktreePath) {
  try {
    const remote = exec('git remote', {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n')[0];
    return remote || 'origin';
  } catch {
    return 'origin';
  }
}


// ---------------------------------------------------------------------------
// File retrieval
// ---------------------------------------------------------------------------

function getFileAtRef(worktreePath, filePath, ref) {
  try {
    return exec(
      `git show ${ref}:${filePath}`,
      { cwd: worktreePath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch (e) {
    if (e.message && (e.message.includes('exists') || e.message.includes('not found'))) {
      console.warn(`[break-change] File '${filePath}' not found at ref '${ref}'`);
    }
    return null;
  }
}


// ---------------------------------------------------------------------------
// LSP-based function analysis
// ---------------------------------------------------------------------------

const SYMBOL_KINDS = {
  function: 1, method: 2, class: 5, interface: 11, enum: 9,
};

function isCallableKind(kind) {
  return [SYMBOL_KINDS.function, SYMBOL_KINDS.method].includes(kind);
}

/**
 * Get document symbols (functions, classes, etc.) via LSP.
 */
async function getDocumentSymbols(session, filePath, content) {
  try {
    const uri = `file://${filePath}`;

    // Open document
    await session.request('textDocument/didOpen', {
      textDocument: { uri, languageId: session.lang, version: 1, text: content || '' },
    });

    // Get symbols
    const symbols = await session.request('textDocument/documentSymbol', {
      textDocument: { uri },
    });

    return (symbols || []).map((s) => ({
      name: s.name,
      kind: s.kind,
      line: (s.range?.start?.line ?? 0) + 1,
      endLine: s.range?.end?.line ? s.range.end.line + 1 : null,
      isExported: s.name?.[0] === s.name?.[0]?.toUpperCase(),
    })).filter((s) => s.name);
  } catch (e) {
    console.warn(`[break-change] documentSymbol failed for ${filePath}: ${e.message}`);
    return [];
  }
}

/**
 * Find all references to a position via LSP.
 */
async function findReferences(session, filePath, line) {
  try {
    const uri = `file://${filePath}`;
    const refs = await session.request('textDocument/references', {
      textDocument: { uri },
      position: { line: Math.max(0, line - 1), character: 0 },
      context: { includeDeclaration: false },
    });

    return (refs || []).map((r) => ({
      file: r.uri?.replace(/^file:\/\//, '') || '',
      line: (r.range?.start?.line ?? 0) + 1,
    })).filter((r) => r.file);
  } catch (e) {
    console.warn(`[break-change] references failed for ${filePath}:${line}: ${e.message}`);
    return [];
  }
}

/**
 * Get hover info (signature/type) for a position.
 */
async function getHover(session, filePath, line) {
  try {
    const uri = `file://${filePath}`;
    const hover = await session.request('textDocument/hover', {
      textDocument: { uri },
      position: { line: Math.max(0, line - 1), character: 0 },
    });

    if (hover?.contents) {
      const text = typeof hover.contents === 'string'
        ? hover.contents
        : hover.contents.value || '';
      return text.split('\n')[0].slice(0, 200);
    }
  } catch {}
  return null;
}


// ---------------------------------------------------------------------------
// Change Detection helpers
// ---------------------------------------------------------------------------

function getChangedFilesByLanguage(worktreePath, baseRef, headRef) {
  const changedFiles = getChangedFiles(worktreePath, baseRef, headRef);
  const byLang = {};
  const EXT_TO_LANG = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
    py: 'python', go: 'go', rs: 'rust',
  };

  for (const file of changedFiles) {
    const ext = file.split('.').pop().toLowerCase();
    const lang = EXT_TO_LANG[ext];
    if (!lang) continue;
    if (!byLang[lang]) byLang[lang] = [];
    byLang[lang].push(file);
  }

  return byLang;
}

function isCallSiteModified(worktreePath, callSite, baseRef, headRef) {
  try {
    const baseContent = exec(
      `git show ${baseRef}:${callSite.file}`,
      { cwd: worktreePath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const baseLines = baseContent.split('\n');
    const baseLine = baseLines[callSite.line - 1]?.trim() || '';

    const prContent = getFileAtRef(worktreePath, callSite.file, headRef);
    if (!prContent) return true;

    const prLines = prContent.split('\n');
    const prLine = prLines[callSite.line - 1]?.trim() || '';

    return baseLine !== prLine;
  } catch {
    return true;
  }
}

function getFunctionBody(lines, startLine, endLine) {
  if (!lines || startLine < 1) return null;
  const start = Math.max(0, startLine - 1);
  const end = endLine ? Math.min(lines.length, endLine) : lines.length;
  return lines.slice(start, end).join('\n');
}


// ---------------------------------------------------------------------------
// LLM Semantic Analysis
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

async function analyzeSemanticChange(funcName, file, lang, baseCode, prCode, callers, sessionKey) {
  const callerList = callers.length > 0
    ? callers.map((c) => `${c.file}:${c.line}`).join('\n')
    : '(no known callers in base branch)';

  const prompt = SEMANTIC_CHANGE_PROMPT
    .replace('{funcName}', funcName)
    .replace('{file}', file)
    .replace('{lang}', lang)
    .replace('{baseCode}', baseCode || '(unavailable)')
    .replace('{prCode}', prCode || '(unavailable)')
    .replace('{callers}', callerList);

  let lastError;
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

  return { breaks: false, severity: 'low', reason: 'LLM analysis failed, assuming safe', affectedCallers: [] };
}


// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Detect break-changes in a PR using LSP-based analysis.
 *
 * @param {number} prNum - PR number
 * @param {string} baseBranch - Target branch (e.g. 'main')
 * @param {string} worktreePath - Worktree path for git operations
 * @param {string} repo - "owner/repo"
 * @param {string} headRef - Head branch reference
 * @param {string} sessionKey - Session key for LLM calls
 * @returns {Promise<{ items: BreakChangeItem[] }>}
 */
export async function detectBreakChange(prNum, baseBranch, worktreePath, repo, headRef, sessionKey) {
  console.log(`[break-change] Starting for PR #${prNum} (base: ${baseBranch}, head: ${headRef})`);

  const items = [];
  const remote = resolveRemote(worktreePath);
  const baseRef = `${remote}/${baseBranch}`;
  const prRef = 'HEAD';

  const changedFilesByLang = getChangedFilesByLanguage(worktreePath, baseRef, prRef);
  if (Object.keys(changedFilesByLang).length === 0) {
    return { items: [] };
  }

  const languages = Object.keys(changedFilesByLang);
  console.log(`[break-change] Languages in PR: ${languages.join(', ')}`);

  for (const [lang, files] of Object.entries(changedFilesByLang)) {
    if (!LSP_BINARIES[lang]) {
      console.log(`[break-change] No LSP configured for '${lang}', skipping`);
      continue;
    }

    console.log(`[break-change] Starting LSP for '${lang}'...`);
    const session = await startLsp(lang, worktreePath);
    if (!session) {
      console.warn(`[break-change] LSP not available or failed to start for '${lang}', skipping`);
      continue;
    }
    console.log(`[break-change] LSP ready for '${lang}'`);

    try {
      for (const file of files) {
        const fileItems = await analyzeFileBreakChange(
          file, lang, baseRef, prRef, worktreePath, session, sessionKey
        );
        items.push(...fileItems);
      }
    } finally {
      session.close();
    }
  }

  console.log(`[break-change] Found ${items.length} break-change items`);
  return { items };
}

/**
 * Analyze a single file for break-changes.
 */
async function analyzeFileBreakChange(file, lang, baseRef, prRef, worktreePath, session, sessionKey) {
  const items = [];

  const baseContent = getFileAtRef(worktreePath, file, baseRef);
  const prContent = getFileAtRef(worktreePath, file, prRef);

  if (!baseContent) {
    console.log(`[break-change] ${file} is new, skipping`);
    return items;
  }

  if (!prContent) {
    // File deleted — all exported symbols are gone
    const symbols = await getDocumentSymbols(session, file, baseContent);
    for (const sym of symbols) {
      if (sym.isExported) {
        items.push({
          verdict: 'function-deleted',
          severity: 'critical',
          reason: `exported function '${sym.name}' was deleted (file removed)`,
          file,
          funcName: sym.name,
        });
      }
    }
    return items;
  }

  // Get symbols from both versions
  const baseSymbols = await getDocumentSymbols(session, file, baseContent);
  const prSymbols = await getDocumentSymbols(session, file, prContent);

  const baseMap = new Map(baseSymbols.map((s) => [s.name, s]));
  const prMap = new Map(prSymbols.map((s) => [s.name, s]));

  const baseLines = baseContent.split('\n');
  const prLines = prContent.split('\n');

  for (const [name, baseSym] of baseMap) {
    const prSym = prMap.get(name);

    if (!prSym) {
      // Deleted
      const callers = await findReferences(session, file, baseSym.line);
      const lostCallers = callers.filter((c) => !isCallSiteModified(worktreePath, c, baseRef, prRef));

      if (lostCallers.length > 0) {
        items.push({
          verdict: 'caller-lost',
          severity: 'critical',
          reason: `function '${name}' deleted, ${lostCallers.length} call site(s) in base branch not preserved in PR`,
          file,
          funcName: name,
          callSites: lostCallers,
        });
      } else if (baseSym.isExported) {
        items.push({
          verdict: 'export-removed',
          severity: 'high',
          reason: `exported function '${name}' was removed`,
          file,
          funcName: name,
        });
      }
    } else if (baseSym.line !== prSym.line || baseSym.kind !== prSym.kind) {
      // Signature changed (different line or kind)
      const baseSig = await getHover(session, file, baseSym.line);
      const prSig = await getHover(session, file, prSym.line);

      const callers = await findReferences(session, file, baseSym.line);
      const lostCallers = callers.filter((c) => !isCallSiteModified(worktreePath, c, baseRef, prRef));

      if (baseSig && prSig && baseSig !== prSig) {
        items.push({
          verdict: 'signature-changed',
          severity: lostCallers.length > 0 ? 'critical' : 'medium',
          reason: `function '${name}' signature changed, ${lostCallers.length} call site(s) affected`,
          file,
          funcName: name,
          funcSignature: baseSig,
          newSignature: prSig,
          callSites: lostCallers,
        });
      }
    } else {
      // Same position — check body for semantic changes
      const baseBody = getFunctionBody(baseLines, baseSym.line, baseSym.endLine);
      const prBody = getFunctionBody(prLines, prSym.line, prSym.endLine);

      if (baseBody && prBody && baseBody !== prBody) {
        const callers = await findReferences(session, file, baseSym.line);

        if (callers.length > 0 || baseSym.isExported) {
          const llmResult = await analyzeSemanticChange(
            name, file, lang, baseBody, prBody, callers, sessionKey
          );

          if (llmResult.breaks) {
            items.push({
              verdict: 'semantic-change',
              severity: llmResult.severity || (baseSym.isExported ? 'high' : 'medium'),
              reason: llmResult.reason,
              file,
              funcName: name,
              affectedCallers: llmResult.affectedCallers || callers.map((c) => c.file),
            });
          }
        }
      }
    }
  }

  return items;
}
