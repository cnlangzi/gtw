import { Commander } from './Commander.js';
import { getWip, clearWip, saveWip } from '../utils/wip.js';
import { getValidToken } from '../utils/api.js';
import { GitHubClient } from '../utils/github.js';
import { git } from '../utils/git.js';

export class ConfirmCommand extends Commander {
  async execute(args) {
    const wip = getWip();

    // Handle pending PR (from /gtw pr)
    if (wip.pendingPr) {
      const { headBranch, baseBranch, title, body, issueId, workdir } = wip.pendingPr;

      // Ensure branch is pushed to origin
      let wasPushed = false;
      try {
        // Check if branch exists on remote
        git(`git fetch origin ${headBranch}`, workdir);
        const localRev = git(`git rev-parse ${headBranch}`, workdir);
        const remoteRev = git(`git rev-parse origin/${headBranch}`, workdir);
        if (localRev !== remoteRev) {
          git(`git push -u origin ${headBranch}`, workdir);
          wasPushed = true;
        }
      } catch (e) {
        // Branch might not exist on remote yet — push it
        try {
          git(`git push -u origin ${headBranch}`, workdir);
          wasPushed = true;
        } catch (pushErr) {
          return {
            ok: false,
            message: `Failed to push branch ${headBranch}: ${pushErr.message}`,
            display: [
              `❌ Failed to push branch`,
              ``,
              `Branch: ${headBranch}`,
              `Error: ${pushErr.message}`,
              ``,
              `Please push the branch manually and try again.`,
            ].join('\n'),
          };
        }
      }

      // Create PR via GitHub API
      let prData;
      try {
        const token = await getValidToken();
        const client = new GitHubClient(token);
        const repo = wip.repo;

        // Always prepend canonical issue association at confirm time
        let prBody = body || '';
        if (issueId) {
          prBody = `Fixes: #${issueId}\n\n${prBody}`;
        }

        prData = await client.request('POST', `/repos/${repo}/pulls`, {
          title,
          body: prBody,
          head: headBranch,
          base: baseBranch,
        });
      } catch (e) {
        // Preserve wip.pendingPr for retry on GitHub API failure
        return {
          ok: false,
          branch: headBranch,
          message: `GitHub API error: ${e.message}`,
          display: [
            `❌ GitHub API error — PR not created`,
            ``,
            `Error: ${e.message}`,
            ``,
            `Your pending PR draft is preserved. Fix the issue and run /gtw confirm again.`,
          ].join('\n'),
        };
      }

      // PR created successfully — save to wip.pr, clear wip.pendingPr
      const updated = {
        ...wip,
        pr: {
          id: prData.id,
          number: prData.number,
          url: prData.html_url,
          title: prData.title,
          body: prData.body,
          headBranch,
          baseBranch,
          issueId,
          createdAt: new Date().toISOString(),
        },
        pendingPr: undefined,
        updatedAt: new Date().toISOString(),
      };
      saveWip(updated);

      return {
        ok: true,
        pr: updated.pr,
        display: [
          `✅ PR #${prData.number} created`,
          ``,
          `Title: ${prData.title}`,
          `URL: ${prData.html_url}`,
          `Branch: ${headBranch} → ${baseBranch}`,
          issueId ? `Fixes: #${issueId}` : '',
        ].filter(Boolean).join('\n'),
      };
    }

    // Handle pending commit (from /gtw push)
    if (wip.pendingCommit) {
      const { title, body, branch, workdir, files, totalAdd, totalDel } = wip.pendingCommit;

      git(`git commit -m "${title.replace(/"/g, '\\"')}" -m "${body.replace(/"/g, '\\"')}"`, workdir);
      git(`git push -u origin ${branch}`, workdir);

      // Keep workdir/repo, clear pendingCommit
      const { workdir: wd, repo } = wip;
      clearWip();
      saveWip({ workdir: wd, repo, updatedAt: new Date().toISOString() });

      return {
        ok: true,
        branch,
        commit: { title, body },
        display: [
          `📦 Committed and pushed`,
          `Branch: ${branch}`,
          `Commit: ${title}`,
          `Extended: ${body.split('\n')[0] || body.slice(0, 60)}`,
        ].join('\n'),
      };
    }

    // Handle pending issue (from /gtw new)
    if (!wip.repo) throw new Error('No pending action. Run /gtw on + /gtw new first');
    if (!wip.issue?.title) throw new Error('No issue draft. Run /gtw new first');

    const token = await getValidToken();
    const client = new GitHubClient(token);
    const { title, body, target, goal, context, consequence, decided, rejected, constraints, outOfScope, verify } = wip.issue;

    // Build structured body from new fields (for AI readability and context)
    const issueBody = (body && !target) ? body : [
      target ? `## Target\n${target}` : '',
      goal ? `## Goal\n${goal}` : '',
      context ? `## Context\n${context}` : '',
      consequence ? `## Consequence\n${consequence}` : '',
      decided?.solution ? `## Decided Solution\n${decided.solution}\n\n**Reason:** ${decided.reason || 'N/A'}` : '',
      rejected?.option ? `## Rejected Alternative\n**Option:** ${rejected.option}\n**Reason:** ${rejected.reason || 'N/A'}` : '',
      constraints?.length ? `## Constraints\n${constraints.map(c => `- ${c}`).join('\n')}` : '',
      outOfScope?.length ? `## Out of Scope\n${outOfScope.map(s => `- ${s}`).join('\n')}` : '',
      verify?.length ? `## Verification\n${verify.map(v => `- ${v}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');

    const data = await client.request('POST', `/repos/${wip.repo}/issues`, {
      title,
      body: issueBody || 'Created via gtw',
    });

    clearWip();

    return {
      ok: true,
      issue: { id: data.number, url: data.html_url },
      display: `✅ Issue #${data.number} created\n${data.html_url}`,
    };
  }
}
