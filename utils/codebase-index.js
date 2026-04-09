/**
 * Codebase Index — Build, persist, and search function signatures.
 *
 * Serves as the foundation for duplicate detection in /gtw review.
 * - Per-branch index: ~/.gtw/codebase-index/{owner}/{repo}@{branch}.json
 * - Git-aware incremental updates (commit hash based)
 * - Fuzzy search via Fuse.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync as _exec } from 'child_process';
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
    return _exec('git rev-parse --abbrev-ref HEAD', {
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
    return _exec(`git rev-parse ${branch}`, {
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
  } catch {
    return '';
  }
}

/**
 * Get the commit hash of a remote branch (origin/<branch>).
 * Fetches origin first to ensure we have the latest.
 * @param {string} worktreePath
 * @param {string} branch
 * @returns {string} — empty string if remote branch not found
 */
function getRemoteBranchHead(worktreePath, branch) {
  try {
    // Fetch the specific remote branch
    _exec(`git fetch origin refs/heads/${branch}:refs/remotes/origin/${branch} --depth=1`, {
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
  } catch {
    // fetch failed, try with existing refs
  }

  try {
    return _exec(`git rev-parse origin/${branch}`, {
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
    const output = _exec(`git diff --name-only ${fromRef}..${toRef}`, {
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
  // Replace / with _ (common in branch names)
  // Remove other invalid filename characters
  return branch
    .replace(/\//g, '_')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\.+$/, '')       // no leading/trailing dots
    .replace(/^\.+/, '')
    .replace(/_{2,}/g, '_')    // no consecutive underscores
    .slice(0, 200);            // max length 200 chars
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
// Index build
// ---------------------------------------------------------------------------

function indexFile(fullPath, relativePath) {
  const extractor = getExtractor(fullPath);
  if (!extractor) return null;
  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    return extractor.extractExports(content, relativePath);
  } catch (e) {
    console.error(`[codebase-index] Failed to index ${relativePath}: ${e.message}`);
    return null;
  }
}

/**
 * Build full index for a worktree on a given branch.
 */
export function buildIndex(worktreePath, repo, branch) {
  const startTime = Date.now();
  const lastCommit = getBranchHead(worktreePath, branch);
  const files = collectFiles(worktreePath);

  const indexedFiles = {};
  let totalFunctions = 0;
  let skippedFiles = 0;

  for (const file of files) {
    const symbols = indexFile(file.fullPath, file.path);
    if (symbols && symbols.length > 0) {
      indexedFiles[file.path] = symbols;
      totalFunctions += symbols.length;
    } else {
      skippedFiles++;
    }
  }

  return {
    files: indexedFiles,
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

  // If commit hash changed, find what files changed
  let changedFiles = new Set();
  if (previousCommit && previousCommit !== lastCommit) {
    const changed = getChangedFiles(worktreePath, previousCommit, lastCommit);
    changedFiles = new Set(changed);
    console.log(`[codebase-index] Branch ${branch}: ${changedFiles.size} files changed since ${previousCommit}`);
  }

  const previousFiles = existingIndex?.files || {};
  const indexedFiles = {};
  let totalFunctions = 0;
  let rebuilt = 0;
  let unchanged = 0;

  // If no previous index, do full build
  if (!existingIndex || !previousFiles || Object.keys(previousFiles).length === 0) {
    console.log('[codebase-index] No existing index, doing full build');
    const fullResult = buildIndex(worktreePath, repo, branch);
    return fullResult;
  }

  // Collect all current source files
  const currentFiles = collectFiles(worktreePath);

  for (const file of currentFiles) {
    const needsRebuild = changedFiles.has(file.path) || !previousFiles[file.path];

    if (needsRebuild) {
      const symbols = indexFile(file.fullPath, file.path);
      if (symbols && symbols.length > 0) {
        indexedFiles[file.path] = symbols;
        totalFunctions += symbols.length;
        rebuilt++;
      }
    } else {
      indexedFiles[file.path] = previousFiles[file.path];
      totalFunctions += previousFiles[file.path].length;
      unchanged++;
    }
  }

  return {
    files: indexedFiles,
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
    schemaVersion: '1.0',
    lastCommit: indexData.meta.lastCommit,
    lastUpdated: indexData.meta.lastUpdated,
    stats: indexData.meta.stats,
    files: indexData.files,
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
 * @returns {{ files: Record<string, object[]>, meta: object } | null}
 */
export function loadIndex(repo, branch) {
  const jsonPath = getIndexJsonPath(repo, branch);
  if (!fs.existsSync(jsonPath)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return {
      files: data.files || {},
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
