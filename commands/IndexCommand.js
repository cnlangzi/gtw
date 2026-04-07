/**
 * /gtw index — Build or update the codebase function index.
 *
 * Usage:
 *   /gtw index          — Build or incrementally update index
 *   /gtw index --force  — Force full rebuild
 *   /gtw index --stats  — Show index statistics
 *   /gtw index --rm     — Remove index for current repo
 */

import { Commander } from './Commander.js';
import { getWip } from '../utils/wip.js';
import {
  getOrBuildIndex,
  indexExists,
  removeIndex,
  loadIndex,
  loadIndexMarkdown,
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
      return {
        ok: false,
        message: '⚠️ No repo set. Run /gtw on <workdir> first',
      };
    }

    const workdir = wip.workdir;
    if (!workdir) {
      return {
        ok: false,
        message: '⚠️ No workdir set. Run /gtw on <workdir> first',
      };
    }

    // Parse flags
    const force = args.includes('--force') || args.includes('-f');
    const stats = args.includes('--stats') || args.includes('-s');
    const remove = args.includes('--rm');

    if (remove) {
      return this._removeIndex(repo);
    }

    if (stats) {
      return this._showStats(repo, workdir);
    }

    // Build or update
    return this._buildOrUpdateIndex(repo, workdir, force);
  }

  async _buildOrUpdateIndex(repo, workdir, force) {
    const action = force ? 'Full rebuild' : indexExists(repo) ? 'Incremental update' : 'Full build';

    let result;
    try {
      result = getOrBuildIndex(workdir, repo, { force });
    } catch (e) {
      return {
        ok: false,
        message: `⚠️ Index build failed: ${e.message}`,
      };
    }

    const indexData = loadIndexMarkdown(repo);
    const lines = indexData ? indexData.split('\n').length : 0;

    return {
      ok: true,
      message: `✅ Index ${action.toLowerCase()} complete for ${repo}\n\n📊 Stats: ${result}\n📄 Index lines: ${lines}`,
      display: `✅ **Index ${action.toLowerCase()} complete**\n\n**Repo:** ${repo}\n**Action:** ${action}\n**Saved to:** \`~/.gtw/codebase-index/${repo.replace('/', '/')}.md\``,
    };
  }

  async _showStats(repo, workdir) {
    const existing = loadIndex(repo);

    if (!existing) {
      return {
        ok: true,
        message: `🔍 No index found for ${repo}\n\nRun /gtw index to build one.`,
        display: `🔍 **No index found** for ${repo}\n\nRun \`/gtw index\` to build one.`,
      };
    }

    const { meta } = existing;
    const indexedFileCount = Object.keys(meta.files || {}).length;

    return {
      ok: true,
      message: `📊 Index stats for ${repo}\n\nLast updated: ${meta.lastUpdated}\nIndexed files: ${indexedFileCount}\nTotal functions: ${meta.stats?.totalFunctions || 0}\nRebuilt: ${meta.stats?.rebuilt || 0}\nUnchanged: ${meta.stats?.unchanged || 0}`,
      display: `📊 **Index stats** for ${repo}\n\n| Metric | Value |\n|---|---|\n| Last updated | ${meta.lastUpdated || 'unknown'} |\n| Indexed files | ${indexedFileCount} |\n| Total functions | ${meta.stats?.totalFunctions || 0} |\n| Rebuilt this run | ${meta.stats?.rebuilt || 0} |\n| Unchanged | ${meta.stats?.unchanged || 0} |`,
    };
  }

  async _removeIndex(repo) {
    const removed = removeIndex(repo);

    if (removed) {
      return {
        ok: true,
        message: `✅ Index removed for ${repo}`,
        display: `✅ **Index removed** for ${repo}`,
      };
    } else {
      return {
        ok: false,
        message: `⚠️ No index found for ${repo}`,
      };
    }
  }
}
