import { Commander } from './Commander.js';
import { getWip, saveWip } from '../utils/wip.js';
import { getConfig } from '../utils/config.js';
import { getValidToken } from '../utils/api.js';
import { GitHubClient } from '../utils/github.js';
import { setPrLabel } from '../utils/labels.js';
import { resolveModel, callAI } from '../utils/ai.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CHECKLIST_ITEMS = ['Destructive', 'Out-of-scope'];
const DEFAULT_MAX_ROUNDS = 5;
const MAX_ITEMS_PER_ROUND = 10;
const SCAN_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// LLM Prompt Templates
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert code reviewer. Your primary duty is SCOPE CONTAINMENT — verify that the PR changes only address the linked issue and nothing more. Unplanned or out-of-scope changes must be flagged.

Review the PR against the following dimensions (in priority order):
1. **Scope Containment** (HIGHEST PRIORITY) — Does the PR only address the linked issue? Are there unrelated changes?
2. **Correctness** — Are there logical bugs, off-by-one errors, or incorrect implementations?
3. **Security** — Are there injection risks, exposed secrets, or improper input validation?
4. **Performance** — Are there N+1 queries, missing indexes, or inefficient algorithms?
5. **Architecture** — Is the code structure appropriate for the codebase? Are SOLID principles followed?
6. **Testing** — Is there adequate test coverage? Are edge cases handled?
7. **Error Handling** — Are errors caught and handled gracefully? Are fallbacks provided?
8. **Breaking Changes** — Does this PR introduce breaking changes to APIs, data schemas, or CLI interfaces?
9. **Concurrency** — Race conditions, shared resource locks, idempotency, thread safety
10. **Resource Cleanup** — Timers, memory, connections, event listeners
11. **Duplicate Detection** — Is new code duplicating existing functionality?

Output ONLY valid JSON matching this schema:
{
  "summary": "string (brief summary of review findings)",
  "verdict": "approve" | "request_changes",
  "items": [
    {
      "id": "string (stable deterministic hash of file+location+title, e.g. 'r1', 'r2')",
      "category": "scope|correctness|security|performance|architecture|testing|error_handling|breaking_change|concurrency|duplicate",
      "severity": "critical|high|medium|low",
      "file": "string (filename, empty if general)",
      "location": "string (function name, line range, or empty)",
      "title": "string (short title for the issue)",
      "body": "string (detailed description of the issue)",
      "resolved": false
    }
  ]
}

IMPORTANT:
- Output ONLY the JSON object, no markdown fences, no additional text.
- resolved is always false in the LLM output (resolved marking is done by comparing previous items).
- Limit to top ${MAX_ITEMS_PER_ROUND} highest-severity items.
- For ID, use a short stable identifier like "r1", "r2" (sequential, not hash) — the reviewer will stabilize across rounds.
- Categories must be one of: scope, correctness, security, performance, architecture, testing, error_handling, breaking_change, concurrency, duplicate
- severity must be one of: critical, high, medium, low`;

// ---------------------------------------------------------------------------
// Worktree Management
// ---------------------------------------------------------------------------

/**
 * Create a git worktree for the PR branch.
 * Returns worktree path on success, throws on failure.
 * Worktree name format: gtw-review-{prNum}
 */
/**
/**
 * Prepare a git worktree for reviewing a PR branch.
 * Path: {workdir}/../gtw-reviews/{branchName}/
 * If the worktree exists, git pull to update. Otherwise create it.
 * @param {string} workdir - Absolute path to the git repository (e.g. /home/devin/code/plugins/gtw)
 * @param {string} prNum - PR number
 * @param {string} branchName - The PR's actual branch name (pr.head.ref)
 * @returns {Promise<string>} - Absolute path to the worktree directory
 */
async function prepareReviewWorktree(workdir, prNum, branchName) {
  const worktreeRoot = path.resolve(workdir, '..', 'gtw-reviews');
  const worktreePath = path.resolve(worktreeRoot, branchName);

  // Ensure parent directory exists
  if (!fs.existsSync(worktreeRoot)) fs.mkdirSync(worktreeRoot, { recursive: true });

  if (fs.existsSync(worktreePath)) {
    // Worktree exists — git pull to get latest changes
    try {
      execSync(`git fetch origin refs/pull/${prNum}/head:${branchName}`, { cwd: worktreePath, stdio: 'pipe' });
      execSync(`git reset --hard FETCH_HEAD`, { cwd: worktreePath, stdio: 'pipe' });
    } catch {
      // Pull failed — remove and recreate next time
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  if (!fs.existsSync(worktreePath)) {
    // Ensure the branch ref exists locally (fetch from GitHub PR ref)
    try {
      execSync(`git fetch origin refs/pull/${prNum}/head:${branchName}`, { cwd: workdir, stdio: 'pipe' });
    } catch {}
    // Create worktree at the path using the branch name
    execSync(`git worktree add "${worktreePath}" "${branchName}"`, { cwd: workdir, stdio: 'pipe' });
  }

  return worktreePath;
}

/**
 * Remove a review worktree directory. Silently ignores errors.
 * Note: does NOT clean up git worktree registry — caller should run git worktree prune.
 */
function removeReviewWorktreeDir(worktreePath) {
  if (!worktreePath || !fs.existsSync(worktreePath)) return;
  try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// Codebase Scanning
// ---------------------------------------------------------------------------

const INCLUDED_EXTS = new Set([
  'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs',
  'go', 'py', 'java', 'rb', 'rs', 'cs', 'cpp', 'c', 'h', 'hpp',
  'md', 'json', 'yaml', 'yml', 'toml', 'sh', 'bash',
]);

const EXCLUDED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', 'coverage',
  '.next', '.nuxt', 'vendor', '__pycache__', '.pytest_cache',
  'target', 'bin', 'obj', '.cache', '.tmp',
]);

/**
 * Extract imports from a file content string based on file extension.
 */
function extractImports(filePath, content) {
  const ext = filePath.split('.').pop().toLowerCase();
  const imports = [];

  if (['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs'].includes(ext)) {
    // ES modules: import X from '...'
    for (const m of content.matchAll(/import\s+(?:{[^}]+}|\w+|\* as \w+)\s+from\s+['"]([^'"]+)['"]/g)) {
      imports.push(m[1]);
    }
    // CommonJS: require('...')
    for (const m of content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      imports.push(m[1]);
    }
    // Dynamic import: import('...')
    for (const m of content.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      imports.push(m[1]);
    }
  } else if (ext === 'go') {
    // Go imports
    for (const m of content.matchAll(/import\s+(?:\(\s*)?(?:[^)]+)\s+"?([^"\n]+)"?/g)) {
      imports.push(m[1]);
    }
    // Simple Go import detection
    const goImportBlock = content.match(/import\s+\(([\s\S]*?)\)/);
    if (goImportBlock) {
      for (const m of goImportBlock[1].matchAll(/"([^"]+)"/g)) {
        imports.push(m[1]);
      }
    }
  } else if (ext === 'py') {
    // Python imports
    for (const m of content.matchAll(/^(?:from\s+([^\s]+)\s+)?import\s+([^\s]+)/gm)) {
      imports.push(m[1] ? `${m[1]}.${m[2]}` : m[2]);
    }
  } else if (ext === 'java') {
    for (const m of content.matchAll(/import\s+([\w.]+)/g)) {
      imports.push(m[1]);
    }
  } else if (ext === 'rb') {
    for (const m of content.matchAll(/require\s+['"]([^'"]+)['"]/g)) {
      imports.push(m[1]);
    }
    for (const m of content.matchAll(/require_relative\s+['"]([^'"]+)['"]/g)) {
      imports.push(m[1]);
    }
  }

  return [...new Set(imports)];
}

/**
 * Extract exports from a file content.
 * Returns array of exported names (functions, classes, constants).
 */
function extractExports(filePath, content) {
  const ext = filePath.split('.').pop().toLowerCase();
  const exports = [];

  if (['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs'].includes(ext)) {
    // ES module exports: export default X, export const X, export function X
    for (const m of content.matchAll(/export\s+(?:default\s+)?(?:const|let|var|function|class|async\s+function)\s+(\w+)/g)) {
      exports.push(m[1]);
    }
    for (const m of content.matchAll(/export\s+default\s+(\w+)/g)) {
      exports.push(m[1]);
    }
    // Named exports: export { X }
    for (const m of content.matchAll(/export\s+{\s*([^}]+)\s*}/g)) {
      for (const name of m[1].split(',')) {
        const n = name.trim().split(' as ').pop().trim();
        if (n) exports.push(n);
      }
    }
    // CommonJS: module.exports = X
    for (const m of content.matchAll(/module\.exports\s*[=:]\s*(?:(\w+)|\{([^}]+)\})/g)) {
      if (m[1]) exports.push(m[1]);
      if (m[2]) {
        for (const name of m[2].split(',')) {
          const n = name.trim().split(' as ').pop().trim();
          if (n) exports.push(n);
        }
      }
    }
  } else if (ext === 'go') {
    // Go exports: func (T) Name or func Name
    for (const m of content.matchAll(/^func\s+(?:\([^)]+\)\s+)?([A-Z]\w*)/gm)) {
      exports.push(m[1]);
    }
  } else if (ext === 'py') {
    // Python: def X or class X at module level
    for (const m of content.matchAll(/^def\s+(\w+)/gm)) {
      exports.push(m[1]);
    }
    for (const m of content.matchAll(/^class\s+(\w+)/gm)) {
      exports.push(m[1]);
    }
  } else if (ext === 'java') {
    for (const m of content.matchAll(/(?:public|protected)\s+(?:static\s+)?(?:final\s+)?(?:class|interface|enum)\s+(\w+)/g)) {
      exports.push(m[1]);
    }
  }

  return [...new Set(exports)];
}

/**
 * Recursively collect all source files in a directory.
 */
function collectFiles(dir, baseDir = dir) {
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
      files.push(...collectFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      const ext = entry.name.split('.').pop().toLowerCase();
      if (!INCLUDED_EXTS.has(ext)) continue;
      try {
        const stat = fs.statSync(fullPath);
        const relPath = path.relative(baseDir, fullPath);
        files.push({ path: relPath, fullPath, type: ext, size: stat.size });
      } catch {}
    }
  }
  return files;
}

/**
 * Scan entire codebase in worktree and build review context.
 * Returns:
 * {
 *   allFiles: [{path, content, type, size}],
 *   imports: {file: [importedModules]},
 *   exports: {file: [exportedNames]},
 *   duplicateModules: [{name, files: [paths]}],
 *   dependencyGraph: {file: {imports: [], importedBy: []}}
 * }
 */
async function scanCodebase(worktreePath, changedFiles) {
  const timeout = SCAN_TIMEOUT_MS;
  const startTime = Date.now();

  // Collect all source files
  const allFiles = collectFiles(worktreePath);

  const imports = {};
  const exports = {};
  const exportMap = {}; // name -> [files]

  for (const f of allFiles) {
    if (Date.now() - startTime > timeout) break;
    try {
      const content = fs.readFileSync(f.fullPath, 'utf8');
      f.content = content;

      const fileImports = extractImports(f.path, content);
      imports[f.path] = fileImports;

      const fileExports = extractExports(f.path, content);
      exports[f.path] = fileExports;

      // Build export map for duplicate detection
      for (const name of fileExports) {
        if (!exportMap[name]) exportMap[name] = [];
        exportMap[name].push(f.path);
      }
    } catch {}
  }

  // Find duplicate modules
  const duplicateModules = Object.entries(exportMap)
    .filter(([, files]) => files.length > 1)
    .map(([name, files]) => ({ name, files }));

  // Build dependency graph
  const dependencyGraph = {};
  for (const f of allFiles) {
    if (!dependencyGraph[f.path]) {
      dependencyGraph[f.path] = { imports: imports[f.path] || [], importedBy: [] };
    } else {
      dependencyGraph[f.path].imports = imports[f.path] || [];
    }
  }

  // Build reverse dependency map
  for (const [file, fileImports] of Object.entries(imports)) {
    for (const imp of fileImports) {
      // Try to resolve import to a file path
      const normalizedImp = imp.replace(/^\.\/+/, '').replace(/^\.\.\/+/, '');
      for (const f of allFiles) {
        const matches = f.path === normalizedImp ||
                        f.path.endsWith(normalizedImp + '.' + f.type) ||
                        f.path.endsWith('/' + normalizedImp) ||
                        f.path === normalizedImp + '.' + f.type;
        if (matches) {
          if (!dependencyGraph[f.path]) {
            dependencyGraph[f.path] = { imports: [], importedBy: [] };
          }
          if (!dependencyGraph[f.path].importedBy.includes(file)) {
            dependencyGraph[f.path].importedBy.push(file);
          }
          break;
        }
      }
    }
  }

  return {
    allFiles,
    imports,
    exports,
    duplicateModules,
    dependencyGraph,
  };
}

/**
 * Build enhanced user prompt with full codebase context.
 */
function buildEnhancedUserPrompt({
  linkedIssues,
  changedFilesFullContent,
  baseBranch,
  previousItems,
  allFilesIndex,
  duplicateModules,
  dependencyAnalysis,
}) {
  // Primary linked issue (first one found)
  const primary = linkedIssues && linkedIssues.length > 0 ? linkedIssues[0] : { title: '', body: '', number: null };
  const extra = linkedIssues && linkedIssues.length > 1 ? linkedIssues.slice(1) : [];

  let issueSection = `## Linked Issue\n`;
  issueSection += `Title: ${primary.title || '(no title)'}\n`;
  issueSection += `Body: ${primary.body || '(no description)'}\n`;
  issueSection += `Number: #${primary.number || 'unknown'}\n`;
  if (extra.length > 0) {
    issueSection += `\n## Additional Linked Issues\n`;
    for (const e of extra) {
      issueSection += `- #${e.number}: ${e.title}\n`;
    }
  }

  let prompt = issueSection + `\n## Base Branch\n${baseBranch}\n\n## Changed Files — Full Content\n`;

  for (const file of changedFilesFullContent) {
    prompt += `\n### FILE: ${file.path}\n\`\`\`\n${file.content}\n\`\`\`\n`;
  }

  if (duplicateModules && duplicateModules.length > 0) {
    prompt += `\n## Potential Duplicate Modules Detected\n`;
    for (const dup of duplicateModules) {
      prompt += `- **${dup.name}** appears in: ${dup.files.join(', ')}\n`;
    }
    prompt += `\n`;
  }

  if (dependencyAnalysis) {
    prompt += `\n## Dependency Impact Analysis\n`;
    for (const [file, deps] of Object.entries(dependencyAnalysis)) {
      if (deps.importedBy && deps.importedBy.length > 0) {
        prompt += `- **${file}** is imported by: ${deps.importedBy.join(', ')}\n`;
      }
    }
    prompt += `\n`;
  }

  // Full codebase file index (just filenames + size, not full content — too large)
  if (allFilesIndex && allFilesIndex.length > 0) {
    prompt += `\n## Full Codebase File Index (${allFilesIndex.length} files)\n`;
    for (const f of allFilesIndex) {
      prompt += `- ${f.path} (${f.type}, ${f.size}b)\n`;
    }
    prompt += `\n`;
  }

  if (previousItems && previousItems.length > 0) {
    prompt += `\n## Previous Review Items\n`;
    for (const item of previousItems) {
      prompt += `- [${item.id}] [${item.severity}] [${item.category}] ${item.file ? `${item.file}@${item.location || 'N/A'}` : 'General'}: ${item.title}\n  ${item.body}\n`;
    }
  }

  return prompt;
}

// ---------------------------------------------------------------------------
// Legacy prompt builder (deprecated, kept for backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Build the user prompt for LLM review (legacy diff-only version).
 * @deprecated Use buildEnhancedUserPrompt instead
 */
function buildUserPrompt({ linkedIssue, diff, baseBranch, previousItems }) {
  let prompt = `## Linked Issue
Title: ${linkedIssue.title || '(no title)'}\nBody: ${linkedIssue.body || '(no description)'}
Number: #${linkedIssue.number || 'unknown'}\n\n## Base Branch\n${baseBranch}\n\n## PR Changes (diff summary)\n`;

  for (const file of diff) {
    prompt += `\n### ${file.filename} (+${file.additions} -${file.deletions})\n`;
    if (file.patch) {
      prompt += `${file.patch}\n`;
    }
  }

  if (previousItems && previousItems.length > 0) {
    prompt += `\n## Previous Review Items (from prior rounds)
The following items were flagged in previous reviews. If they have been addressed in the current diff, mark them resolved in your analysis.
`;
    for (const item of previousItems) {
      prompt += `- [${item.id}] [${item.severity}] [${item.category}] ${item.file ? `${item.file}@${item.location || 'N/A'}` : 'General'}: ${item.title}\n  ${item.body}\n`;
    }
  } else {
    prompt += `\n## Previous Review Items\nNone (this is the first review round).\n`;
  }

  return prompt;
}

/**
 * Render the review comment for human readers.
 */
function renderReviewComment({ round, summary, verdict, items, previousRoundItems, linkedIssues, repo, prNum }) {
  const maxRounds = getConfig().maxReviewRounds || DEFAULT_MAX_ROUNDS;
  const verdictIcon = verdict === 'approve' ? '✅' : '⚠️';
  const verdictText = verdict === 'approve' ? 'Approved' : 'Changes Needed';

  let comment = `## Review [Round ${round}/${maxRounds}] ${verdictIcon} ${verdictText}\n\n`;
  comment += `**Linked Issues:** ${(linkedIssues || []).map(i => `#${i.number}: ${i.title || 'none'}`).join('\n- ')}\n\n`;
  comment += `### Summary\n${summary}\n\n`;

  if (items.length > 0) {
    comment += `### Review Items (${items.length})\n\n`;
    comment += `| # | Severity | Category | Location | Title |\n`;
    comment += `|---|----------|----------|----------|-------|\n`;
    for (const item of items) {
      const resolvedPrefix = item.resolved ? '✅ ' : '';
      const location = item.file ? `${item.file}${item.location ? ` @ ${item.location}` : ''}` : '—';
      comment += `| ${item.id} | ${item.severity} | ${item.category} | ${location} | ${resolvedPrefix}${item.title} |\n`;
    }
    comment += `\n`;
    for (const item of items) {
      comment += `#### ${item.id}: ${item.title} \n`;
      comment += `**Severity:** ${item.severity} | **Category:** ${item.category}\n`;
      if (item.file) comment += `**File:** ${item.file}`;
      if (item.location) comment += ` @ ${item.location}`;
      comment += `\n\n`;
      if (item.resolved) {
        comment += `✅ *[Resolved in this commit]*\n\n`;
      }
      comment += `${item.body}\n\n`;
    }
  }

  if (previousRoundItems && previousRoundItems.length > 0) {
    const stillUnresolved = items.filter(i => !i.resolved);
    if (stillUnresolved.length > 0) {
      comment += `---\n*Previous rounds: ${previousRoundItems.length} item(s) flagged, ${items.filter(i => i.resolved).length} resolved in current diff.*\n`;
    }
  }

  comment += `\n---\n*Review generated by AI. JSON data:\n\`\`\`json\n${JSON.stringify({ summary, verdict, items }, null, 2)}\n\`\`\`*`;

  return comment;
}

/**
 * Generate a stable item ID based on file+location+title.
 */
function stableItemId(file, location, title) {
  const raw = `${file || ''}:${location || ''}:${title || ''}`;
  return crypto.createHash('sha1').update(raw).digest('hex').substring(0, 8);
}

// ---------------------------------------------------------------------------
// GitHub Data Fetching
// ---------------------------------------------------------------------------

/**
 * Find all linked issues for a PR using multiple strategies:
 * 1. Regex match "Closes/Fixes/Resolves #N" from PR body
 * 2. GitHub search: issues mentioning PR number in body or title
 * 3. GitHub timeline: cross-reference events to/from the PR
 * Returns array of { number, title, body }.
 */
/**
 * Find all linked issues for a PR via GitHub GraphQL API.
 * Uses pullRequest.closingIssuesReferences — the canonical "Development" panel linkage.
 * Falls back to REST regex parsing of PR body if GraphQL is unavailable.
 */
async function findLinkedIssues(prNum, prBody, client, repo) {
  const [owner, repoName] = repo.split('/');

  // Primary: GraphQL — this is the official "linked issues" from GitHub Development panel
  try {
    const gqlQuery = `query GetLinkedIssues($owner: String!, $repo: String!, $prNum: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNum) {
          closingIssuesReferences(first: 20) {
            nodes { number title body }
          }
        }
      }
    }`;
    const data = await client.graphql(gqlQuery, { owner, repo: repoName, prNum });
    const nodes = data?.repository?.pullRequest?.closingIssuesReferences?.nodes || [];
    if (nodes.length > 0) {
      console.log(`[ReviewCommand] Found ${nodes.length} linked issue(s) via GraphQL`);
      return nodes.map(n => ({
        number: n.number,
        title: n.title || '',
        body: n.body || '',
        source: 'github-development-link',
      }));
    }
  } catch (e) {
    console.error(`[ReviewCommand] GraphQL linked issues failed (${e.message}), falling back to body regex`);
  }

  // Fallback: REST body regex for "Closes #N / Fixes: #N"
  const issuesMap = new Map();
  const bodyMatches = prBody?.matchAll(/(?:closes?|fixes?|resolves?)\s*:?\s*#(\d+)/gi) || [];
  for (const match of bodyMatches) {
    const num = parseInt(match[1]);
    if (!issuesMap.has(num)) issuesMap.set(num, { source: 'body-keyword' });
  }

  const linkedIssues = [];
  for (const [num, meta] of issuesMap) {
    try {
      const issue = await client.request('GET', `/repos/${repo}/issues/${num}`);
      if (issue.pull_request) continue;
      linkedIssues.push({ number: issue.number, title: issue.title || '', body: issue.body || '', source: meta.source });
    } catch (e) { /* skip */ }
  }
  return linkedIssues;
}

/**
 * Fetch PR details including diff summary and linked issues.
 */
export async function fetchPrDetails(prNum, client, repo) {
  const [pr, files] = await Promise.all([
    client.request('GET', `/repos/${repo}/pulls/${prNum}`),
    client.request('GET', `/repos/${repo}/pulls/${prNum}/files?per_page=100`),
  ]);

  const linkedIssues = await findLinkedIssues(prNum, pr.body, client, repo);

  // Get base branch
  const baseBranch = pr.base?.ref || 'main';

  return {
    pr: {
      number: pr.number,
      title: pr.title,
      body: pr.body || '',
      url: pr.html_url,
      user: pr.user?.login,
      updatedAt: pr.updated_at,
      state: pr.state,
      labels: pr.labels || [],
      cloneUrl: pr.clone_url || `https://github.com/${repo}.git`,
      headRef: pr.head?.ref || '', // actual branch name of the PR
    },
    files: files.map((f) => ({
      filename: f.filename,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch || '',
    })),
    linkedIssues,
    baseBranch,
  };
}

/**
 * Find existing review comment by this agent on a PR.
 * Returns the comment object or null.
 */
export async function findReviewComment(prNum, client, repo, myLogin) {
  const comments = await client.request('GET', `/repos/${repo}/issues/${prNum}/comments`);
  return (
    comments.find(
      (c) =>
        c.user?.login === myLogin && c.body?.includes('## Review [Round'),
    ) || null
  );
}

/**
 * Delete a comment by ID. Silently ignores 404s.
 */
async function deleteComment(commentId, prNum, repo, client) {
  try {
    await client.request('DELETE', `/repos/${repo}/issues/comments/${commentId}`);
  } catch (e) {
    if (!e.message.includes('404')) {
      console.error(`[ReviewCommand] Failed to delete comment ${commentId}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// LLM Interaction
// ---------------------------------------------------------------------------

/**
 * Call LLM with retry on JSON parse failure.
 */
async function callReviewLLM(prompt, sessionKey) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { model } = await resolveModel(sessionKey);
      const response = await callAI(model, SYSTEM_PROMPT, prompt, 'main');
      const trimmed = response.trim();
      // Strip markdown fences if present
      const jsonStr = trimmed.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
      const parsed = JSON.parse(jsonStr);
      // Validate schema
      if (typeof parsed.summary !== 'string' ||
          !['approve', 'request_changes'].includes(parsed.verdict) ||
          !Array.isArray(parsed.items)) {
        throw new Error('Invalid schema from LLM');
      }
      return parsed;
    } catch (e) {
      lastError = e;
      console.error(`[ReviewCommand] LLM attempt ${attempt} failed: ${e.message}`);
    }
  }
  throw new Error(`LLM failed after 2 attempts: ${lastError.message}`);
}

// ---------------------------------------------------------------------------
// Item State Management
// ---------------------------------------------------------------------------

/**
 * Compare previous items against current diff to determine resolved items.
 * An item is resolved if its described issue is no longer present in the diff.
 * This is a simple heuristic: if the file that had an issue no longer has the
 * problematic pattern in its patch, we consider it resolved.
 *
 * Returns items with resolved=true/false set appropriately.
 */
function mergeItemState(previousItems, currentItems) {
  if (!previousItems || previousItems.length === 0) {
    return currentItems.map(item => ({ ...item, resolved: false }));
  }

  const resolvedIds = new Set();

  // Mark items as resolved if they're no longer present in current items
  for (const prev of previousItems) {
    const stillPresent = currentItems.find(
      (curr) => curr.file === prev.file &&
               curr.title === prev.title &&
               curr.location === prev.location
    );
    if (!stillPresent) {
      resolvedIds.add(prev.id);
    }
  }

  // Also check if a previous item's exact id is in current items (same logical issue)
  // If it is, carry over the ID and mark as unresolved
  const result = [];
  for (const curr of currentItems) {
    const prevMatch = previousItems.find(
      (p) => p.file === curr.file &&
            p.title === curr.title &&
            (p.location === curr.location || (!p.location && !curr.location))
    );
    result.push({
      ...curr,
      id: prevMatch ? prevMatch.id : curr.id,
      resolved: false,
    });
  }

  // Add previous items that are now resolved but weren't in currentItems
  // (they've been addressed in the code)
  for (const prev of previousItems) {
    if (resolvedIds.has(prev.id)) {
      result.push({
        ...prev,
        resolved: true,
        body: `✅ [Resolved in this commit] ${prev.body}`,
      });
    }
  }

  return result;
}

/**
 * Parse JSON from previous review comment to extract items.
 */
function parseItemsFromComment(body) {
  try {
    const match = body.match(/```json\n([\s\S]*?)\n```/);
    if (match) {
      const parsed = JSON.parse(match[1]);
      return Array.isArray(parsed.items) ? parsed.items : [];
    }
  } catch {}
  return [];
}

// ---------------------------------------------------------------------------
// ReviewCommand
// ---------------------------------------------------------------------------

export class ReviewCommand extends Commander {
  constructor(context) {
    super(context);
    this.sessionKey = context.sessionKey;
  }

  /**
   * /gtw review           — claim earliest gtw/ready PR from watch list
   * /gtw review <pr>    — review specific PR in current repo (from wip.json)
   */
  async execute(args) {
    const token = await getValidToken();
    const client = new GitHubClient(token);
    const wip = getWip();
    const config = getConfig();
    const maxRounds = config.maxReviewRounds || DEFAULT_MAX_ROUNDS;

    // Parse optional PR number argument
    let targetPrNum = null;
    for (const a of args) {
      const m = String(a).match(/^(\d+)$/);
      if (m) {
        targetPrNum = parseInt(m[1]);
        break;
      }
    }

    const myLogin = (await client.request('GET', '/user')).login;

    // Determine target repo and PR
    if (targetPrNum) {
      // /gtw review <pr> — use repo from wip.json
      const repo = wip.repo;
      if (!repo) {
        return { ok: false, message: '⚠️ No repo set. Run /gtw on <workdir> first' };
      }
      return this._reviewSpecificPr(targetPrNum, repo, client, myLogin, wip, maxRounds);
    } else {
      // /gtw review — scan watch list for gtw/ready PRs
      return this._reviewNextFromWatchList(client, myLogin, wip, maxRounds);
    }
  }

  /**
   * Scan watch list and claim the earliest gtw/ready PR.
   */
  async _reviewNextFromWatchList(client, myLogin, wip, maxRounds) {
    const config = getConfig();
    const watchList = config.watchList || [];

    if (watchList.length === 0) {
      return {
        ok: true,
        message: '🔍 Watch list is empty. Add repos with /gtw watch add <owner>/<repo>',
        display: '🔍 Watch list is empty.\n\nAdd repos to watch:\n  /gtw watch add <owner>/<repo>',
      };
    }

    // Find all gtw/ready PRs across watched repos
    const candidatePrs = [];
    for (const repo of watchList) {
      try {
        const params = new URLSearchParams({ state: 'open', per_page: 100, sort: 'updated', direction: 'asc' });
        const prs = await client.request('GET', `/repos/${repo}/pulls?${params}`);

        for (const pr of prs) {
          if (pr.user?.login === myLogin) continue; // skip own PRs
          // Check if PR has gtw/ready label
          const labels = pr.labels || [];
          if (labels.some((l) => l.name === 'gtw/ready')) {
            candidatePrs.push({
              repo,
              pr: {
                number: pr.number,
                title: pr.title,
                url: pr.html_url,
                user: pr.user?.login,
                updatedAt: pr.updated_at,
              },
            });
          }
        }
      } catch (e) {
        // Skip repos we don't have access to
        console.error(`[ReviewCommand] Failed to fetch PRs from ${repo}: ${e.message}`);
      }
    }

    if (candidatePrs.length === 0) {
      return {
        ok: true,
        message: '🔍 No PRs with gtw/ready label found in watched repos',
        display: `🔍 No gtw/ready PRs found\n\nWatched repos: ${watchList.join(', ') || '(none)'}\n\nNo PRs labeled gtw/ready are awaiting review.`,
      };
    }

    // Sort by updated_at ascending (oldest first)
    candidatePrs.sort((a, b) => new Date(a.pr.updatedAt) - new Date(b.pr.updatedAt));

    // Pick the earliest
    const chosen = candidatePrs[0];
    return this._claimAndReviewPr(chosen.repo, chosen.pr.number, client, myLogin, wip, maxRounds);
  }

  /**
   * Review a specific PR by number in a given repo.
   */
  async _reviewSpecificPr(prNum, repo, client, myLogin, wip, maxRounds) {
    // Verify PR exists
    let prData;
    try {
      prData = await fetchPrDetails(prNum, client, repo);
    } catch (e) {
      if (e.message.includes('404')) {
        return { ok: false, message: `⚠️ PR #${prNum} not found in ${repo}` };
      }
      throw e;
    }

    return this._claimAndReviewPr(repo, prNum, client, myLogin, wip, maxRounds, prData);
  }

  /**
   * Core logic: claim PR (set gtw/wip), call LLM, update review comment, track round.
   * Enhanced to use git worktree + full codebase scanning.
   */
  async _claimAndReviewPr(repo, prNum, client, myLogin, wip, maxRounds, prData = null) {
    // Fetch fresh PR data if not provided
    if (!prData) {
      prData = await fetchPrDetails(prNum, client, repo);
    }

    // Check if already stuck — do not re-review
    const labels = prData.pr.labels || [];
    if (labels.some((l) => l.name === 'gtw/stuck')) {
      return {
        ok: true,
        message: `⏸ PR #${prNum} is stuck (exceeded max review rounds). Manual intervention required.`,
        display: `⏸ PR #${prNum} is stuck\n\n${prData.pr.title}\n\nExceeded ${maxRounds} review rounds without resolution.\n\nPlease review manually and set gtw/lgtm or gtw/revise as appropriate.`,
      };
    }

    // Check for linked issue (required per spec)
    if (!prData.linkedIssues || prData.linkedIssues.length === 0) {
      return {
        ok: false,
        message: `⚠️ PR #${prNum} has no linked issue (Linked issue must use keywords like Fixes: #N or Closes #N in the PR body). Linked issue is required for LLM-driven review.`,
        display: `⚠️ No linked issue found\n\nPR #${prNum} must have a linked issue (e.g., "Closes #123") in its body to be reviewed.\n\nAdd a linked issue to the PR body and try again.`,
      };
    }

    // Read current review state for this PR from wip
    const thisPrKey = `${repo}#${prNum}`;
    const existingReviewState = wip.reviewState?.[thisPrKey] || {};
    const previousCommentId = existingReviewState.commentId || null;
    const previousItems = existingReviewState.items || [];

    // Find existing review comment
    const existingComment = await findReviewComment(prNum, client, repo, myLogin);

    let round = 1;
    if (existingComment) {
      // Parse round from title "## Review [Round N]" or new format "## ⚠️ Changes Needed — Round N"
      const roundMatch = existingComment.body.match(/Round\s+(\d+)/i);
      round = roundMatch ? parseInt(roundMatch[1]) + 1 : 2;
    } else if (previousCommentId) {
      // We have a commentId in wip but no comment found — new round 1
      round = 1;
    }

    // Check if max rounds exceeded
    if (round > maxRounds) {
      try {
        await setPrLabel({ prNum, repo, client, isPR: true }, 'gtw/stuck');
      } catch (e) {
        return { ok: false, message: `⚠️ ${e.message}` };
      }

      // Clear review state
      const updatedWip = clearReviewState(wip, thisPrKey);
      saveWip(updatedWip);

      return {
        ok: true,
        stuck: true,
        repo,
        pr: prData.pr,
        round,
        maxRounds,
        message: `⚠️ PR #${prNum} is stuck — max rounds (${maxRounds}) exceeded`,
        display: `⚠️ PR #${prNum} stuck — max rounds exceeded\n\n${prData.pr.title}\n\nRound ${round} reached maximum of ${maxRounds}.\n\nManual intervention required.`,
      };
    }

    // Atomically claim the PR: remove other gtw labels, set gtw/wip.
    let preempted = false;
    try {
      const result = await setPrLabel({ prNum, repo, client, isPR: true }, 'gtw/wip');
      preempted = result.preempted;
    } catch (e) {
      return { ok: false, message: `⚠️ ${e.message}` };
    }
    if (preempted) {
      return {
        ok: false,
        message: `⚠️ PR #${prNum} was claimed by another runner (preemption detected). Aborting.`,
      };
    }

    // NEW: Create worktree for PR branch
    let worktreePath = null;
    try {
      worktreePath = await prepareReviewWorktree(wip.workdir, prNum, prData.pr.headRef);
    } catch (e) {
      // Rollback label on worktree failure
      try {
        await setPrLabel({ prNum, repo, client, isPR: true }, existingReviewState.previousLabel || 'gtw/ready');
      } catch (rollbackErr) {
        console.error(`[ReviewCommand] Rollback failed: ${rollbackErr.message}`);
      }
      return {
        ok: false,
        message: `⚠️ Failed to create worktree: ${e.message}`,
        display: `⚠️ Worktree Creation Failed\n\n${e.message}\n\nCould not create a git worktree for PR #${prNum}. Check that git is available and the PR branch is accessible.`,
      };
    }

    // Scan full codebase in worktree
    let allFiles = [];
    let duplicateModules = [];
    let dependencyGraph = {};
    let changedFilesFullContent = [];

    try {
      const scanResult = await scanCodebase(worktreePath, prData.files.map(f => f.filename));
      allFiles = scanResult.allFiles;
      duplicateModules = scanResult.duplicateModules;
      dependencyGraph = scanResult.dependencyGraph;

      // Get full content of changed files from worktree
      for (const file of prData.files) {
        const fullPath = path.join(worktreePath, file.filename);
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          changedFilesFullContent.push({ path: file.filename, content });
        } catch {
          // File may have been deleted in PR
          changedFilesFullContent.push({ path: file.filename, content: `(file not found: ${file.filename})` });
        }
      }
    } catch (e) {
      console.error(`[ReviewCommand] Codebase scan failed, falling back to diff-only: ${e.message}`);
      // Fall back to diff-only content
      changedFilesFullContent = prData.files.map(f => ({
        path: f.filename,
        content: f.patch || '(no diff)',
      }));
    }

    // Build enhanced user prompt
    const userPrompt = buildEnhancedUserPrompt({
      linkedIssues: prData.linkedIssues,
      changedFilesFullContent,
      baseBranch: prData.baseBranch,
      previousItems,
      allFilesIndex: allFiles.map(f => ({ path: f.path, type: f.type, size: f.size })),
      duplicateModules,
      dependencyAnalysis: dependencyGraph,
    });

    // Call LLM
    let llmResult;
    try {
      llmResult = await callReviewLLM(userPrompt, this.sessionKey);
    } catch (e) {
      // LLM failed — rollback to previous label
      try {
        await setPrLabel({ prNum, repo, client, isPR: true }, existingReviewState.previousLabel || 'gtw/ready');
      } catch (rollbackErr) {
        console.error(`[ReviewCommand] Rollback failed: ${rollbackErr.message}`);
      }
      return {
        ok: false,
        message: `⚠️ LLM review failed: ${e.message}. PR claim has been rolled back.`,
        display: `⚠️ LLM Review Failed\n\n${e.message}\n\nThe PR has not been claimed. Please try again or check your model configuration.`,
      };
    } finally {
      // Always cleanup worktree
      if (worktreePath) {
        removeReviewWorktreeDir(worktreePath);
      }
    }

    // Merge previous items to track resolved items across rounds
    const mergedItems = mergeItemState(previousItems, llmResult.items);

    // Assign stable IDs to new items (items without a previous matching item get a new ID)
    const existingIds = new Set(previousItems.map((p) => p.id));
    let nextIdNum = previousItems.length + 1;
    for (const item of mergedItems) {
      if (!item.id || existingIds.has(item.id)) {
        // Find next available r{N} id
        while (existingIds.has(`r${nextIdNum}`)) nextIdNum++;
        item.id = `r${nextIdNum}`;
        existingIds.add(item.id);
        nextIdNum++;
      }
    }

    // Delete existing comment if present
    if (previousCommentId) {
      await deleteComment(previousCommentId, prNum, repo, client);
    }

    // Render and post new review comment
    const commentBody = renderReviewComment({
      round,
      summary: llmResult.summary,
      verdict: llmResult.verdict,
      items: mergedItems,
      previousRoundItems: previousItems,
      linkedIssues: prData.linkedIssues,
      repo,
      prNum,
    });

    let newCommentId;
    try {
      const commentResp = await client.request('POST', `/repos/${repo}/issues/${prNum}/comments`, {
        body: commentBody,
      });
      newCommentId = commentResp.id;
    } catch (e) {
      // Failed to post comment — rollback label
      try {
        await setPrLabel({ prNum, repo, client, isPR: true }, existingReviewState.previousLabel || 'gtw/ready');
      } catch (rollbackErr) {
        console.error(`[ReviewCommand] Rollback failed: ${rollbackErr.message}`);
      }
      return {
        ok: false,
        message: `⚠️ Failed to post review comment: ${e.message}. PR claim has been rolled back.`,
      };
    }

    // Determine final label
    const finalLabel = llmResult.verdict === 'approve' ? 'gtw/lgtm' : 'gtw/revise';

    // Apply final label
    try {
      await setPrLabel({ prNum, repo, client, isPR: true }, finalLabel);
    } catch (e) {
      return { ok: false, message: `⚠️ ${e.message}` };
    }

    // Save review state to wip (keep commentId, clear reviewState, save items)
    const newReviewState = {
      ...(wip.reviewState || {}),
      [thisPrKey]: {
        commentId: newCommentId,
        items: mergedItems,
        previousLabel: finalLabel,
        round,
      },
    };

    const updatedWip = {
      ...wip,
      reviewState: newReviewState,
      updatedAt: new Date().toISOString(),
    };
    saveWip(updatedWip);

    // Build display response
    const unresolvedItems = mergedItems.filter((i) => !i.resolved);
    const resolvedItems = mergedItems.filter((i) => i.resolved);

    const linkedIssues = prData.linkedIssues || [];
    const linkedIssueLine = linkedIssues.length > 0
      ? linkedIssues.map(i => `#${i.number}: ${i.title || 'none'}`).join(', ')
      : 'none';

    const filesSummary = prData.files
      .map((f) => `  - ${f.filename}: +${f.additions} -${f.deletions}`)
      .join('\n');

    const verdictEmoji = llmResult.verdict === 'approve' ? '✅' : '⚠️';
    const verdictText = llmResult.verdict === 'approve' ? 'APPROVED' : 'CHANGES NEEDED';

    let displayItems = '';
    if (unresolvedItems.length > 0) {
      displayItems = unresolvedItems
        .map((i) => `  - [${i.severity}] [${i.category}] ${i.title}${i.file ? ` (${i.file})` : ''}`)
        .join('\n');
    }

    const summaryLines = [
      `${verdictEmoji} PR #${prNum} ${verdictText} (Round ${round}/${maxRounds})`,
      ``,
      `${prData.pr.title}`,
      ``,
      linkedIssueLine,
      ``,
      `Files changed (${prData.files.length}):`,
      filesSummary || '(none)',
      ``,
      `LLM Summary: ${llmResult.summary}`,
      ``,
    ];

    if (resolvedItems.length > 0) {
      summaryLines.push(`Resolved in this commit (${resolvedItems.length}):`);
      summaryLines.push(resolvedItems.map((i) => `  ✅ ${i.title}`).join('\n'));
      summaryLines.push('');
    }

    if (unresolvedItems.length > 0) {
      summaryLines.push(`Unresolved issues (${unresolvedItems.length}):`);
      summaryLines.push(displayItems);
      summaryLines.push('');
    }

    summaryLines.push(`${finalLabel === 'gtw/lgtm' ? 'gtw/lgtm' : 'gtw/revise'} set.`);

    return {
      ok: true,
      claimed: true,
      repo,
      pr: prData.pr,
      linkedIssues: prData.linkedIssues,
      files: prData.files,
      items: mergedItems,
      round,
      maxRounds,
      verdict: llmResult.verdict,
      commentId: newCommentId,
      message: summaryLines.join('\n'),
      display: summaryLines.join('\n'),
    };
  }
}

/**
 * Clear review state for a specific PR from wip.
 */
function clearReviewState(wip, prKey) {
  const newReviewState = { ...(wip.reviewState || {}) };
  delete newReviewState[prKey];
  return {
    ...wip,
    reviewState: newReviewState,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Backward-compatible exports for existing tests
// These functions are no longer used by the LLM-driven review flow.
// ----------------------------------------------------------------------------

/**
 * @deprecated Use parseItemsFromComment instead (for LLM-driven review)
 * Parse checklist items from old-format comment body.
 * Returns array of { text, checked }.
 */
export function parseChecklistFromComment(body) {
  const result = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*-\s*\[([ x])\]\s*(.+)/);
    if (m) {
      result.push({ text: m[2].trim(), checked: m[1] === 'x' });
    }
  }
  return result;
}

/**
 * @deprecated Use mergeItemState instead (for LLM-driven review)
 * Filter previous checklist items: keep only unresolved ones (unchecked).
 */
export function mergeChecklistState(prevItems, canonicalItems) {
  return canonicalItems
    .filter((text) => {
      const prev = prevItems.find((p) => p.text === text);
      return !prev || !prev.checked;
    })
    .map((text) => ({ text, checked: false }));
}

export { CHECKLIST_ITEMS };
