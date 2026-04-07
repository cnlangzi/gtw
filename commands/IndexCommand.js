/**
 * /gtw index — Build or update the codebase function index.
 *
 * Usage:
 *   /gtw index [branch]     — Build or incrementally update index for branch
 *   /gtw index --force      — Force full rebuild
 *   /gtw index --stats      — Show index statistics
 *   /gtw index --rm [branch] — Remove index for current (or specified) branch
 *   /gtw index --list       — List all indexed branches
 */

import { Commander } from './Commander.js';
import { getWip } from '../utils/wip.js';
import {
  getOrBuildIndex,
  rebuildIndex,
  loadIndex,
  loadIndexMarkdown,
  removeIndex,
  listIndexedBranches,
  getCurrentBranch,
} from '../utils/codebase-index.js';

export class IndexCommand extends Commander {
  constructor(context) {
    super(context);
    this.sessionKey = context.sessionKey;
  }

  async execute(args) {
    const wip = getWip();
    const repo = wip.repo;

    if (!repo) {
      return { ok: false, message: '⚠️ No repo set. Run /gtw on <workdir> first' };
    }

    const workdir = wip.workdir;
    if (!workdir) {
      return { ok: false, message: '⚠️ No workdir set. Run /gtw on <workdir> first' };
    }

    const flags = args.filter((a) => a.startsWith('--'));
    const positional = args.filter((a) => !a.startsWith('--'));

    if (flags.includes('--list')) {
      return this._listBranches(repo);
    }

    if (flags.includes('--stats')) {
      return this._showStats(repo, workdir, positional[0]);
    }

    if (flags.includes('--rm')) {
      const branch = positional[0] || getCurrentBranch(workdir);
      return this._removeIndex(repo, branch);
    }

    const force = flags.includes('--force') || flags.includes('-f');
    const branch = positional[0] || getCurrentBranch(workdir);

    return this._buildOrUpdate(repo, workdir, branch, force);
  }

  async _buildOrUpdate(repo, workdir, branch, force) {
    const action = force ? 'full rebuild' : 'incremental update';

    try {
      getOrBuildIndex(workdir, repo, branch, { force });
    } catch (e) {
      return { ok: false, message: `⚠️ Index build failed: ${e.message}` };
    }

    const existing = loadIndex(repo, branch);
    const meta = existing?.meta || {};

    return {
      ok: true,
      message: `✅ Index ${action} complete for ${repo}@${branch}\n\nBranch: ${branch}\nLast commit: ${meta.lastCommit || 'unknown'}\nLast updated: ${meta.lastUpdated || 'unknown'}\nFiles indexed: ${meta.stats?.indexedFiles || 0}\nFunctions: ${meta.stats?.totalFunctions || 0}`,
      display: `✅ **Index ${action} complete**\n\n| | |
|---|---|
| **Repo** | ${repo} |
| **Branch** | ${branch} |
| **Last commit** | \`${meta.lastCommit || 'unknown'}\` |
| **Files indexed** | ${meta.stats?.indexedFiles || 0} |
| **Functions** | ${meta.stats?.totalFunctions || 0} |
| **Saved to** | \`~/.gtw/codebase-index/${repo.replace('/', '/')}@${branch}.md\` |`,
    };
  }

  async _showStats(repo, workdir, branch) {
    const targetBranch = branch || getCurrentBranch(workdir);
    const existing = loadIndex(repo, targetBranch);

    if (!existing) {
      return {
        ok: true,
        message: `🔍 No index found for ${repo}@${targetBranch}\n\nRun /gtw index to build one.`,
        display: `🔍 **No index found** for ${repo}@${targetBranch}\n\nRun \`/gtw index\` to build one.`,
      };
    }

    const { meta } = existing;
    const branches = listIndexedBranches(repo);

    return {
      ok: true,
      message: `📊 Index stats for ${repo}@${targetBranch}\n\nLast commit: ${meta.lastCommit || 'unknown'}\nLast updated: ${meta.lastUpdated || 'unknown'}\nFiles indexed: ${meta.stats?.indexedFiles || 0}\nFunctions: ${meta.stats?.totalFunctions || 0}\n\nAll indexed branches: ${branches.join(', ')}`,
      display: `📊 **Index stats** for ${repo}@${targetBranch}\n\n| Metric | Value |
|---|---|
| Last commit | \`${meta.lastCommit || 'unknown'}\` |
| Last updated | ${meta.lastUpdated || 'unknown'} |
| Files indexed | ${meta.stats?.indexedFiles || 0} |
| Functions | ${meta.stats?.totalFunctions || 0} |
| All branches | ${branches.join(', ')} |`,
    };
  }

  async _removeIndex(repo, branch) {
    const removed = removeIndex(repo, branch);
    return {
      ok: true,
      message: removed
        ? `✅ Index removed for ${repo}@${branch}`
        : `⚠️ No index found for ${repo}@${branch}`,
      display: removed
        ? `✅ **Index removed** for ${repo}@${branch}`
        : `⚠️ **No index found** for ${repo}@${branch}`,
    };
  }

  async _listBranches(repo) {
    const branches = listIndexedBranches(repo);

    if (branches.length === 0) {
      return {
        ok: true,
        message: `🔍 No indexes found for ${repo}`,
        display: `🔍 **No indexes found** for ${repo}`,
      };
    }

    return {
      ok: true,
      message: `📦 Indexed branches for ${repo}:\n\n${branches.map((b) => `  - ${b}`).join('\n')}`,
      display: `📦 **Indexed branches** for ${repo}:\n\n${branches.map((b) => `- \`${b}\``).join('\n')}`,
    };
  }
}
