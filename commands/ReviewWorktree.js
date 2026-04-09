/**
 * Review Worktree Management.
 * Prepares git worktrees for PR review.
 */

import fs from 'fs';
import path from 'path';
import { execSync as _xrun } from 'child_process';
import { BASE_DIR } from '../utils/config.js';

/**
 * Prepare a git worktree for reviewing a PR branch.
 *
 * Structure:
 * - Base clone at {BASE_DIR}/reviews/{owner}/{repo}/ (on default branch, shared)
 * - Worktree at {BASE_DIR}/reviews/{owner}/{repo}/gtw_reviews/{branchName}/
 *
 * @param {string} repo - "owner/repo"
 * @param {number} prNum - PR number
 * @param {string} branchName - PR branch name (pr.head.ref)
 * @param {string} baseBranch - Default branch (e.g. "main")
 * @param {string} cloneUrl - Git clone URL
 * @returns {Promise<string>} - Absolute path to worktree
 */
export async function prepareReviewWorktree(repo, prNum, branchName, baseBranch, cloneUrl) {
  const reviewRoot = path.resolve(BASE_DIR, 'reviews', repo);
  const worktreeRoot = path.resolve(reviewRoot, 'gtw_reviews');
  const worktreePath = path.resolve(worktreeRoot, branchName);

  // Ensure base clone exists
  if (!fs.existsSync(reviewRoot)) {
    fs.mkdirSync(reviewRoot, { recursive: true });
    _xrun(`git clone --depth=1 --branch ${baseBranch} "${cloneUrl}" "${reviewRoot}"`);
  }

  // Ensure worktree exists
  if (fs.existsSync(worktreePath)) {
    try {
      _xrun(`git fetch origin refs/pull/${prNum}/head:${branchName}`, { cwd: worktreePath });
      _xrun(`git config pull.rebase true`, { cwd: worktreePath });
      _xrun(`git reset --hard FETCH_HEAD`, { cwd: worktreePath });
    } catch {
      // Pull failed — remove and recreate
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  if (!fs.existsSync(worktreePath)) {
    // Fetch PR branch ref
    try {
      _xrun(`git fetch origin refs/pull/${prNum}/head:${branchName}`, { cwd: reviewRoot });
    } catch {}
    // Create worktree
    fs.mkdirSync(worktreeRoot, { recursive: true });
    try {
      _xrun(`git worktree add "${worktreePath}" "${branchName}"`, { cwd: reviewRoot });
    } catch {
      // May fail if worktree already exists, try continuing
    }
    _xrun(`git config pull.rebase true`, { cwd: worktreePath });
  }

  return worktreePath;
}

function runCmd(cmd, opts = {}) {
  return runCmd(cmd, { stdio: 'pipe', ...opts }).toString().trim();
}
