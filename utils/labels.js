/**
 * Label system for gtw: 5 mutually exclusive labels.
 *
 * Exports:
 *   GTW_LABELS          — array of the 5 label names
 *   setPrLabel(ctx, label) — atomic set with mutual exclusion, concurrency rollback
 *
 * Pass ctx.client (GitHubClient instance) or ctx.token for authentication.
 */

import { GitHubClient } from './github.js';

export const GTW_LABELS = ['gtw/ready', 'gtw/wip', 'gtw/lgtm', 'gtw/revise', 'gtw/stuck'];

/**
 * Context shape:
 *   { prNum, repo, client, isPR? }
 *
 * client: a GitHubClient instance (preferred).
 *         For backward compatibility, ctx.token is also accepted.
 *
 * Returns { ok, preempted, label } on success.
 * Throws on network / API error (unless preemption rollback succeeds).
 *
 * Concurrency behavior for gtw/wip claim:
 *   1. Atomically remove other gtw/* labels and set gtw/wip.
 *   2. Re-fetch labels and check: if gtw/ready is still present, another
 *      runner beat us → rollback gtw/wip → set gtw/ready → return { preempted: true }.
 *   3. If rollback itself fails, throw (state is ambiguous).
 */
export async function setPrLabel(ctx, label) {
  const { prNum, repo, isPR = true } = ctx;

  // Get client from ctx or construct from ctx.token
  let client;
  if (ctx.client) {
    client = ctx.client;
  } else if (ctx.token) {
    client = new GitHubClient(ctx.token);
  } else {
    throw new Error('setPrLabel requires either ctx.client or ctx.token');
  }

  if (!GTW_LABELS.includes(label)) {
    throw new Error(
      `Invalid gtw label: ${label}. Must be one of: ${GTW_LABELS.join(', ')}`,
    );
  }

  // GitHub labels API is unified under the issues endpoint, even for PRs.
  // /pulls/{num}/labels does not exist (404) — use /issues/{num}/labels instead.
  const endpointBase = `/repos/${repo}/issues/${prNum}`;

  // Step 1: fetch current labels
  const currentLabels = await client.request('GET', `${endpointBase}/labels`);

  // Step 2: remove other gtw/* labels
  const toRemove = currentLabels
    .map((l) => l.name)
    .filter((name) => GTW_LABELS.includes(name) && name !== label);

  for (const lbl of toRemove) {
    try {
      await client.request('DELETE', `${endpointBase}/labels/${encodeURIComponent(lbl)}`);
    } catch (e) {
      // 404 = label already gone (race), which is fine.
      // Any other error: abort without continuing.
      if (!e.message.includes('404') && !e.message.includes('Label not found')) {
        throw new Error(
          `Failed to remove label "${lbl}" from #${prNum}: ${e.message}. Aborting.`,
        );
      }
    }
  }

  // Step 3: set target label — always POST to avoid stale alreadyHas races.
  // GitHub's label API is idempotent; duplicate POST is a no-op server-side.
  try {
    await client.request('POST', `${endpointBase}/labels`, { labels: [label] });
  } catch (e) {
    throw new Error(`Failed to set label "${label}" on #${prNum}: ${e.message}. Aborting.`);
  }

  // Step 4: concurrency safety — only needed when claiming gtw/wip
  if (label === 'gtw/wip') {
    const fresh = await client.request('GET', `${endpointBase}/labels`);
    const wasPreempted = fresh.some((l) => l.name === 'gtw/ready');

    if (wasPreempted) {
      // Rollback: remove gtw/wip, restore gtw/ready
      try {
        await client.request(
          'DELETE',
          `${endpointBase}/labels/${encodeURIComponent('gtw/wip')}`,
        );
      } catch (e) {
        if (!e.message.includes('404') && !e.message.includes('Label not found')) {
          throw new Error(
            `Rollback failed: could not remove gtw/wip after preemption detected. State ambiguous: ${e.message}`,
          );
        }
      }
      try {
        await client.request('POST', `${endpointBase}/labels`, { labels: ['gtw/ready'] });
      } catch (e) {
        throw new Error(
          `Rollback failed: could not restore gtw/ready after preemption. State ambiguous: ${e.message}`,
        );
      }
      return { ok: true, preempted: true, label };
    }
  }

  return { ok: true, preempted: false, label };
}
