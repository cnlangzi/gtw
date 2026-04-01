import { Commander } from './Commander.js';
import { getConfig, saveConfig } from '../utils/config.js';

/**
 * Validate owner/repo format.
 */
function validateRepoArg(arg) {
  if (!arg) return null;
  const m = String(arg).match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export class WatchCommand extends Commander {
  /**
   * /gtw watch list
   * /gtw watch add <owner>/<repo>
   * /gtw watch rm <owner>/<repo>
   */
  async execute(args) {
    const sub = (args[0] || '').toLowerCase();
    const rest = args.slice(1);

    if (sub === 'add') {
      return this._add(rest);
    } else if (sub === 'rm' || sub === 'remove') {
      return this._rm(rest);
    } else if (sub === 'list') {
      return this._list();
    } else {
      return {
        ok: true,
        message: 'Usage:\n  /gtw watch list          Show watched repos\n  /gtw watch add <owner>/<repo>   Add repo to watch list\n  /gtw watch rm <owner>/<repo>    Remove repo from watch list',
        display: `Usage:\n  /gtw watch list              Show watched repos\n  /gtw watch add <owner>/<repo>   Add repo to watch list\n  /gtw watch rm <owner>/<repo>    Remove repo from watch list`,
      };
    }
  }

  async _add(args) {
    const repoArg = args.join(' ').trim();
    const parsed = validateRepoArg(repoArg);
    if (!parsed) {
      return {
        ok: false,
        message: `⚠️ Invalid format. Use: /gtw watch add <owner>/<repo>\nExample: /gtw watch add octocat/Hello-World`,
      };
    }

    const fullName = `${parsed.owner}/${parsed.repo}`;
    const config = getConfig();
    const watchList = config.watchList || [];

    if (watchList.includes(fullName)) {
      return {
        ok: true,
        message: `ℹ️ ${fullName} is already in the watch list`,
        display: `ℹ️ ${fullName} is already being watched`,
      };
    }

    config.watchList = [...watchList, fullName];
    saveConfig(config);

    return {
      ok: true,
      added: fullName,
      message: `✅ Added ${fullName} to watch list`,
      display: `✅ Now watching: ${fullName}\n\nTotal watched repos: ${config.watchList.length}`,
    };
  }

  async _rm(args) {
    const repoArg = args.join(' ').trim();
    const parsed = validateRepoArg(repoArg);
    if (!parsed) {
      return {
        ok: false,
        message: `⚠️ Invalid format. Use: /gtw watch rm <owner>/<repo>\nExample: /gtw watch rm octocat/Hello-World`,
      };
    }

    const fullName = `${parsed.owner}/${parsed.repo}`;
    const config = getConfig();
    const watchList = config.watchList || [];

    if (!watchList.includes(fullName)) {
      return {
        ok: true,
        message: `ℹ️ ${fullName} is not in the watch list`,
        display: `ℹ️ ${fullName} is not in the watch list`,
      };
    }

    config.watchList = watchList.filter((r) => r !== fullName);
    saveConfig(config);

    return {
      ok: true,
      removed: fullName,
      message: `✅ Removed ${fullName} from watch list`,
      display: `✅ Removed: ${fullName}\n\nTotal watched repos: ${config.watchList.length}`,
    };
  }

  async _list() {
    const config = getConfig();
    const watchList = config.watchList || [];

    if (watchList.length === 0) {
      return {
        ok: true,
        watchList: [],
        message: '🔍 Watch list is empty',
        display: '🔍 Watch list is empty\n\nAdd repos:\n  /gtw watch add <owner>/<repo>',
      };
    }

    const lines = watchList.map((r) => `  - ${r}`).join('\n');
    return {
      ok: true,
      watchList,
      message: `Watching ${watchList.length} repos:\n${lines}`,
      display: `👁 Watching ${watchList.length} repo(s):\n\n${lines}`,
    };
  }
}
