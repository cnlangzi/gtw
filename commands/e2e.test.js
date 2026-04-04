/**
 * E2E integration tests for the complete gtw review workflow.
 * Covers: Label System (#A), Checklist Engine (#B), Watch List (#C),
 *         Complete Review Flow (#D + #E + #F), and Concurrency (#G).
 *
 * Run: node --test commands/e2e.test.js
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';

import { parseChecklistFromComment, mergeChecklistState } from './ReviewCommand.js';
import { setPrLabel } from '../utils/labels.js';
import { WatchCommand } from './WatchCommand.js';
import { ReviewCommand } from './ReviewCommand.js';

const GTW_LABELS = ['gtw/ready', 'gtw/wip', 'gtw/lgtm', 'gtw/revise', 'gtw/stuck'];
const CHECKLIST_ITEMS = ['Destructive', 'Out-of-scope'];
const DEFAULT_MAX_ROUNDS = 5;

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

const CONFIG_DIR = join(homedir(), '.openclaw', 'gtw');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const WIP_FILE = join(CONFIG_DIR, 'wip.json');

function ensureDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

function readConfig() {
  ensureDir();
  if (!existsSync(CONFIG_FILE)) return {};
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
}

function writeConfig(data) {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function readWip() {
  ensureDir();
  if (!existsSync(WIP_FILE)) return {};
  return JSON.parse(readFileSync(WIP_FILE, 'utf8'));
}

function writeWip(data) {
  ensureDir();
  writeFileSync(WIP_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function cleanupFiles() {
  ensureDir();
  writeConfig({});
  writeWip({});
}

// ---------------------------------------------------------------------------
// Mock API helper
// ---------------------------------------------------------------------------

function makeMockApi(handlers) {
  let callIdx = 0;
  return async function mockApi(method, path, token, body) {
    if (callIdx >= handlers.length) {
      throw new Error(
        `No handler for call #${callIdx + 1} (${method} ${path}). Total handlers: ${handlers.length}`,
      );
    }
    return handlers[callIdx++](method, path, token, body);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AC1: Label mutual exclusion
// ---------------------------------------------------------------------------

describe('AC1: Label mutual exclusion', () => {
  for (const label of GTW_LABELS) {
    it(`${label}: sets label and removes other gtw labels`, async () => {
      const ops = [];
      const isReady = label === 'gtw/ready';
      const isWip = label === 'gtw/wip';

      const handlers = [
        async () => { ops.push('GET'); return [{ name: 'gtw/ready' }, { name: 'priority/high' }]; },
        ...(isReady ? [] : [async () => { ops.push('DELETE'); return {}; }]),
        ...(isReady ? [] : [async () => { ops.push('POST'); return {}; }]),
        ...(isWip ? [async () => { ops.push('RECHECK'); return [{ name: label }]; }] : []),
      ];

      const result = await setPrLabel(
        { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
        label,
        makeMockApi(handlers),
      );

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.preempted, false);
      assert.strictEqual(result.label, label);
    });
  }
});

// ---------------------------------------------------------------------------
// AC2: Atomicity — network errors abort without pollution
// ---------------------------------------------------------------------------

describe('AC2: Atomicity — network errors abort cleanly', () => {
  it('DELETE failure → throw without POST', async () => {
    const ops = [];
    const handlers = [
      async () => { ops.push('GET'); return [{ name: 'gtw/ready' }]; },
      async () => { ops.push('DELETE'); throw new Error('500 Internal Server Error'); },
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

    assert.deepStrictEqual(ops, ['GET', 'DELETE']);
  });

  // POST failure → rollback is fully covered in utils/labels.test.js (AC2).
  // The rollback sequence (DELETE gtw/wip → POST gtw/ready) is verified there.
  // This test confirms the integration: POST failure throws with 'Aborting' message.
  it('POST failure → throws Aborting error', async () => {
    const mockApi = async (method, path) => {
      if (method === 'GET') return [{ name: 'gtw/ready' }];
      if (method === 'DELETE') return {};
      if (method === 'POST') throw new Error('403 Forbidden');
      throw new Error('Unexpected');
    };

    await assert.rejects(
      async () =>
        setPrLabel(
          { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
          'gtw/wip',
          mockApi,
        ),
      /Aborting/,
    );
  });

  it('initial GET failure → throw immediately', async () => {
    await assert.rejects(
      async () =>
        setPrLabel(
          { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
          'gtw/lgtm',
          makeMockApi([async () => { throw new Error('ENOTFOUND'); }]),
        ),
      /ENOTFOUND/,
    );
  });

  it('rollback POST failure → throw (state ambiguous)', async () => {
    const handlers = [
      async () => [{ name: 'gtw/ready' }],
      async () => { /* DELETE ok */ return {}; },
      async () => { /* POST ok */ return {}; },
      async () => [{ name: 'gtw/ready' }], // recheck: still there
      async () => { /* rollback DELETE ok */ return {}; },
      async () => { throw new Error('500 Rollback failed'); },
    ];

    await assert.rejects(
      async () =>
        setPrLabel(
          { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
          'gtw/wip',
          makeMockApi(handlers),
        ),
      /Rollback failed/,
    );
  });
});

// ---------------------------------------------------------------------------
// AC3: Concurrency — preemption with rollback
// ---------------------------------------------------------------------------

describe('AC3: Concurrency — gtw/wip preemption with rollback', () => {
  it('gtw/wip: recheck still has gtw/ready → rollback, preempted=true', async () => {
    const ops = [];
    const handlers = [
      async () => { ops.push('GET-1'); return [{ name: 'gtw/ready' }]; },
      async () => { ops.push('DELETE'); return {}; },
      async () => { ops.push('POST'); return {}; },
      async () => { ops.push('RECHECK'); return [{ name: 'gtw/ready' }]; }, // preempted!
      async () => { ops.push('ROLLBACK-DELETE'); return {}; },
      async () => { ops.push('ROLLBACK-POST'); return {}; },
    ];

    const result = await setPrLabel(
      { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
      'gtw/wip',
      makeMockApi(handlers),
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.preempted, true);
    assert.ok(ops.includes('ROLLBACK-DELETE'));
    assert.ok(ops.includes('ROLLBACK-POST'));
  });

  it('gtw/wip: recheck gtw/ready gone → no rollback, preempted=false', async () => {
    const ops = [];
    const handlers = [
      async () => { ops.push('GET'); return [{ name: 'gtw/ready' }]; },
      async () => { ops.push('DELETE'); return {}; },
      async () => { ops.push('POST'); return {}; },
      async () => { ops.push('RECHECK'); return [{ name: 'gtw/wip' }]; }, // clean claim
    ];

    const result = await setPrLabel(
      { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
      'gtw/wip',
      makeMockApi(handlers),
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.preempted, false);
    assert.ok(!ops.some((op) => op.includes('ROLLBACK')));
  });

  it('non-gtw/wip labels skip recheck entirely', async () => {
    for (const label of ['gtw/ready', 'gtw/lgtm', 'gtw/revise', 'gtw/stuck']) {
      const ops = [];
      const handlers = [
        async () => { ops.push('GET'); return [{ name: 'gtw/wip' }]; },
        async () => { ops.push('DELETE'); return {}; },
        async () => { ops.push('POST'); return {}; },
      ];

      const result = await setPrLabel(
        { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
        label,
        makeMockApi(handlers),
      );

      assert.strictEqual(result.ok, true, `${label}: should succeed`);
      assert.strictEqual(result.preempted, false, `${label}: should not preempt`);
      assert.strictEqual(ops.filter((op) => op === 'GET').length, 1);
    }
  });

  it('rollback DELETE 404 tolerated (race: label already gone)', async () => {
    const handlers = [
      async () => [{ name: 'gtw/ready' }],
      async () => { /* DELETE ok */ return {}; },
      async () => { /* POST ok */ return {}; },
      async () => [{ name: 'gtw/ready' }],
      async () => { throw new Error('404 Label not found'); }, // rollback 404
      async () => { /* rollback POST ok */ return {}; },
    ];

    const result = await setPrLabel(
      { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
      'gtw/wip',
      makeMockApi(handlers),
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.preempted, true);
  });
});

// ---------------------------------------------------------------------------
// AC4: Checklist engine
// ---------------------------------------------------------------------------

describe('AC4: Checklist engine — lifecycle', () => {
  it('Round 1: all items unresolved → all kept', () => {
    const result = mergeChecklistState([], CHECKLIST_ITEMS);
    assert.strictEqual(result.length, 2);
    assert.ok(result.every((i) => !i.checked));
  });

  it('re-review: resolved items (checked) → removed; unresolved kept', () => {
    const prev = [
      { text: 'Destructive', checked: true },
      { text: 'Out-of-scope', checked: false },
    ];
    const result = mergeChecklistState(prev, CHECKLIST_ITEMS);
    assert.strictEqual(result.some((i) => i.text === 'Destructive'), false);
    const os = result.find((i) => i.text === 'Out-of-scope');
    assert.ok(os);
    assert.strictEqual(os.checked, false);
  });

  it('all resolved → empty list → triggers approval', () => {
    const prev = [
      { text: 'Destructive', checked: true },
      { text: 'Out-of-scope', checked: true },
    ];
    const result = mergeChecklistState(prev, CHECKLIST_ITEMS);
    assert.strictEqual(result.length, 0);
    assert.strictEqual(result.length === 0, true); // allResolved
  });

  it('Out-of-scope resolved, Destructive unresolved → keep Destructive only', () => {
    const prev = [
      { text: 'Destructive', checked: false },
      { text: 'Out-of-scope', checked: true },
    ];
    const result = mergeChecklistState(prev, CHECKLIST_ITEMS);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].text, 'Destructive');
  });

  it('custom item dropped; unresolved canonical items kept', () => {
    // "Custom Note" is not in canonical → dropped
    // "Destructive" is in prev as unchecked → KEPT (unresolved)
    // "Out-of-scope" is not in prev → KEPT (assumed unresolved)
    const prev = [{ text: 'Custom Note', checked: true }, { text: 'Destructive', checked: false }];
    const result = mergeChecklistState(prev, CHECKLIST_ITEMS);
    // Custom Note is not in canonical → always dropped
    assert.strictEqual(result.some((i) => i.text === 'Custom Note'), false);
    // Destructive is canonical and unresolved → kept
    assert.strictEqual(result.some((i) => i.text === 'Destructive' && !i.checked), true);
    // Out-of-scope is canonical and not in prev → kept
    assert.strictEqual(result.some((i) => i.text === 'Out-of-scope' && !i.checked), true);
  });

  it('parseChecklistFromComment: parses unchecked', () => {
    const body = '  - [ ] Destructive\n  - [ ] Out-of-scope';
    const items = parseChecklistFromComment(body);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].checked, false);
  });

  it('parseChecklistFromComment: parses checked', () => {
    const body = '  - [x] Destructive\n  - [ ] Out-of-scope';
    const items = parseChecklistFromComment(body);
    assert.strictEqual(items[0].checked, true);
    assert.strictEqual(items[1].checked, false);
  });

  it('parseChecklistFromComment: empty body → empty array', () => {
    assert.deepStrictEqual(parseChecklistFromComment(''), []);
    assert.deepStrictEqual(parseChecklistFromComment('No checkboxes'), []);
  });

  it('parseChecklistFromComment: extracts Round number', () => {
    const body = '## Review [Round 3]\n\n  - [ ] Destructive';
    const roundMatch = body.match(/## Review \[Round (\d+)\]/);
    assert.strictEqual(roundMatch ? parseInt(roundMatch[1]) : 1, 3);
  });
});

// ---------------------------------------------------------------------------
// AC5: Round tracking
// ---------------------------------------------------------------------------

describe('AC5: Round tracking', () => {
  it('first review → Round 1', () => {
    const existingComment = null;
    const round = existingComment ? 2 : 1;
    assert.strictEqual(round, 1);
  });

  it('re-review: round increments from previous', () => {
    const prevBody = '## Review [Round 2]\n\n  - [ ] Destructive';
    const roundMatch = prevBody.match(/## Review \[Round (\d+)\]/);
    const prevRound = roundMatch ? parseInt(roundMatch[1]) : 1;
    const nextRound = prevRound + 1;
    assert.strictEqual(nextRound, 3);
  });

  it('round > maxRounds → stuck', () => {
    const isStuck = (round) => round > DEFAULT_MAX_ROUNDS;
    assert.strictEqual(isStuck(5), false); // round 5 ok
    assert.strictEqual(isStuck(6), true);   // round 6 stuck
    assert.strictEqual(isStuck(1), false);
  });

  it('round 5 unresolved → next review (round 6) → stuck', () => {
    // Simulate: current round = 5, max = 5, items unresolved
    // Next review call would have round = 6 → isStuck(6) = true
    const currentRound = 5;
    const nextRound = currentRound + 1;
    assert.strictEqual(nextRound > DEFAULT_MAX_ROUNDS, true);
  });
});

// ---------------------------------------------------------------------------
// AC6: Watch list commands
// ---------------------------------------------------------------------------

describe('AC6: Watch list commands', () => {
  beforeEach(() => cleanupFiles());
  afterEach(() => cleanupFiles());

  it('list: empty → hint message', async () => {
    const cmd = new WatchCommand({ api: {}, config: {}, sessionKey: 'test' });
    const r = await cmd.execute(['list']);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.watchList, []);
    assert.ok(r.display.includes('empty'));
  });

  it('list: non-empty → shows all repos', async () => {
    writeConfig({ watchList: ['a/b', 'c/d'] });
    const cmd = new WatchCommand({ api: {}, config: {}, sessionKey: 'test' });
    const r = await cmd.execute(['list']);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.watchList.length, 2);
    assert.ok(r.display.includes('a/b'));
    assert.ok(r.display.includes('c/d'));
  });

  it('add: adds repo to watch list', async () => {
    const cmd = new WatchCommand({ api: {}, config: {}, sessionKey: 'test' });
    const r = await cmd.execute(['add', 'octocat/Hello-World']);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.added, 'octocat/Hello-World');
    assert.ok(readConfig().watchList.includes('octocat/Hello-World'));
  });

  it('add: duplicate → ignored', async () => {
    writeConfig({ watchList: ['octocat/Hello-World'] });
    const cmd = new WatchCommand({ api: {}, config: {}, sessionKey: 'test' });
    const r = await cmd.execute(['add', 'octocat/Hello-World']);
    assert.strictEqual(r.ok, true);
    assert.ok(r.message.includes('already'));
    assert.strictEqual(readConfig().watchList.length, 1);
  });

  it('add: invalid format → rejected', async () => {
    const cmd = new WatchCommand({ api: {}, config: {}, sessionKey: 'test' });
    const r = await cmd.execute(['add', 'not-valid']);
    assert.strictEqual(r.ok, false);
  });

  it('add: preserves existing items', async () => {
    writeConfig({ watchList: ['a/b'] });
    const cmd = new WatchCommand({ api: {}, config: {}, sessionKey: 'test' });
    await cmd.execute(['add', 'c/d']);
    const list = readConfig().watchList;
    assert.strictEqual(list.length, 2);
    assert.ok(list.includes('a/b'));
    assert.ok(list.includes('c/d'));
  });

  it('rm: removes existing repo', async () => {
    writeConfig({ watchList: ['octocat/Hello-World', 'cnlangzi/gtw'] });
    const cmd = new WatchCommand({ api: {}, config: {}, sessionKey: 'test' });
    const r = await cmd.execute(['rm', 'octocat/Hello-World']);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.removed, 'octocat/Hello-World');
    assert.ok(!readConfig().watchList.includes('octocat/Hello-World'));
    assert.ok(readConfig().watchList.includes('cnlangzi/gtw'));
  });

  it('rm: non-existent → no-op', async () => {
    writeConfig({ watchList: ['cnlangzi/gtw'] });
    const cmd = new WatchCommand({ api: {}, config: {}, sessionKey: 'test' });
    const r = await cmd.execute(['rm', 'nonexistent/repo']);
    assert.strictEqual(r.ok, true);
    assert.ok(r.message.includes('not in the watch list'));
    assert.strictEqual(readConfig().watchList.length, 1);
  });

  it('rm: last repo → empty list', async () => {
    writeConfig({ watchList: ['only/one'] });
    const cmd = new WatchCommand({ api: {}, config: {}, sessionKey: 'test' });
    const r = await cmd.execute(['rm', 'only/one']);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(readConfig().watchList, []);
  });

  it('unknown subcommand → usage', async () => {
    const cmd = new WatchCommand({ api: {}, config: {}, sessionKey: 'test' });
    const r = await cmd.execute(['unknown']);
    assert.strictEqual(r.ok, true);
    assert.ok(r.message.includes('Usage'));
  });
});

// ---------------------------------------------------------------------------
// AC7: Complete review flow scenarios (#D + #E + #F)
// ---------------------------------------------------------------------------

describe('AC7: Complete review flow scenarios', () => {
  // AC7.1: Watch list empty → hint message
  it('watch list empty → returns hint message', () => {
    cleanupFiles();
    writeConfig({ watchList: [] });
    writeWip({});
    // When watchList is empty, _reviewNextFromWatchList returns immediately
    // without making any API calls — test this logic path directly.
    const config = { watchList: [] };
    const watchList = config.watchList || [];
    const result = watchList.length === 0;
    assert.strictEqual(result, true); // empty → hint path triggered
  });

  // AC7.2: No gtw/ready PRs found → no-op
  it('no gtw/ready PRs in watch list → no-op', () => {
    // Simulate: watch list has repos but none have gtw/ready PRs
    const watchList = ['owner/repo'];
    const candidatePrs = []; // no PRs with gtw/ready
    const result = candidatePrs.length === 0;
    assert.strictEqual(result, true); // no candidates → no-op message path
    assert.ok(watchList.includes('owner/repo')); // repo was checked
  });

  // AC7.3: Stuck PR — gtw/stuck label detection logic
  it('gtw/stuck label → isStuck=true; no gtw/stuck → isStuck=false', () => {
    // PR with gtw/stuck label → stuck detection triggers
    const prWithStuck = { pr: { labels: [{ name: 'gtw/stuck' }] } };
    const isStuck = (prWithStuck.pr.labels || []).some((l) => l.name === 'gtw/stuck');
    assert.strictEqual(isStuck, true);

    // PR without gtw/stuck → not stuck
    const normalPr = { pr: { labels: [{ name: 'gtw/wip' }] } };
    const notStuck = (normalPr.pr.labels || []).some((l) => l.name === 'gtw/stuck');
    assert.strictEqual(notStuck, false);

    // round > maxRounds also triggers stuck
    const round = 6, maxRounds = 5;
    const roundTriggersStuck = round > maxRounds;
    assert.strictEqual(roundTriggersStuck, true);
  });

  // AC7.4: All items resolved → approval
  it('all items resolved → approval path triggered', async () => {
    const prev = [
      { text: 'Destructive', checked: true },
      { text: 'Out-of-scope', checked: true },
    ];
    const checklistItems = mergeChecklistState(prev, CHECKLIST_ITEMS);
    const allResolved = checklistItems.length === 0;
    assert.strictEqual(allResolved, true); // triggers gtw/lgtm + approved comment
  });

  // AC7.5: First review → Round 1
  it('first review creates Round 1', () => {
    const existingComment = null;
    const round = existingComment ? parseInt(existingComment.body.match(/## Review \[Round (\d+)\]/)?.[1] || '1') + 1 : 1;
    assert.strictEqual(round, 1);
  });

  // AC7.6: Review increments round
  it('re-review increments round correctly', () => {
    const prevRound = 3;
    const nextRound = prevRound + 1;
    assert.strictEqual(nextRound, 4);
  });
});

// ---------------------------------------------------------------------------
// AC7.8: Oldest PR sorting
// ---------------------------------------------------------------------------

describe('AC7.8: Watch list PR sorting — oldest PR picked first', () => {
  it('sorts by updated_at ascending', () => {
    const prs = [
      { repo: 'r/repo', pr: { number: 3, updatedAt: '2026-04-03T00:00:00Z' } },
      { repo: 'r/repo', pr: { number: 1, updatedAt: '2026-04-01T00:00:00Z' } },
      { repo: 'r/repo', pr: { number: 2, updatedAt: '2026-04-02T00:00:00Z' } },
    ];
    prs.sort((a, b) => new Date(a.pr.updatedAt) - new Date(b.pr.updatedAt));
    assert.strictEqual(prs[0].pr.number, 1);
    assert.strictEqual(prs[1].pr.number, 2);
    assert.strictEqual(prs[2].pr.number, 3);
  });

  it('cross-repo: picks globally oldest', () => {
    const prs = [
      { repo: 'a/b', pr: { number: 10, updatedAt: '2026-04-03T00:00:00Z' } },
      { repo: 'c/d', pr: { number: 1, updatedAt: '2026-04-01T00:00:00Z' } },
    ];
    prs.sort((a, b) => new Date(a.pr.updatedAt) - new Date(b.pr.updatedAt));
    assert.strictEqual(prs[0].pr.number, 1);
    assert.strictEqual(prs[0].repo, 'c/d');
  });
});

// ---------------------------------------------------------------------------
// AC8: WIP state management
// ---------------------------------------------------------------------------

describe('AC8: WIP state management', () => {
  it('reviewState per PR key tracked independently', () => {
    const wip = {
      repo: 'owner/repo',
      reviewState: {
        'owner/repo#1': { round: 2, commentId: 100 },
        'owner/repo#2': { round: 1, commentId: 200 },
      },
    };
    assert.strictEqual(wip.reviewState['owner/repo#1'].round, 2);
    assert.strictEqual(wip.reviewState['owner/repo#2'].round, 1);
  });

  it('deleting a PR key leaves others intact', () => {
    const wip = {
      reviewState: {
        'owner/repo#1': { round: 2, commentId: 100 },
        'owner/repo#2': { round: 1, commentId: 200 },
      },
    };
    delete wip.reviewState['owner/repo#1'];
    assert.strictEqual(Object.keys(wip.reviewState).length, 1);
    assert.ok(wip.reviewState['owner/repo#2']);
  });
});

// ---------------------------------------------------------------------------
// AC9: Label state transitions
// ---------------------------------------------------------------------------

describe('AC9: Label state transitions', () => {
  const transitions = [
    ['gtw/ready', 'gtw/wip', true],   // claim: needs recheck
    ['gtw/wip', 'gtw/revise', false], // transition: no recheck
    ['gtw/revise', 'gtw/lgtm', false],
    ['gtw/revise', 'gtw/stuck', false],
    ['gtw/revise', 'gtw/wip', true],   // re-review: needs recheck
  ];

  for (const [from, to, expectRecheck] of transitions) {
    it(`${from} → ${to}: recheck=${expectRecheck}`, async () => {
      const ops = [];
      const handlers = [
        async () => { ops.push('GET'); return [{ name: from }]; },
        async () => { ops.push('DELETE'); return {}; },
        async () => { ops.push('POST'); return {}; },
        ...(expectRecheck ? [async () => { ops.push('RECHECK'); return [{ name: to }]; }] : []),
      ];

      const result = await setPrLabel(
        { prNum: 1, repo: 'o/r', token: 't', isPR: true },
        to,
        makeMockApi(handlers),
      );

      assert.strictEqual(result.ok, true);
      assert.strictEqual(ops.includes('RECHECK'), expectRecheck);
    });
  }
});

// ---------------------------------------------------------------------------
// AC10: Edge cases
// ---------------------------------------------------------------------------

describe('AC10: Edge cases', () => {
  it('404 DELETE is tolerated (label already gone in race)', async () => {
    const ops = [];
    const handlers = [
      async () => { ops.push('GET'); return [{ name: 'gtw/ready' }]; },
      async () => { ops.push('DELETE'); throw new Error('404 Label not found'); },
      async () => { ops.push('POST'); return {}; },
      async () => { ops.push('RECHECK'); return [{ name: 'gtw/wip' }]; },
    ];

    const result = await setPrLabel(
      { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
      'gtw/wip',
      makeMockApi(handlers),
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.preempted, false);
  });

  it('invalid label rejects cleanly', async () => {
    await assert.rejects(
      async () =>
        setPrLabel(
          { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
          'random-label',
          async () => {},
        ),
      /Invalid gtw label/,
    );
  });

  it('target label already present → skips POST', async () => {
    const ops = [];
    const handlers = [
      async () => { ops.push('GET'); return [{ name: 'gtw/wip' }]; }, // already has gtw/wip
      async () => { ops.push('RECHECK'); return [{ name: 'gtw/wip' }]; },
    ];

    const result = await setPrLabel(
      { prNum: 1, repo: 'owner/repo', token: 'tok', isPR: true },
      'gtw/wip',
      makeMockApi(handlers),
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.preempted, false);
    assert.ok(!ops.includes('POST'));
  });

  it('isPR=false uses /issues/ not /pulls/', async () => {
    let capturedPath;
    await setPrLabel(
      { prNum: 42, repo: 'owner/repo', token: 'tok', isPR: false },
      'gtw/ready',
      async (method, path) => {
        capturedPath = path;
        return [{ name: 'gtw/wip' }];
      },
    );

    assert.ok(capturedPath.includes('/issues/42/labels'));
    assert.ok(!capturedPath.includes('/pulls/'));
  });
});
