import { Commander } from './Commander.js';
import { getWip } from '../utils/wip.js';
import { git, getCurrentBranch } from '../utils/git.js';

/**
 * RebaseCommand — sync a branch with its remote counterpart via rebase.
 *
 * /gtw rebase [branch]
 *   With branch:  fetch → checkout [-b origin/branch if needed] → rebase origin/<branch>
 *   Without args: pull --rebase origin <current-branch>
 */
export class RebaseCommand extends Commander {
  async execute(args) {
    const wip = getWip();
    if (!wip.workdir) {
      return { ok: false, message: '⚠️ No workdir set. Run /gtw on <workdir> first' };
    }
    const workdir = wip.workdir;

    const branch = args[0];

    if (branch) {
      return this.rebaseSpecificBranch(workdir, branch);
    } else {
      return this.rebaseCurrentBranch(workdir);
    }
  }

  /**
   * Rebase a named branch:
   * 1. fetch origin
   * 2. checkout (create tracking branch from origin/<branch> if local missing)
   * 3. rebase origin/<branch>
   */
  rebaseSpecificBranch(workdir, branch) {
    let currentBranch;

    // Step 1: fetch
    try {
      git('git fetch origin', workdir);
    } catch (e) {
      return { ok: false, message: `⚠️ Fetch failed:\n${e.message}` };
    }

    // Step 2: checkout (reuse tryCheckoutRemoteBranch logic inline)
    try {
      currentBranch = getCurrentBranch(workdir);
    } catch (e) {
      return { ok: false, message: `⚠️ Could not determine current branch:\n${e.message}` };
    }

    if (currentBranch === branch) {
      // Already on this branch — nothing to checkout, just verify remote tracking
      try {
        git(`git rev-parse --verify origin/${branch}`, workdir);
      } catch {
        return { ok: false, message: `⚠️ Remote branch origin/${branch} does not exist.\n` };
      }
    } else {
      // Different branch — check if local exists
      let localExists = false;
      try {
        git(`git rev-parse --verify ${branch}`, workdir);
        localExists = true;
      } catch {
        localExists = false;
      }

      if (localExists) {
        // Local exists — just checkout
        try {
          git(`git checkout ${branch}`, workdir);
        } catch (e) {
          return { ok: false, message: `⚠️ Checkout failed:\n${e.message}` };
        }
      } else {
        // Local missing — check if origin/<branch> exists and create tracking branch
        try {
          git(`git rev-parse --verify origin/${branch}`, workdir);
        } catch {
          return { ok: false, message: `⚠️ Branch "${branch}" does not exist locally or on origin.\n` };
        }
        try {
          git(`git checkout -b ${branch} origin/${branch}`, workdir);
        } catch (e) {
          return { ok: false, message: `⚠️ Failed to create tracking branch:\n${e.message}` };
        }
      }
    }

    // Step 3: rebase
    try {
      const result = git(`git rebase origin/${branch}`, workdir);
      const finalBranch = getCurrentBranch(workdir);
      return {
        ok: true,
        branch: finalBranch,
        message: `✅ Rebase successful on ${finalBranch}${result ? ':\n' + result : ''}`,
        display: `✅ Rebased onto origin/${branch}${result ? '\n' + result : ''}`,
      };
    } catch (e) {
      // Detect conflict signal in output
      const msg = e.message;
      if (msg.includes('CONFLICT') || msg.includes('conflict')) {
        return {
          ok: false,
          message: `⚠️ Rebase conflict on ${branch}:\n${msg}\n\nTo resolve:\n  1. Edit conflicting files\n  2. git add <resolved-files>\n  3. git rebase --continue\n  Or abort: git rebase --abort`,
        };
      }
      return { ok: false, message: `⚠️ Rebase failed:\n${msg}` };
    }
  }

  /**
   * Rebase the current branch onto its upstream:
   * 1. Determine current branch
   * 2. pull --rebase origin <current-branch>
   */
  rebaseCurrentBranch(workdir) {
    let currentBranch;
    try {
      currentBranch = getCurrentBranch(workdir);
    } catch (e) {
      return { ok: false, message: `⚠️ Could not determine current branch:\n${e.message}` };
    }

    if (!currentBranch) {
      return { ok: false, message: '⚠️ Could not determine current branch (empty result).' };
    }

    try {
      const result = git(`git pull --rebase origin ${currentBranch}`, workdir);
      return {
        ok: true,
        branch: currentBranch,
        message: `✅ Rebase successful on ${currentBranch}${result ? ':\n' + result : ''}`,
        display: `✅ Rebased ${currentBranch}${result ? '\n' + result : ''}`,
      };
    } catch (e) {
      const msg = e.message;
      if (msg.includes('CONFLICT') || msg.includes('conflict')) {
        return {
          ok: false,
          message: `⚠️ Rebase conflict on ${currentBranch}:\n${msg}\n\nTo resolve:\n  1. Edit conflicting files\n  2. git add <resolved-files>\n  3. git rebase --continue\n  Or abort: git rebase --abort`,
        };
      }
      return { ok: false, message: `⚠️ Pull --rebase failed:\n${msg}` };
    }
  }
}
