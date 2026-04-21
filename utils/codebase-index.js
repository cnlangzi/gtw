/**
 * Codebase Index — Build, persist, and search function signatures.
 *
 * Serves as the foundation for duplicate detection in /gtw review.
 * - Per-branch index: ~/.gtw/codebase-index/{owner}/{repo}@{branch}.json
 * - Git-aware incremental updates (commit hash based)
 * - Fuzzy search via Fuse.js
 * - Reference tracking for impact analysis
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from './exec.js';
import { getExtractor } from './extractors/index.js';
import Fuse from 'fuse.js';
import { BASE_DIR } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INDEX_DIR = path.resolve(BASE_DIR, 'codebase-index');

const INCLUDED_EXTS = new Set([
  'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs',
  'go', 'py', 'java', 'rb', 'rs', 'cs', 'cpp', 'c', 'h', 'hpp',
  'sh', 'bash',
]);

const EXCLUDED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', 'coverage',
  '.next', '.nuxt', 'vendor', '__pycache__', '.pytest_cache',
  'target', 'bin', 'obj', '.cache', '.tmp',
]);

// ---------------------------------------------------------------------------
// Git helpers (run in worktree)
// ---------------------------------------------------------------------------

/**
 * Get current branch name in a worktree.
 * @param {string} worktreePath
 * @returns {string}
 */
function getCurrentBranch(worktreePath) {
  try {
    return exec('git rev-parse --abbrev-ref HEAD', {
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
  } catch {
    return 'main';
  }
}

/**
 * Get the commit hash of a local branch head.
 */
function getLocalBranchHead(worktreePath, branch) {
  try {
    return exec(`git rev-parse ${branch}`, {
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
  } catch {
    return '';
  }
}

/**
 * Get the commit hash of the remote branch (origin/<branch>).
 * Fetches origin first to ensure we have the latest.
 * @param {string} worktreePath
 * @param {string} branch
 * @returns {string} — empty string if remote branch not found
 */
function getRemoteBranchHead(worktreePath, branch) {
  try {
    // Fetch the specific remote branch
    exec(`git fetch origin refs/heads/${branch}:refs/remotes/origin/${branch} --depth=1`, {
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
  } catch {
    // fetch failed, try with existing refs
  }

  try {
    return exec(`git rev-parse origin/${branch}`, {
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
  } catch {
    return '';
  }
}

/**
 * Get the commit hash of a branch (local or remote).
 * Prefers remote (origin/<branch>) if available.
 */
function getBranchHead(worktreePath, branch) {
  // Try remote first (most likely to be up-to-date)
  const remote = getRemoteBranchHead(worktreePath, branch);
  if (remote) return remote;

  // Fall back to local
  return getLocalBranchHead(worktreePath, branch);
}

/**
 * Get list of files changed between two refs.
 * @param {string} worktreePath
 * @param {string} fromRef - base ref (older)
 * @param {string} toRef - head ref (newer)
 * @returns {string[]} - array of relative file paths
 */
function getChangedFiles(worktreePath, fromRef, toRef) {
  try {
    const output = exec(`git diff --name-only ${fromRef}..${toRef}`, {
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    return output ? output.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Get all tracked source files in worktree.
 */
function collectFiles(worktreePath) {
  const files = [];
  let entries;
  try {
    entries = fs.readdirSync(worktreePath, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = path.join(worktreePath, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      files.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = entry.name.split('.').pop().toLowerCase();
      if (!INCLUDED_EXTS.has(ext)) continue;
      try {
        const stat = fs.statSync(fullPath);
        const relPath = path.relative(worktreePath, fullPath);
        files.push({ path: relPath, fullPath, type: ext, size: stat.size, mtime: stat.mtime });
      } catch {}
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Path helpers — per-branch index
// ---------------------------------------------------------------------------

/**
 * Get index path for a specific branch.
 * Format: {owner}/{repo}@{branch}.json
 * Branch name sanitized (slashes replaced).
 */
function getIndexJsonPath(repo, branch) {
  const [owner, repoName] = repo.split('/');
  const repoDir = path.resolve(INDEX_DIR, owner);
  const safeBranch = branch.replace(/\//g, '_');
  return path.resolve(repoDir, `${repoName}@${safeBranch}.json`);
}

function getIndexMarkdownPath(repo, branch) {
  const [owner, repoName] = repo.split('/');
  const repoDir = path.resolve(INDEX_DIR, owner);
  const safeBranch = branch.replace(/\//g, '_');
  return path.resolve(repoDir, `${repoName}@${safeBranch}.md`);
}

/**
 * Sanitize branch name for use in file paths.
 * Replaces or removes characters that are invalid in filenames.
 */
function sanitizeBranch(branch) {
  return branch
    .replace(/\//g, '_')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\.+$/, '')
    .replace(/^\.+/, '')
    .replace(/_{2,}/g, '_')
    .slice(0, 200);
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderSymbolAsMarkdown(symbol, indent = '') {
  let md = `${indent}### \`${symbol.name}\`\n\n`;
  md += `${indent}\`\`\`${symbol.location.file.split('.').pop()}\n`;

  if (symbol.kind === 'class' || symbol.kind === 'struct' || symbol.kind === 'interface') {
    md += `${indent}/**\n`;
    if (symbol.docstring) {
      md += `${indent} * ${symbol.docstring.split('\n').join(`\n${indent} * `)}\n`;
    }
    md += `${indent} */\n`;
    md += `${indent}${symbol.signature}`;
    if (symbol.methods && symbol.methods.length > 0) {
      md += ' {\n';
      for (const method of symbol.methods) {
        md += `${indent}  ${method.signature}\n`;
        if (method.docstring) md += `${indent}  /** ${method.docstring} */\n`;
      }
      md += `${indent}}`;
    }
  } else {
    if (symbol.docstring) md += `${indent}/** ${symbol.docstring} */\n`;
    md += `${indent}${symbol.signature}`;
  }

  md += `\n${indent}\`\`\`\n`;

  if (symbol.parameters && symbol.parameters.length > 0) {
    md += `${indent}| Parameters | Type | Description |\n${indent}|---|---|---|\n`;
    for (const param of symbol.parameters) {
      const opt = param.optional ? ' (optional)' : '';
      md += `${indent}| ${param.name}${opt} | ${param.type || 'unknown'} | ${param.description || ''} |\n`;
    }
    md += '\n';
  }

  if (symbol.returnType) {
    md += `${indent}**Returns:** ${symbol.returnType}\n\n`;
  }

  return md;
}

function renderFileSection(filePath, symbols) {
  let md = `## ${filePath}\n\n`;
  for (const symbol of symbols) {
    md += renderSymbolAsMarkdown(symbol);
  }
  return md;
}

function renderMarkdownIndex(repo, branch, lastUpdated, lastCommit, files) {
  let md = `# Codebase Index: ${repo} (${branch})\n`;
  md += `Last updated: ${lastUpdated}\n`;
  md += `Last commit: ${lastCommit}\n\n`;

  for (const [filePath, symbols] of Object.entries(files)) {
    md += renderFileSection(filePath, symbols);
    md += '\n---\n\n';
  }
  return md;
}

// ---------------------------------------------------------------------------
// Index build - two-phase extraction
// ---------------------------------------------------------------------------

/**
 * Normalize extractor output to { definitions: [], localRefs: [] }.
 * Handles both legacy (array) and new ({ definitions: [], localRefs: [] }) formats.
 */
function normalizeExtractorOutput(raw, filePath) {
  if (!raw) return { definitions: [], localRefs: [] };

  // New format
  if (Array.isArray(raw)) {
    // Legacy format: just an array of symbols
    return { definitions: raw, localRefs: [] };
  }

  // Already new format
  if (Array.isArray(raw.definitions)) {
    return raw;
  }

  return { definitions: [], localRefs: [] };
}

/**
 * Index a single file, returning normalized output.
 */
function indexFile(fullPath, relativePath) {
  const extractor = getExtractor(fullPath);
  if (!extractor) return null;
  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    const result = extractor.extractExports(content, relativePath);
    return normalizeExtractorOutput(result, relativePath);
  } catch (e) {
    console.error(`[codebase-index] Failed to index ${relativePath}: ${e.message}`);
    return null;
  }
}

/**
 * Build full index for a worktree on a given branch.
 * Phase 1: Per-file extraction (definitions + local refs)
 * Phase 2: Cross-file reference resolution
 */
export function buildIndex(worktreePath, repo, branch) {
  const startTime = Date.now();
  const lastCommit = getBranchHead(worktreePath, branch);
  const files = collectFiles(worktreePath);

  const indexedFiles = {};
  const allLocalRefs = []; // { file, refs: [] }
  let totalFunctions = 0;
  let skippedFiles = 0;

  // Phase 1: Per-file extraction
  for (const file of files) {
    const result = indexFile(file.fullPath, file.path);
    if (result && result.definitions.length > 0) {
      indexedFiles[file.path] = result.definitions;
      totalFunctions += result.definitions.length;
    } else {
      skippedFiles++;
    }
    if (result && result.localRefs.length > 0) {
      allLocalRefs.push({ file: file.path, refs: result.localRefs });
    }
  }

  // Phase 2: Cross-file reference resolution
  const { refs, fileDeps } = buildReferenceIndex(indexedFiles, allLocalRefs);

  return {
    files: indexedFiles,
    refs,
    fileDeps,
    meta: {
      repo,
      branch,
      lastCommit,
      lastUpdated: new Date().toISOString(),
      stats: {
        totalFiles: files.length,
        indexedFiles: Object.keys(indexedFiles).length,
        skippedFiles,
        totalFunctions,
        elapsedMs: Date.now() - startTime,
      },
    },
  };
}

/**
 * Incrementally update index — only re-index files changed since last commit.
 */
export function buildIncrementalIndex(worktreePath, repo, branch, existingIndex) {
  const lastCommit = getBranchHead(worktreePath, branch);
  const previousCommit = existingIndex?.meta?.lastCommit;

  let changedFiles = new Set();
  if (previousCommit && previousCommit !== lastCommit) {
    const changed = getChangedFiles(worktreePath, previousCommit, lastCommit);
    changedFiles = new Set(changed);
    console.log(`[codebase-index] Branch ${branch}: ${changedFiles.size} files changed since ${previousCommit}`);
  }

  const previousFiles = existingIndex?.files || {};
  const indexedFiles = {};
  const allLocalRefs = [];
  let totalFunctions = 0;
  let rebuilt = 0;
  let unchanged = 0;

  if (!existingIndex || !previousFiles || Object.keys(previousFiles).length === 0) {
    console.log('[codebase-index] No existing index, doing full build');
    return buildIndex(worktreePath, repo, branch);
  }

  const currentFiles = collectFiles(worktreePath);

  for (const file of currentFiles) {
    const needsRebuild = changedFiles.has(file.path) || !previousFiles[file.path];

    if (needsRebuild) {
      const result = indexFile(file.fullPath, file.path);
      if (result && result.definitions.length > 0) {
        indexedFiles[file.path] = result.definitions;
        totalFunctions += result.definitions.length;
        rebuilt++;
      }
      if (result && result.localRefs.length > 0) {
        allLocalRefs.push({ file: file.path, refs: result.localRefs });
      }
    } else {
      indexedFiles[file.path] = previousFiles[file.path];
      totalFunctions += previousFiles[file.path].length;
      unchanged++;
    }
  }

  // Phase 2: Cross-file reference resolution
  const { refs: newRefs, fileDeps: newFileDeps } = buildReferenceIndex(indexedFiles, allLocalRefs);

  // Merge new refs with previous refs (unchanged files keep their refs)
  const previousRefs = existingIndex?.refs || {};
  const previousFileDeps = existingIndex?.fileDeps || {};
  const refs = { ...previousRefs, ...newRefs };
  const fileDeps = { ...previousFileDeps, ...newFileDeps };

  return {
    files: indexedFiles,
    refs,
    fileDeps,
    meta: {
      repo,
      branch,
      lastCommit,
      lastUpdated: new Date().toISOString(),
      stats: {
        totalFiles: currentFiles.length,
        indexedFiles: Object.keys(indexedFiles).length,
        totalFunctions,
        rebuilt,
        unchanged,
        elapsedMs: 0,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Reference index building (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Build global reference index from per-file local refs.
 * @param {Object} indexedFiles - file -> definitions map
 * @param {Array} allLocalRefs - [{ file, refs: [] }] per-file local references
 * @returns {{ refs: Object, fileDeps: Object }}
 */
function buildReferenceIndex(indexedFiles, allLocalRefs) {
  const refs = {};    // symbolId -> [{ file, line, col, kind, direct }]
  const fileDeps = {}; // file -> [dependent files]

  // Build symbol lookup: name -> symbolId for each file
  const symbolLookup = buildSymbolLookup(indexedFiles);

  // Process each file's local refs and resolve to global symbol IDs
  for (const { file: filePath, refs: localRefs } of allLocalRefs) {
    for (const ref of localRefs) {
      const symbolId = resolveSymbolRef(ref.name, filePath, symbolLookup);
      if (symbolId) {
        // Add to global refs index (deduplicated)
        if (!refs[symbolId]) {
          refs[symbolId] = [];
        }
        const isDuplicate = refs[symbolId].some(
          (r) => r.file === filePath && r.line === ref.line && r.col === ref.col
        );
        if (!isDuplicate) {
          refs[symbolId].push({
            file: filePath,
            line: ref.line,
            col: ref.col,
            kind: ref.kind,
            direct: true,
          });
        }

        // Track file dependencies
        const defFile = symbolId.split(':')[0];
        if (defFile !== filePath) {
          if (!fileDeps[defFile]) {
            fileDeps[defFile] = [];
          }
          if (!fileDeps[defFile].includes(filePath)) {
            fileDeps[defFile].push(filePath);
          }
        }
      }
    }
  }

  return { refs, fileDeps };
}

/**
 * Build a lookup table: file -> { symbolName -> symbolId }
 */
function buildSymbolLookup(indexedFiles) {
  const lookup = {};

  for (const [filePath, symbols] of Object.entries(indexedFiles)) {
    lookup[filePath] = {};
    for (const symbol of symbols) {
      // Use symbolId if available (new format), otherwise build from name
      const symbolId = symbol.symbolId || `${filePath}:${symbol.kind}:${symbol.name}`;
      lookup[filePath][symbol.name] = symbolId;

      // Also index methods under qualified names
      if (symbol.methods) {
        for (const method of symbol.methods) {
          const qualifiedName = `${symbol.name}.${method.name}`;
          const methodId = method.symbolId || `${filePath}:method:${qualifiedName}`;
          lookup[filePath][method.name] = methodId;
          lookup[filePath][qualifiedName] = methodId;
        }
      }
    }
  }

  return lookup;
}

/**
 * Resolve a local reference name to its global symbolId.
 * Searches in order: current file -> imported files (simplified)
 */
function resolveSymbolRef(refName, currentFile, symbolLookup) {
  // First check current file
  const currentSymbols = symbolLookup[currentFile];
  if (currentSymbols && currentSymbols[refName]) {
    return currentSymbols[refName];
  }

  // TODO: resolve imports (requires more complex import tracking)
  // For now, return null for cross-file refs that can't be resolved locally
  return null;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Save index to disk (Markdown + JSON).
 */
function saveIndexToDisk(repo, branch, indexData) {
  const jsonPath = getIndexJsonPath(repo, branch);
  const mdPath = getIndexMarkdownPath(repo, branch);

  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });

  // JSON
  const jsonPayload = {
    repo: indexData.meta.repo,
    branch: indexData.meta.branch,
    schemaVersion: '2.0',
    lastCommit: indexData.meta.lastCommit,
    lastUpdated: indexData.meta.lastUpdated,
    stats: indexData.meta.stats,
    files: indexData.files,
    refs: indexData.refs || {},
    fileDeps: indexData.fileDeps || {},
  };
  fs.writeFileSync(jsonPath, JSON.stringify(jsonPayload, null, 2), 'utf8');

  // Markdown
  const markdown = renderMarkdownIndex(
    repo,
    branch,
    indexData.meta.lastUpdated,
    indexData.meta.lastCommit,
    indexData.files
  );
  fs.writeFileSync(mdPath, markdown, 'utf8');

  console.log(`[codebase-index] Saved ${repo}@${branch} → ${jsonPath}`);
  return jsonPath;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load index for a specific branch.
 * @returns {{ files: Record<string, object[]>, meta: object, refs?: object, fileDeps?: object } | null}
 */
export function loadIndex(repo, branch) {
  const jsonPath = getIndexJsonPath(repo, branch);
  if (!fs.existsSync(jsonPath)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return {
      files: data.files || {},
      refs: data.refs || {},
      fileDeps: data.fileDeps || {},
      meta: {
        repo: data.repo,
        branch: data.branch,
        lastCommit: data.lastCommit,
        lastUpdated: data.lastUpdated,
        stats: data.stats,
      },
    };
  } catch (e) {
    console.error(`[codebase-index] Failed to load index: ${e.message}`);
    return null;
  }
}

/**
 * Load Markdown content of index for prompt injection.
 */
export function loadIndexMarkdown(repo, branch) {
  const mdPath = getIndexMarkdownPath(repo, branch);
  if (!fs.existsSync(mdPath)) return null;
  return fs.readFileSync(mdPath, 'utf8');
}

/**
 * Check if index for a branch is fresh (commit matches current remote HEAD).
 * Uses origin/<branch> for freshness check — ensures we detect remote updates.
 * @returns {{ fresh: boolean, indexedCommit: string, currentCommit: string }}
 */
export function checkIndexFreshness(repo, branch, worktreePath) {
  const existing = loadIndex(repo, sanitizeBranch(branch));
  const currentCommit = getRemoteBranchHead(worktreePath, branch);

  if (!existing) {
    return { fresh: false, indexedCommit: null, currentCommit };
  }

  return {
    fresh: existing.meta.lastCommit === currentCommit,
    indexedCommit: existing.meta.lastCommit,
    currentCommit,
  };
}

/**
 * Get or build index for a branch (incremental if existing).
 */
export function getOrBuildIndex(worktreePath, repo, branch, { force = false } = {}) {
  if (force) {
    const data = buildIndex(worktreePath, repo, branch);
    return saveIndexToDisk(repo, branch, data);
  }

  const existing = loadIndex(repo, branch);
  if (existing) {
    const data = buildIncrementalIndex(worktreePath, repo, branch, existing);
    return saveIndexToDisk(repo, branch, data);
  }

  const data = buildIndex(worktreePath, repo, branch);
  return saveIndexToDisk(repo, branch, data);
}

/**
 * Rebuild index for a branch (always full).
 */
export function rebuildIndex(worktreePath, repo, branch) {
  const data = buildIndex(worktreePath, repo, branch);
  return saveIndexToDisk(repo, branch, data);
}

/**
 * Remove index for a branch.
 */
export function removeIndex(repo, branch) {
  const jsonPath = getIndexJsonPath(repo, branch);
  const mdPath = getIndexMarkdownPath(repo, branch);
  try {
    if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
    if (fs.existsSync(mdPath)) fs.unlinkSync(mdPath);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * List all indexed branches for a repo.
 */
export function listIndexedBranches(repo) {
  const [owner] = repo.split('/');
  const repoDir = path.resolve(INDEX_DIR, owner);
  if (!fs.existsSync(repoDir)) return [];

  const prefix = repo.split('/')[1] + '@';
  return fs.readdirSync(repoDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => f.replace(prefix, '').replace('.json', ''));
}

// ---------------------------------------------------------------------------
// Impact Analysis API
// ---------------------------------------------------------------------------

/**
 * Get all references for a symbol.
 * @param {string} symbolId - e.g., "src/auth.js:func:validateToken"
 * @param {Object} indexData - loaded index data
 * @returns {Array} - reference locations
 */
export function getSymbolReferences(symbolId, indexData) {
  if (!indexData || !indexData.refs) return [];
  return indexData.refs[symbolId] || [];
}

/**
 * Analyze potential impact of changes.
 * @param {Array} changes - [{symbolId, oldSig, newSig}]
 * @param {Object} indexData - loaded index data
 * @returns {Array} - impact reports per change
 */
export function analyzeImpact(changes, indexData) {
  if (!changes || !Array.isArray(changes)) return [];
  if (!indexData || !indexData.refs) {
    return changes.map(c => ({ symbolId: c.symbolId, impact: 'unknown', references: [] }));
  }

  return changes.map(change => {
    const { symbolId, oldSig, newSig } = change;
    const references = indexData.refs[symbolId] || [];

    // Determine impact level based on number of references and signature change
    let impact = 'low';
    if (references.length > 10) impact = 'high';
    else if (references.length > 0) impact = 'medium';

    // Check if it's a breaking change
    const isBreaking = oldSig && newSig && oldSig !== newSig;

    return {
      symbolId,
      oldSig,
      newSig,
      impact,
      isBreaking,
      referenceCount: references.length,
      references,
    };
  });
}

/**
 * Get all dependents of a file.
 * @param {string} filepath
 * @param {number} depth - recursion depth (default 1)
 * @param {Object} indexData - loaded index data
 * @returns {Array} - dependent files
 */
export function getDependents(filepath, indexData, depth = 1) {
  if (!indexData || !indexData.fileDeps) return [];
  const direct = indexData.fileDeps[filepath] || [];

  if (depth <= 1) return direct;

  // Recursive lookup for transitive dependencies
  const allDeps = [...direct];
  for (const dep of direct) {
    const transitive = getDependents(dep, depth - 1, indexData);
    for (const t of transitive) {
      if (!allDeps.includes(t)) allDeps.push(t);
    }
  }
  return allDeps;
}

// ---------------------------------------------------------------------------
// Fuzzy Search
// ---------------------------------------------------------------------------

function flattenSymbols(files) {
  const symbols = [];
  for (const [filePath, fileSymbols] of Object.entries(files)) {
    for (const symbol of fileSymbols) {
      symbols.push({
        ...symbol,
        _file: filePath,
        _searchText: [symbol.name, symbol.signature, symbol.docstring, symbol.kind]
          .filter(Boolean)
          .join(' '),
      });
    }
  }
  return symbols;
}

/**
 * Fuzzy search across indexed symbols.
 */
export function searchSymbols(files, query, { threshold = 0.4, limit = 10 } = {}) {
  const allSymbols = flattenSymbols(files);

  const fuse = new Fuse(allSymbols, {
    keys: [
      { name: 'name', weight: 0.5 },
      { name: 'signature', weight: 0.3 },
      { name: 'docstring', weight: 0.2 },
    ],
    threshold,
    includeScore: true,
    ignoreLocation: true,
  });

  return fuse.search(query, { limit }).map((r) => ({
    symbol: {
      name: r.item.name,
      kind: r.item.kind,
      signature: r.item.signature,
      docstring: r.item.docstring,
      location: r.item.location,
      parameters: r.item.parameters,
      returnType: r.item.returnType,
    },
    file: r.item._file,
    score: r.score,
  }));
}

/**
 * Find potential duplicates for a function.
 */
export function findPotentialDuplicates(files, funcName, funcSignature, limit = 5) {
  const results = searchSymbols(
    files,
    `${funcName} ${funcSignature}`,
    { threshold: 0.5, limit }
  );
  return results.filter((r) => r.symbol.name !== funcName);
}

// ---------------------------------------------------------------------------
// Git helpers (exported for use by ReviewCommand)
// ---------------------------------------------------------------------------

export { getCurrentBranch, getBranchHead, getRemoteBranchHead, getChangedFiles };
