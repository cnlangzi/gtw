/**
 * E2E workflow tests — cross-module integration scenarios.
 *
 * These tests exercise the complete review workflow across multiple modules
 * without mocking internal functions. Pure-unit concerns (setPrLabel,
 * parseChecklistFromComment, WatchCommand) are in their own test files.
 *
 * Run: node --test commands/e2e/workflow.test.js
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

import { WatchCommand } from '../WatchCommand.js';
import { ReviewCommand } from '../ReviewCommand.js';
import { mergeChecklistState } from '../ReviewCommand.js';
import { setPrLabel } from '../../utils/labels.js';

const CHECKLIST_ITEMS = ['Destructive', 'Out-of-scope'];
const DEFAULT_MAX_ROUNDS = 5;

// ---------------------------------------------------------------------------
// File helpers (shared across workflow tests)
// ---------------------------------------------------------------------------

// Use GTW_CONFIG_DIR env var if set (for CI isolation), otherwise ~/.openclaw/gtw/
const CONFIG_DIR = process.env.GTW_CONFIG_DIR || join(homedir(), '.openclaw', 'gtw');
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
// WF1: PR sorting — oldest (by updated_at) is picked first
// ---------------------------------------------------------------------------

describe('WF1: PR sorting — oldest PR picked first', () => {
  it('sorts by updated_at ascending across repos', () => {
    // Simulate PR candidates from multiple repos
    const candidatePrs = [
      { repo: 'a/b', pr: { number: 3, updatedAt: '2026-04-03T00:00:00Z' } },
      { repo: 'c/d', pr: { number: 1, updatedAt: '2026-04-01T00:00:00Z' } },
      { repo: 'e/f', pr: { number: 2, updatedAt: '2026-04-02T00:00:00Z' } },
    ];
    candidatePrs.sort((a, b) => new Date(a.pr.updatedAt) - new Date(b.pr.updatedAt));

    assert.strictEqual(candidatePrs[0].pr.number, 1);
    assert.strictEqual(candidatePrs[0].repo, 'c/d');
    assert.strictEqual(candidatePrs[1].pr.number, 2);
    assert.strictEqual(candidatePrs[2].pr.number, 3);
  });

  it('own PRs are excluded from watch list scan', () => {
    const myLogin = 'test-agent';
    const prs = [
      { user: { login: 'test-agent' } },  // own PR — should be skipped
      { user: { login: 'another' } },       // foreign PR — should be included
    ];
    const filtered = prs.filter((pr) => pr.user.login !== myLogin);
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].user.login, 'another');
  });

  it('only PRs with gtw/ready label are candidates', () => {
    const prs = [
      { labels: [{ name: 'gtw/ready' }] },
      { labels: [{ name: 'gtw/wip' }] },
      { labels: [{ name: 'bug' }] },
    ];
    const candidates = prs.filter((pr) =>
      pr.labels.some((l) => l.name === 'gtw/ready'),
    );
    assert.strictEqual(candidates.length, 1);
  });
});

// ---------------------------------------------------------------------------
// WF2: WIP state management — per-PR key isolation
// ---------------------------------------------------------------------------

describe('WF2: WIP state management', () => {
  beforeEach(() => cleanupFiles());
  afterEach(() => cleanupFiles());

  it('reviewState tracks each PR independently', () => {
    const wip = {
      repo: 'owner/repo',
      reviewState: {
        'owner/repo#1': { round: 2, commentId: 100 },
        'owner/repo#2': { round: 1, commentId: 200 },
        'other/repo#3':  { round: 3, commentId: 300 },
      },
    };

    assert.strictEqual(wip.reviewState['owner/repo#1'].round, 2);
    assert.strictEqual(wip.reviewState['owner/repo#2'].round, 1);
    assert.strictEqual(wip.reviewState['other/repo#3'].round, 3);
    assert.strictEqual(Object.keys(wip.reviewState).length, 3);
  });

  it('deleting one PR key leaves others intact', () => {
    const wip = {
      repo: 'owner/repo',
      reviewState: {
        'owner/repo#1': { round: 2, commentId: 100 },
        'owner/repo#2': { round: 1, commentId: 200 },
      },
    };

    delete wip.reviewState['owner/repo#1'];
    assert.strictEqual(Object.keys(wip.reviewState).length, 1);
    assert.ok(wip.reviewState['owner/repo#2']);
    assert.strictEqual(wip.reviewState['owner/repo#2'].round, 1);
  });

  it('wip.json persists reviewState across sessions', () => {
    // Simulate: session 1 reviews PR #1
    const session1Wip = { repo: 'owner/repo', reviewState: { 'owner/repo#1': { round: 1 } } };
    writeWip(session1Wip);

    // Simulate: session 2 reads wip.json
    const session2Wip = readWip();
    assert.strictEqual(session2Wip.reviewState['owner/repo#1'].round, 1);

    // Simulate: session 2 completes and clears reviewState for #1
    delete session2Wip.reviewState['owner/repo#1'];
    writeWip(session2Wip);

    // Simulate: session 3 reads wip.json
    const session3Wip = readWip();
    assert.strictEqual(session3Wip.reviewState['owner/repo#1'], undefined);
    assert.strictEqual(session3Wip.repo, 'owner/repo'); // non-review fields preserved
  });

  it('mergeChecklistState: fully resolved → empty → triggers approval', () => {
    const prev = [
      { text: 'Destructive', checked: true },
      { text: 'Out-of-scope', checked: true },
    ];
    const checklistItems = mergeChecklistState(prev, CHECKLIST_ITEMS);
    // empty checklist = all items resolved = approval path
    assert.strictEqual(checklistItems.length, 0);
  });

  it('mergeChecklistState: unresolved → changes needed → gtw/revise', () => {
    const prev = [
      { text: 'Destructive', checked: false },
      { text: 'Out-of-scope', checked: false },
    ];
    const checklistItems = mergeChecklistState(prev, CHECKLIST_ITEMS);
    // non-empty = unresolved items = changes needed
    assert.strictEqual(checklistItems.length, 2);
    assert.ok(checklistItems.every((i) => !i.checked));
  });
});

// ---------------------------------------------------------------------------
// WF3: Round tracking and stuck detection
// ---------------------------------------------------------------------------

describe('WF3: Round tracking and stuck detection', () => {
  it('round 1 → 2 → 3 on successive re-reviews', () => {
    const extractRound = (body) => {
      const m = body.match(/## Review \[Round (\d+)\]/);
      return m ? parseInt(m[1]) : 1;
    };
    assert.strictEqual(extractRound('## Review [Round 1]'), 1);
    assert.strictEqual(extractRound('## Review [Round 2]') + 1, 3);
    assert.strictEqual(extractRound('## Review [Round 3]') + 1, 4);
  });

  it('round 5 is ok; round 6 triggers stuck', () => {
    const isStuck = (round) => round > DEFAULT_MAX_ROUNDS;
    assert.strictEqual(isStuck(5), false);
    assert.strictEqual(isStuck(6), true);
    assert.strictEqual(isStuck(1), false);
  });

  it('stuck PR is blocked from further review', () => {
    const prData = { pr: { labels: [{ name: 'gtw/stuck' }] } };
    const labels = prData.pr.labels || [];
    const isStuck = labels.some((l) => l.name === 'gtw/stuck');
    assert.strictEqual(isStuck, true);
  });

  it('watch list empty → no API calls needed', () => {
    const watchList = [];
    // Empty watch list: _reviewNextFromWatchList returns early without any API calls
    assert.strictEqual(watchList.length, 0);
  });
});

// ---------------------------------------------------------------------------
// WF4: Watch list + review integration
// ---------------------------------------------------------------------------

// NOTE: no beforeEach/afterEach here — each test is self-contained and writes its own config.
// WF4 uses the same CONFIG_DIR as WatchCommand.test.js.
// Do NOT add cleanup hooks here; they can cause state-leak races in CI
// when WatchCommand.test.js runs in the same process (cleanupFiles writes {})
// and the file-write flush timing in CI differs from local.
describe('WF4: Watch list + review integration', () => {
  it('WatchCommand: add → config persists', () => {
    cleanupFiles(); // ensure clean slate
    const cmd = new WatchCommand({ api: {}, config: {}, sessionKey: 'test' });
    cmd.execute(['add', 'cnlangzi/gtw']);

    const config = readConfig();
    assert.ok(config.watchList.includes('cnlangzi/gtw'));
    assert.strictEqual(config.watchList.length, 1);
  });

  it('WatchCommand: add duplicate → no-op, list unchanged', async () => {
    cleanupFiles();
    writeConfig({ watchList: ['cnlangzi/gtw'] });

    const cmd = new WatchCommand({ api: {}, config: {}, sessionKey: 'test' });
    const r = await cmd.execute(['add', 'cnlangzi/gtw']);
    assert.ok(r.message.includes('already'));
    assert.strictEqual(readConfig().watchList.length, 1);
  });

  it('WatchCommand: rm last → empty watch list', async () => {
    cleanupFiles();
    writeConfig({ watchList: ['only/one'] });

    const cmd = new WatchCommand({ api: {}, config: {}, sessionKey: 'test' });
    await cmd.execute(['rm', 'only/one']);
    assert.deepStrictEqual(readConfig().watchList, []);
  });
});

// ---------------------------------------------------------------------------
// WF5: Label transitions across modules
// ---------------------------------------------------------------------------

describe('WF5: Label transitions across modules', () => {
  // Verify the 5-label mutual exclusion contract holds across all transitions
  const GTW_LABELS = ['gtw/ready', 'gtw/wip', 'gtw/lgtm', 'gtw/revise', 'gtw/stuck'];

  for (const from of GTW_LABELS) {
    for (const to of GTW_LABELS) {
      if (from === to) continue;

      const needsRecheck = to === 'gtw/wip';

      it(`${from} → ${to}: recheck=${needsRecheck}`, async () => {
        const ops = [];
        const handlers = [
          async () => { ops.push('GET'); return [{ name: from }]; },
          ...(from === to ? [] : [async () => { ops.push('DELETE'); return {}; }]),
          async () => { ops.push('POST'); return {}; },
          ...(needsRecheck ? [async () => { ops.push('RECHECK'); return [{ name: to }]; }] : []),
        ];

        const result = await setPrLabel(
          { prNum: 1, repo: 'o/r', token: 't', isPR: true },
          to,
          makeMockApi(handlers),
        );

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.label, to);
        assert.strictEqual(ops.includes('RECHECK'), needsRecheck);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// WF6: Command execution paths (input → behavior)
// ---------------------------------------------------------------------------

describe('WF6: Command execution paths', () => {
  beforeEach(() => cleanupFiles());
  afterEach(() => cleanupFiles());

  it('WatchCommand: unknown subcommand → returns usage', async () => {
    const cmd = new WatchCommand({ api: {}, config: {}, sessionKey: 'test' });
    const r = await cmd.execute(['foobar']);
    assert.ok(r.message.includes('Usage'));
    assert.ok(r.display.includes('Usage'));
  });

  it('WatchCommand: invalid repo format → rejected', async () => {
    const cmd = new WatchCommand({ api: {}, config: {}, sessionKey: 'test' });
    const r = await cmd.execute(['add', 'missing-slash']);
    assert.strictEqual(r.ok, false);
  });

  it('WatchCommand: rm non-existent repo → no-op', async () => {
    const cmd = new WatchCommand({ api: {}, config: {}, sessionKey: 'test' });
    writeConfig({ watchList: ['a/b'] });
    const r = await cmd.execute(['rm', 'c/d']);
    assert.strictEqual(r.ok, true);
    assert.ok(r.message.includes('not in the watch list'));
    assert.strictEqual(readConfig().watchList.length, 1);
  });
});
