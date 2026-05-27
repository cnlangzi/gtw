import { Commander } from './Commander.js';
import { getWip } from '../utils/wip.js';
import { git, currentBranch as getCurrentBranch, fetch, checkout, hasLocalChanges } from '../utils/git.js';

/**
 * Classify a git error message and return structured result.
 * @param {string} msg - Error message from git
 * @param {string} branch - Branch name (used in generic remote-not-found message)
 * @param {string} [remoteNotFoundMsg] - Override message for remote-not-found case
 */
function classifyGitError(msg, branch, remoteNotFoundMsg) {
  if (msg.includes('Your local changes')) {
    return { ok: false, display: '⚠️ Your local changes would be overwritten by checkout. Please commit or stash your changes first.' };
  }
  if (msg.includes('could not find')) {
    return { ok: false, display: remoteNotFoundMsg || `⚠️ Remote branch origin/${branch} does not exist.` };
  }
  return { ok: false, display: `⚠️ Sync failed:\n${msg}` };
}

/**
 * CheckoutCommand — fetch and switch to a branch, pulling the latest from origin.
 *
 * /gtw checkout [branch]
 *   With branch:  fetch → checkout -B <branch> origin/<branch> → pull
 *   Without args: fetch → checkout -B <current> origin/<current> → pull
 */
export class CheckoutCommand extends Commander {
  async execute(args) {
    const wip = getWip();
    if (!wip.workdir) {
      return { ok: false, display: '⚠️ No workdir set. Run /gtw on <workdir> first' };
    }
    const workdir = wip.workdir;

    const branch = args[0];

    if (branch) {
      return this.syncSpecificBranch(workdir, branch);
    } else {
      return this.syncCurrentBranch(workdir);
    }
  }

  /**
   * Sync a named branch:
   * 1. fetch origin
   * 2. checkout -B <branch> origin/<branch> (create or reset tracking branch)
   * 3. pull
   */
  async syncSpecificBranch(workdir, branch) {
    if (hasLocalChanges(workdir)) {
      return { ok: false, display: '⚠️ Your local changes would be overwritten by checkout. Please commit or stash your changes first.' };
    }

    try {
      await fetch(workdir, { remote: 'origin', ref: branch });
    } catch (e) {
      return classifyGitError(e.message, branch);
    }

    try {
      const checkoutResult = git(`git checkout -B ${branch} origin/${branch}`, workdir);
      const finalBranch = await getCurrentBranch(workdir);
      const output = [checkoutResult].filter(Boolean).join('\n');
      return {
        ok: true,
        branch: finalBranch,
        display: `✅ Synced ${finalBranch}${output ? '\n' + output : ''}`,
      };
    } catch (e) {
      return classifyGitError(e.message, branch);
    }
  }

  /**
   * Sync the current branch onto its upstream:
   * 1. Determine current branch
   * 2. fetch origin
   * 3. checkout -B <current> origin/<current>
   * 4. pull
   */
  async syncCurrentBranch(workdir) {
    let currentBranch;
    try {
      currentBranch = await getCurrentBranch(workdir);
    } catch (e) {
      return { ok: false, display: `⚠️ Could not determine current branch:\n${e.message}` };
    }

    if (!currentBranch) {
      return { ok: false, display: '⚠️ Could not determine current branch (empty result).' };
    }

    if (hasLocalChanges(workdir)) {
      return { ok: false, display: '⚠️ Your local changes would be overwritten by checkout. Please commit or stash your changes first.' };
    }

    try {
      await fetch(workdir, { remote: 'origin', ref: currentBranch });
    } catch (e) {
      return classifyGitError(e.message, currentBranch, `⚠️ No remote branch found for "${currentBranch}". Push first: /gtw push`);
    }

    try {
      const checkoutResult = git(`git checkout -B ${currentBranch} origin/${currentBranch}`, workdir);
      const output = [checkoutResult].filter(Boolean).join('\n');
      return {
        ok: true,
        branch: currentBranch,
        display: `✅ Synced ${currentBranch}${output ? '\n' + output : ''}`,
      };
    } catch (e) {
      return classifyGitError(e.message, currentBranch);
    }
  }
}