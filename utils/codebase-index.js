/**
 * Codebase Index — Build, persist, and search function signatures.
 *
 * Serves as the foundation for duplicate detection in /gtw review.
 * - Builds Markdown index from codebase (full or incremental)
 * - Persists to ~/.gtw/codebase-index/{owner}/{repo}.md
 * - Fuzzy search via Fuse.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getExtractor } from './extractors/index.js';
import Fuse from 'fuse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.resolve(__dirname, '../../.gtw');
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
// Path helpers
// ---------------------------------------------------------------------------

function getIndexPath(repo) {
  const [owner, repoName] = repo.split('/');
  const repoDir = path.resolve(INDEX_DIR, owner);
  return path.resolve(repoDir, `${repoName}.md`);
}

function getIndexJsonPath(repo) {
  const [owner, repoName] = repo.split('/');
  const repoDir = path.resolve(INDEX_DIR, owner);
  return path.resolve(repoDir, `${repoName}.json`);
}

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

/**
 * Recursively collect all source files in a directory.
 */
function collectFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      files.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = entry.name.split('.').pop().toLowerCase();
      if (!INCLUDED_EXTS.has(ext)) continue;
      try {
        const stat = fs.statSync(fullPath);
        const relPath = path.relative(dir, fullPath);
        files.push({ path: relPath, fullPath, type: ext, size: stat.size, mtime: stat.mtime });
      } catch {}
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/**
 * Render a single ExportSymbol as a Markdown code block.
 */
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
      md += ` {\n`;
      for (const method of symbol.methods) {
        md += `${indent}  ${method.signature}\n`;
        if (method.docstring) {
          md += `${indent}  /** ${method.docstring} */\n`;
        }
      }
      md += `${indent}}`;
    }
  } else {
    if (symbol.docstring) {
      md += `${indent}/** ${symbol.docstring} */\n`;
    }
    md += `${indent}${symbol.signature}`;
  }

  md += `\n${indent}\`\`\`\n`;

  if (symbol.parameters && symbol.parameters.length > 0) {
    md += `${indent}| Parameters | Type | Description |\n`;
    md += `${indent}|---|---|---|\n`;
    for (const param of symbol.parameters) {
      const optional = param.optional ? ' (optional)' : '';
      md += `${indent}| ${param.name}${optional} | ${param.type || 'unknown'} | ${param.description || ''} |\n`;
    }
    md += '\n';
  }

  if (symbol.returnType) {
    md += `${indent}**Returns:** ${symbol.returnType}\n\n`;
  }

  return md;
}

/**
 * Render a file's symbols as a Markdown section.
 */
function renderFileSection(filePath, symbols) {
  let md = `## ${filePath}\n\n`;

  for (const symbol of symbols) {
    md += renderSymbolAsMarkdown(symbol);
  }

  return md;
}

/**
 * Render the full Markdown index document.
 */
function renderMarkdownIndex(repo, lastUpdated, files) {
  let md = `# Codebase Index: ${repo}\n`;
  md += `Last updated: ${lastUpdated}\n\n`;

  for (const [filePath, symbols] of Object.entries(files)) {
    md += renderFileSection(filePath, symbols);
    md += '\n---\n\n';
  }

  return md;
}

// ---------------------------------------------------------------------------
// Index build
// ---------------------------------------------------------------------------

/**
 * Build index for a single file using the appropriate extractor.
 */
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
 * Build a full index for a worktree.
 * @param {string} worktreePath - Absolute path to the repo worktree
 * @param {string} repo - "owner/repo" string
 * @returns {{ files: Record<string, object[]>, stats: object }}
 */
export function buildIndex(worktreePath, repo) {
  const startTime = Date.now();
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

  const elapsed = Date.now() - startTime;

  return {
    files: indexedFiles,
    stats: {
      totalFiles: files.length,
      indexedFiles: Object.keys(indexedFiles).length,
      skippedFiles,
      totalFunctions,
      elapsedMs: elapsed,
    },
  };
}

/**
 * Incrementally update index for a worktree.
 * Only re-indexes files whose mtime has changed since last build.
 * @param {string} worktreePath
 * @param {string} repo
 * @param {string} indexPath
 * @param {object} existingIndex
 * @returns {{ files: Record<string, object[]>, stats: object }}
 */
export function buildIncrementalIndex(worktreePath, repo, existingIndex) {
  const files = collectFiles(worktreePath);
  const previousFiles = existingIndex?.files || {};
  const previousMeta = existingIndex?.meta || {};

  const indexedFiles = {};
  let totalFunctions = 0;
  let rebuilt = 0;
  let unchanged = 0;
  let skippedFiles = 0;

  for (const file of files) {
    const prevMeta = previousMeta[file.path];
    const needsRebuild = !prevMeta || new Date(file.mtime) > new Date(prevMeta.mtime);

    if (needsRebuild) {
      const symbols = indexFile(file.fullPath, file.path);
      if (symbols && symbols.length > 0) {
        indexedFiles[file.path] = symbols;
        totalFunctions += symbols.length;
        if (prevMeta) rebuilt++;
      } else {
        skippedFiles++;
      }
    } else {
      // Use previous result
      if (previousFiles[file.path]) {
        indexedFiles[file.path] = previousFiles[file.path];
        totalFunctions += previousFiles[file.path].length;
        unchanged++;
      }
    }
  }

  return {
    files: indexedFiles,
    stats: {
      totalFiles: files.length,
      indexedFiles: Object.keys(indexedFiles).length,
      skippedFiles,
      totalFunctions,
      rebuilt,
      unchanged,
      elapsedMs: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Save index to disk (Markdown + structured JSON for search).
 */
export function saveIndex(repo, indexData) {
  const indexPath = getIndexPath(repo);
  const jsonPath = getIndexJsonPath(repo);

  // Ensure directory exists
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });

  const lastUpdated = new Date().toISOString();

  // Save Markdown (human-readable, used for prompt injection)
  const markdown = renderMarkdownIndex(repo, lastUpdated, indexData.files);
  fs.writeFileSync(indexPath, markdown, 'utf8');

  // Save JSON (machine-readable, used for fuzzy search)
  const jsonData = {
    repo,
    schemaVersion: '1.0',
    lastUpdated,
    stats: indexData.stats,
    files: indexData.files, // structured ExportSymbol[] per file
  };
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2), 'utf8');

  console.log(`[codebase-index] Saved to ${indexPath} + ${jsonPath}`);
  return indexPath;
}

/**
 * Load existing index from disk (structured JSON).
 * @returns {{ files: Record<string, object[]>, meta: object } | null}
 */
export function loadIndex(repo) {
  const jsonPath = getIndexJsonPath(repo);

  if (!fs.existsSync(jsonPath)) {
    return null;
  }

  try {
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return {
      files: jsonData.files || {},
      meta: {
        repo: jsonData.repo,
        lastUpdated: jsonData.lastUpdated,
        stats: jsonData.stats,
        files: Object.fromEntries(
          Object.entries(jsonData.files || {}).map(([k, v]) => [
            k,
            { mtime: jsonData.lastUpdated, functionCount: v.length },
          ])
        ),
      },
    };
  } catch (e) {
    console.error(`[codebase-index] Failed to load index: ${e.message}`);
    return null;
  }
}

/**
 * Load index with full Markdown content.
 */
export function loadIndexMarkdown(repo) {
  const indexPath = getIndexPath(repo);
  if (!fs.existsSync(indexPath)) {
    return null;
  }
  return fs.readFileSync(indexPath, 'utf8');
}

// ---------------------------------------------------------------------------
// Fuzzy Search (for duplicate detection)
// ---------------------------------------------------------------------------

/**
 * Flatten indexed symbols for Fuse.js search.
 * @param {Record<string, object[]>} files
 */
function flattenSymbols(files) {
  const symbols = [];
  for (const [filePath, fileSymbols] of Object.entries(files)) {
    for (const symbol of fileSymbols) {
      symbols.push({
        ...symbol,
        _file: filePath,
        // Build searchable text
        _searchText: [
          symbol.name,
          symbol.signature,
          symbol.docstring,
          symbol.kind,
        ]
          .filter(Boolean)
          .join(' '),
      });
    }
  }
  return symbols;
}

/**
 * Fuzzy search symbols for potential duplicates.
 * @param {Record<string, object[]>} files - Indexed files
 * @param {string} query - Function name or description to search
 * @param {{ threshold?: number, limit?: number }} options
 * @returns {object[]}
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

  const results = fuse.search(query, { limit });

  return results.map((r) => ({
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
 * Search for duplicates of a specific function.
 * @param {Record<string, object[]>} files
 * @param {string} funcName
 * @param {string} funcSignature
 * @param {number} limit
 */
export function findPotentialDuplicates(files, funcName, funcSignature, limit = 5) {
  const results = searchSymbols(files, `${funcName} ${funcSignature}`, { threshold: 0.5, limit });
  return results.filter((r) => r.symbol.name !== funcName); // exclude exact name match
}

// ---------------------------------------------------------------------------
// Index management
// ---------------------------------------------------------------------------

/**
 * Full rebuild of index.
 * @param {string} worktreePath
 * @param {string} repo
 */
export function rebuildIndex(worktreePath, repo) {
  const indexData = buildIndex(worktreePath, repo);
  return saveIndex(repo, indexData);
}

/**
 * Incremental update of index.
 * @param {string} worktreePath
 * @param {string} repo
 */
export function updateIndex(worktreePath, repo) {
  const existingIndex = loadIndex(repo);
  const indexData = buildIncrementalIndex(worktreePath, repo, existingIndex);
  return saveIndex(repo, indexData);
}

/**
 * Get or build index for a repo.
 * @param {string} worktreePath
 * @param {string} repo
 * @param {{ force?: boolean }} options
 */
export function getOrBuildIndex(worktreePath, repo, { force = false } = {}) {
  if (force) {
    return rebuildIndex(worktreePath, repo);
  }

  const existing = loadIndex(repo);
  if (existing) {
    return updateIndex(worktreePath, repo);
  }

  return rebuildIndex(worktreePath, repo);
}

/**
 * Check if index exists for a repo.
 */
export function indexExists(repo) {
  return fs.existsSync(getIndexPath(repo));
}

/**
 * Remove index for a repo.
 */
export function removeIndex(repo) {
  const indexPath = getIndexPath(repo);
  const metaPath = getIndexMetaPath(repo);

  try {
    if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    return true;
  } catch (e) {
    console.error(`[codebase-index] Failed to remove index: ${e.message}`);
    return false;
  }
}
