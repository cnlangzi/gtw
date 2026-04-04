/**
 * Label system for gtw: 5 mutually exclusive labels.
 *
 * Exports:
 *   GTW_LABELS          — array of the 5 label names
 *   setPrLabel(ctx, label, api) — atomic set with mutual exclusion, concurrency rollback
 *
 * The api parameter defaults to the real apiRequest but can be overridden for tests.
 */

import { apiRequest as _defaultApiRequest } from './api.js';

export const GTW_LABELS = ['gtw/ready', 'gtw/wip', 'gtw/lgtm', 'gtw/revise', 'gtw/stuck'];

/**
 * Context shape:
 *   { prNum, repo, token, isPR? }
 *
 * api: optional injectable apiRequest(mock) for testing.
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
export async function setPrLabel(ctx, label, api = _defaultApiRequest) {
  const { prNum, repo, token, isPR = true } = ctx;

  if (!GTW_LABELS.includes(label)) {
    throw new Error(
      `Invalid gtw label: ${label}. Must be one of: ${GTW_LABELS.join(', ')}`,
    );
  }

  // GitHub labels API is unified under the issues endpoint, even for PRs.
  // /pulls/{num}/labels does not exist (404) — use /issues/{num}/labels instead.
  const endpointBase = `/repos/${repo}/issues/${prNum}`;

  // Step 1: fetch current labels
  const currentLabels = await api('GET', `${endpointBase}/labels`, token);

  // Step 2: remove other gtw/* labels
  const toRemove = currentLabels
    .map((l) => l.name)
    .filter((name) => GTW_LABELS.includes(name) && name !== label);

  for (const lbl of toRemove) {
    try {
      await api('DELETE', `${endpointBase}/labels/${encodeURIComponent(lbl)}`, token);
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
    await api('POST', `${endpointBase}/labels`, token, { labels: [label] });
  } catch (e) {
    throw new Error(`Failed to set label "${label}" on #${prNum}: ${e.message}. Aborting.`);
  }

  // Step 4: concurrency safety — only needed when claiming gtw/wip
  if (label === 'gtw/wip') {
    const fresh = await api('GET', `${endpointBase}/labels`, token);
    const wasPreempted = fresh.some((l) => l.name === 'gtw/ready');

    if (wasPreempted) {
      // Rollback: remove gtw/wip, restore gtw/ready
      try {
        await api(
          'DELETE',
          `${endpointBase}/labels/${encodeURIComponent('gtw/wip')}`,
          token,
        );
      } catch (e) {
        if (!e.message.includes('404') && !e.message.includes('Label not found')) {
          throw new Error(
            `Rollback failed: could not remove gtw/wip after preemption detected. State ambiguous: ${e.message}`,
          );
        }
      }
      try {
        await api('POST', `${endpointBase}/labels`, token, { labels: ['gtw/ready'] });
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
