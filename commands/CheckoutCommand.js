import { Commander } from './Commander.js';
import { getWip } from '../utils/wip.js';
import { git, currentBranch as getCurrentBranch, fetch, checkout } from '../utils/git.js';

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
      return { ok: false, message: '⚠️ No workdir set. Run /gtw on <workdir> first' };
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
    // Step 1: fetch
    try {
      await fetch(workdir, { remote: 'origin' });
    } catch (e) {
      return { ok: false, message: `⚠️ Fetch failed:\n${e.message}` };
    }

    // Step 2: checkout -B (create or reset) tracking branch to origin/<branch>
    // No pull needed — checkout -B origin/<branch> already points us at origin/<branch>
    try {
      // -B: create branch if missing, or reset existing to origin/<branch>
      const checkoutResult = git(`git checkout -B ${branch} origin/${branch}`, workdir);

      const finalBranch = await getCurrentBranch(workdir);
      const output = [checkoutResult].filter(Boolean).join('\n');
      return {
        ok: true,
        branch: finalBranch,
        message: `✅ Synced ${finalBranch} with origin/${finalBranch}${output ? ':\n' + output : ''}`,
        display: `✅ Synced ${finalBranch}${output ? '\n' + output : ''}`,
      };
    } catch (e) {
      const msg = e.message;
      if (msg.includes('could not find') || msg.includes(`origin/${branch}`)) {
        return { ok: false, message: `⚠️ Remote branch origin/${branch} does not exist.` };
      }
      return { ok: false, message: `⚠️ Sync failed:\n${msg}` };
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
      return { ok: false, message: `⚠️ Could not determine current branch:\n${e.message}` };
    }

    if (!currentBranch) {
      return { ok: false, message: '⚠️ Could not determine current branch (empty result).' };
    }

    // Step 1: fetch
    try {
      await fetch(workdir, { remote: 'origin' });
    } catch (e) {
      return { ok: false, message: `⚠️ Fetch failed:\n${e.message}` };
    }

    // Step 2: checkout -B current origin/current
    // No pull needed — checkout -B origin/<branch> already points us at origin/<branch>
    try {
      const checkoutResult = git(`git checkout -B ${currentBranch} origin/${currentBranch}`, workdir);

      const output = [checkoutResult].filter(Boolean).join('\n');
      return {
        ok: true,
        branch: currentBranch,
        message: `✅ Synced ${currentBranch} with origin/${currentBranch}${output ? ':\n' + output : ''}`,
        display: `✅ Synced ${currentBranch}${output ? '\n' + output : ''}`,
      };
    } catch (e) {
      const msg = e.message;
      if (msg.includes('could not find') || msg.includes(`origin/${currentBranch}`)) {
        return { ok: false, message: `⚠️ No remote branch found for "${currentBranch}". Push first: /gtw push` };
      }
      return { ok: false, message: `⚠️ Sync failed:\n${msg}` };
    }
  }
}
