/**
 * Unit tests for utils/labels.js — setPrLabel atomicity, rollback, and concurrency.
 * Run: node --test utils/labels.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { GTW_LABELS, setPrLabel } from './labels.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a stateful mock API whose behavior changes based on call count.
 * @param {Array<function>} handlers - array of handler functions, one per call
 */
function makeMockApi(handlers) {
  let callIdx = 0;
  return async function mockApi(method, path, token, body) {
    if (callIdx >= handlers.length) {
      throw new Error(`No handler for call #${callIdx} (${method} ${path}). Total handlers: ${handlers.length}`);
    }
    return handlers[callIdx++](method, path, token, body);
  };
}

// ---------------------------------------------------------------------------
// GTW_LABELS
// ---------------------------------------------------------------------------

describe('GTW_LABELS', () => {
  it('has exactly 5 mutually exclusive labels', () => {
    assert.strictEqual(GTW_LABELS.length, 5);
    assert.deepStrictEqual(
      GTW_LABELS,
      ['gtw/ready', 'gtw/wip', 'gtw/lgtm', 'gtw/revise', 'gtw/stuck'],
    );
  });
});

// ---------------------------------------------------------------------------
// AC1: setPrLabel — label operation success
// ---------------------------------------------------------------------------

describe('setPrLabel: success (AC1 — mutual exclusion)', () => {
  for (const label of GTW_LABELS) {
    it(`sets ${label} and removes other gtw labels`, async () => {
      // State: PR starts with gtw/ready + random-label. After DELETE(gtw/ready),
      // POST(label) sets the target. For gtw/wip, a recheck GET is also made.
      const operations = [];
      let idx = 0;

      // Call counts after always-POST change:
      // gtw/ready: GET + POST → 2 calls (no DELETE, no recheck)
      // gtw/lgtm/revise/stuck: GET + DELETE + POST → 3 calls
      // gtw/wip: GET + DELETE + POST + recheck GET → 4 calls
      const isReady = label === 'gtw/ready';
      const isWip = label === 'gtw/wip';

      const handlers = [
        async () => {
          operations.push(`GET #${++idx}`);
          return [{ name: 'gtw/ready' }, { name: 'random-label' }];
        },
        // DELETE gtw/ready (always removed — it's the only other gtw label present)
        ...(isReady ? [] : [
          async () => { operations.push(`DELETE #${++idx}`); return {}; },
        ]),
        // POST new label — always, no alreadyHas skip
        async () => { operations.push(`POST #${++idx}`); return {}; },
        // GET recheck for gtw/wip claim
        ...(isWip ? [
          async () => {
            operations.push(`GET-recheck #${++idx}`);
            return [{ name: label }]; // gtw/ready removed, gtw/wip added
          },
        ] : []),
      ];

      const totalCalls = handlers.length;

      const result = await setPrLabel(
        { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
        label,
        makeMockApi(handlers),
      );

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.preempted, false);
      assert.strictEqual(result.label, label);
      assert.strictEqual(
        operations.length,
        totalCalls,
        `Expected ${totalCalls} calls, got: ${operations.join(' → ')}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// AC2: atomicity — network error aborts without state pollution
// ---------------------------------------------------------------------------

describe('setPrLabel: atomicity — network error aborts (AC2)', () => {
  it('throws if removing a label fails with non-404 error', async () => {
    const handlers = [
      async () => [{ name: 'gtw/ready' }],
      async () => {
        throw new Error('GitHub API 500: Internal Server Error');
      },
    ];

    await assert.rejects(
      async () =>
        setPrLabel(
          { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
          'gtw/wip',
          makeMockApi(handlers),
        ),
      /Failed to remove label "gtw\/ready".+Aborting/,
    );
  });

  it('throws if setting the target label fails', async () => {
    let postAttempted = false;
    const handlers = [
      async () => [{ name: 'gtw/ready' }],
      async () => { /* DELETE succeeds */ return {}; },
      async () => {
        postAttempted = true;
        throw new Error('GitHub API 403: Forbidden');
      },
    ];

    await assert.rejects(
      async () =>
        setPrLabel(
          { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
          'gtw/wip',
          makeMockApi(handlers),
        ),
      /Failed to set label "gtw\/wip".+Aborting/,
    );
    assert.strictEqual(postAttempted, true);
  });

  it('aborts after DELETE+POST failure without further side-effects', async () => {
    const ops = [];
    const handlers = [
      async () => {
        ops.push('GET'); return [{ name: 'gtw/ready' }];
      },
      async () => {
        ops.push('DELETE'); return {}; // removal succeeds
      },
      async () => {
        ops.push('POST'); throw new Error('network error'); // POST fails
      },
    ];

    await assert.rejects(
      async () =>
        setPrLabel(
          { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
          'gtw/wip',
          makeMockApi(handlers),
        ),
      /Aborting/,
    );

    // GET → DELETE (ok) → POST (fails) — no further calls
    assert.deepStrictEqual(ops, ['GET', 'DELETE', 'POST']);
  });

  it('throws if initial GET fails', async () => {
    await assert.rejects(
      async () =>
        setPrLabel(
          { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
          'gtw/lgtm',
          makeMockApi([async () => { throw new Error('ENOTFOUND DNS lookup failed'); }]),
        ),
      /ENOTFOUND/,
    );
  });
});

// ---------------------------------------------------------------------------
// AC3: concurrency safe — gtw/wip preemption triggers rollback
// ---------------------------------------------------------------------------

describe('setPrLabel: concurrency — gtw/wip preemption with rollback (AC3)', () => {
  it('gtw/wip: if gtw/ready still present after claim, rolls back and returns preempted=true', async () => {
    const ops = [];
    const handlers = [
      // GET #1: current labels
      async () => {
        ops.push('GET#1'); return [{ name: 'gtw/ready' }];
      },
      // DELETE gtw/ready
      async () => { ops.push('DELETE-gtw/ready'); return {}; },
      // POST gtw/wip
      async () => { ops.push('POST-gtw/wip'); return {}; },
      // GET #2 (recheck): gtw/ready STILL present → preempted
      async () => {
        ops.push('GET#2-recheck'); return [{ name: 'gtw/ready' }];
      },
      // Rollback: DELETE gtw/wip
      async () => { ops.push('DELETE-gtw/wip-rollback'); return {}; },
      // Rollback: POST gtw/ready
      async () => { ops.push('POST-gtw/ready-restore'); return {}; },
    ];

    const result = await setPrLabel(
      { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
      'gtw/wip',
      makeMockApi(handlers),
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.preempted, true);
    assert.strictEqual(result.label, 'gtw/wip');
    assert.deepStrictEqual(ops, [
      'GET#1',
      'DELETE-gtw/ready',
      'POST-gtw/wip',
      'GET#2-recheck',
      'DELETE-gtw/wip-rollback',
      'POST-gtw/ready-restore',
    ]);
  });

  it('gtw/wip: if gtw/ready is gone after claim, no rollback, returns preempted=false', async () => {
    const ops = [];
    const handlers = [
      async () => { ops.push('GET#1'); return [{ name: 'gtw/ready' }]; },
      async () => { ops.push('DELETE-gtw/ready'); return {}; },
      async () => { ops.push('POST-gtw/wip'); return {}; },
      // Recheck: gtw/ready is GONE → claim succeeded cleanly
      async () => { ops.push('GET#2-recheck'); return [{ name: 'gtw/wip' }]; },
    ];

    const result = await setPrLabel(
      { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
      'gtw/wip',
      makeMockApi(handlers),
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.preempted, false);
    assert.strictEqual(result.label, 'gtw/wip');
    // No rollback DELETE/POST for gtw/wip
    assert.ok(!ops.some((op) => op.includes('rollback')), 'Should not rollback');
  });

  it('non-gtw/wip labels skip the concurrency re-check entirely', async () => {
    for (const label of ['gtw/ready', 'gtw/lgtm', 'gtw/revise', 'gtw/stuck']) {
      const ops = [];
      const handlers = [
        async () => { ops.push('GET'); return [{ name: 'gtw/wip' }]; }, // different label present
        async () => { ops.push('DELETE-gtw/wip'); return {}; },
        async () => { ops.push('POST'); return {}; },
      ];

      const result = await setPrLabel(
        { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
        label,
        makeMockApi(handlers),
      );

      assert.strictEqual(result.ok, true, `${label}: should succeed`);
      assert.strictEqual(result.preempted, false, `${label}: should not preempt`);
      // Only GET + DELETE + POST — no recheck GET
      assert.strictEqual(ops.filter((op) => op === 'GET').length, 1, `${label}: exactly 1 GET`);
    }
  });

  it('rollback DELETE 404 is tolerated (label already gone in race)', async () => {
    const handlers = [
      async () => [{ name: 'gtw/ready' }],
      async () => { /* DELETE gtw/ready ok */ return {}; },
      async () => { /* POST gtw/wip ok */ return {}; },
      async () => [{ name: 'gtw/ready' }], // recheck: still there
      async () => { throw new Error('404 Label not found'); }, // rollback DELETE gtw/wip → 404, tolerated
      async () => { /* POST gtw/ready restore ok */ return {}; },
    ];

    const result = await setPrLabel(
      { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
      'gtw/wip',
      makeMockApi(handlers),
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.preempted, true);
  });

  it('throws if rollback POST fails (state ambiguous — must not silently continue)', async () => {
    let rollbackDeleteDone = false;
    const handlers = [
      async () => [{ name: 'gtw/ready' }],
      async () => { /* DELETE gtw/ready ok */ return {}; },
      async () => { /* POST gtw/wip ok */ return {}; },
      async () => [{ name: 'gtw/ready' }], // recheck: preempted
      async () => { rollbackDeleteDone = true; return {}; }, // rollback DELETE gtw/wip
      async () => { throw new Error('GitHub API 500: Rollback failed'); }, // rollback POST gtw/ready FAILS
    ];

    await assert.rejects(
      async () =>
        setPrLabel(
          { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
          'gtw/wip',
          makeMockApi(handlers),
        ),
      /Rollback failed.*State ambiguous/,
    );
    assert.strictEqual(rollbackDeleteDone, true);
  });

  it('throws if rollback DELETE fails with non-404 error (state ambiguous)', async () => {
    const handlers = [
      async () => [{ name: 'gtw/ready' }],
      async () => { /* DELETE gtw/ready ok */ return {}; },
      async () => { /* POST gtw/wip ok */ return {}; },
      async () => [{ name: 'gtw/ready' }], // recheck: preempted
      async () => { throw new Error('GitHub API 500: Internal Server Error'); }, // rollback DELETE fails
    ];

    await assert.rejects(
      async () =>
        setPrLabel(
          { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
          'gtw/wip',
          makeMockApi(handlers),
        ),
      /Rollback failed.*State ambiguous/,
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid label
// ---------------------------------------------------------------------------

describe('setPrLabel: invalid label rejects cleanly', () => {
  it('throws for a non-gtw label string', async () => {
    await assert.rejects(
      async () =>
        setPrLabel(
          { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
          'random-label',
          async () => {},
        ),
      /Invalid gtw label: random-label/,
    );
  });
});

// ---------------------------------------------------------------------------
// 404 during label removal is non-fatal (already gone)
// ---------------------------------------------------------------------------

describe('setPrLabel: 404 during removal is non-fatal', () => {
  it('404 on DELETE is tolerated (race: label already removed by another process)', async () => {
    const ops = [];
    const handlers = [
      async () => { ops.push('GET'); return [{ name: 'gtw/ready' }]; },
      async () => { ops.push('DELETE-404'); throw new Error('404 Label not found'); },
      async () => { ops.push('POST'); return {}; },
      // recheck GET for gtw/wip claim: gtw/ready gone, gtw/wip added
      async () => { ops.push('GET-recheck'); return [{ name: 'gtw/wip' }]; },
    ];

    const result = await setPrLabel(
      { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
      'gtw/wip',
      makeMockApi(handlers),
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.preempted, false);
    assert.strictEqual(result.label, 'gtw/wip');
    // Should have continued to POST after the 404 DELETE
    assert.deepStrictEqual(ops, ['GET', 'DELETE-404', 'POST', 'GET-recheck']);
  });
});

// ---------------------------------------------------------------------------
// Target label already present: no-op on POST
// ---------------------------------------------------------------------------

describe('setPrLabel: always POSTs target label (no alreadyHas skip)', () => {
  it('gtw/wip: always POSTs, then recheck', async () => {
    const ops = [];
    const handlers = [
      async () => { ops.push('GET'); return [{ name: 'gtw/wip' }]; }, // already has gtw/wip
      // No DELETE needed (gtw/wip === target)
      async () => { ops.push('POST'); return {}; }, // always POST
      async () => { ops.push('GET-recheck'); return [{ name: 'gtw/wip' }]; }, // recheck
    ];

    const result = await setPrLabel(
      { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
      'gtw/wip',
      makeMockApi(handlers),
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.preempted, false);
    assert.deepStrictEqual(ops, ['GET', 'POST', 'GET-recheck']);
  });

  it('non-wip label: always POSTs, no recheck', async () => {
    const ops = [];
    const handlers = [
      async () => { ops.push('GET'); return [{ name: 'gtw/lgtm' }]; },
      // No DELETE (gtw/lgtm === target)
      async () => { ops.push('POST'); return {}; }, // always POST
    ];

    const result = await setPrLabel(
      { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
      'gtw/lgtm',
      makeMockApi(handlers),
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.preempted, false);
    assert.deepStrictEqual(ops, ['GET', 'POST']);
  });
});

// ---------------------------------------------------------------------------
// isPR = false (issues, not PRs)
// ---------------------------------------------------------------------------

describe('setPrLabel: isPR=false uses issues endpoint', () => {
  it('uses /issues/ not /pulls/ when isPR=false', async () => {
    let capturedPath;

    await setPrLabel(
      { prNum: 42, repo: 'owner/repo', token: 'tok', isPR: false },
      'gtw/ready',
      async (method, path) => {
        capturedPath = path;
        if (method === 'GET') return [{ name: 'gtw/wip' }]; // not gtw/ready
        if (method === 'POST') return {};
        if (method === 'DELETE') return {};
        throw new Error(`Unexpected: ${method}`);
      },
    );

    assert.ok(
      capturedPath.includes('/issues/42/labels'),
      `Expected /issues/ path, got: ${capturedPath}`,
    );
    assert.ok(
      !capturedPath.includes('/pulls/'),
      `Should not use /pulls/ for issues, got: ${capturedPath}`,
    );
  });
});
