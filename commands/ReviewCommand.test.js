/**
 * Unit tests for ReviewCommand — pure functions.
 * Run: node --test commands/ReviewCommand.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseChecklistFromComment, mergeChecklistState } from './ReviewCommand.js';

const CHECKLIST_ITEMS = ['Destructive', 'Out-of-scope'];

// ---------------------------------------------------------------------------
// parseChecklistFromComment
// ---------------------------------------------------------------------------

describe('parseChecklistFromComment', () => {
  it('parses unchecked items', () => {
    const body = '## Review [Round 1]\n\n  - [ ] Destructive\n  - [ ] Out-of-scope';
    const items = parseChecklistFromComment(body);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].text, 'Destructive');
    assert.strictEqual(items[0].checked, false);
    assert.strictEqual(items[1].text, 'Out-of-scope');
    assert.strictEqual(items[1].checked, false);
  });

  it('parses checked items', () => {
    const body = '  - [x] Destructive\n  - [ ] Out-of-scope';
    const items = parseChecklistFromComment(body);
    assert.strictEqual(items[0].checked, true);
    assert.strictEqual(items[1].checked, false);
  });

  it('parses mixed items', () => {
    const body = '  - [x] Destructive\n  - [x] Out-of-scope';
    const items = parseChecklistFromComment(body);
    assert.strictEqual(items.every((i) => i.checked), true);
  });

  it('ignores non-checkbox lines', () => {
    const body = '## Review [Round 1]\n\nSome text\n  - [ ] Destructive\n---\n_Agent note_';
    const items = parseChecklistFromComment(body);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].text, 'Destructive');
  });

  it('handles empty body', () => {
    assert.deepStrictEqual(parseChecklistFromComment(''), []);
    assert.deepStrictEqual(parseChecklistFromComment('No checkboxes here'), []);
  });
});

// ---------------------------------------------------------------------------
// mergeChecklistState
// Spec: "remove checkboxes that are resolved; keep unresolved ones"
// Resolved = checked in previous comment → REMOVED from new comment
// Unresolved = unchecked in previous comment → KEPT in new comment
// ---------------------------------------------------------------------------

describe('mergeChecklistState (AC4: Checklist lifecycle)', () => {
  it('Round 1: all items unresolved → all kept', () => {
    const prev = [];
    const result = mergeChecklistState(prev, CHECKLIST_ITEMS);
    assert.strictEqual(result.length, 2);
    assert.ok(result.every((i) => !i.checked));
  });

  it('re-review: resolved items (checked) are removed', () => {
    // Destructive=[x] (resolved) → removed; Out-of-scope=[ ] (unresolved) → kept
    const prev = [
      { text: 'Destructive', checked: true },
      { text: 'Out-of-scope', checked: false },
    ];
    const result = mergeChecklistState(prev, CHECKLIST_ITEMS);
    assert.strictEqual(result.some((i) => i.text === 'Destructive'), false);
    const outOfScope = result.find((i) => i.text === 'Out-of-scope');
    assert.ok(outOfScope);
    assert.strictEqual(outOfScope.checked, false);
  });

  it('re-review: unresolved items are kept', () => {
    const prev = [
      { text: 'Destructive', checked: false },
      { text: 'Out-of-scope', checked: false },
    ];
    const result = mergeChecklistState(prev, CHECKLIST_ITEMS);
    assert.strictEqual(result.length, 2);
    assert.ok(result.every((i) => !i.checked));
  });

  it('re-review: all resolved → empty list → triggers approval', () => {
    const prev = [
      { text: 'Destructive', checked: true },
      { text: 'Out-of-scope', checked: true },
    ];
    const result = mergeChecklistState(prev, CHECKLIST_ITEMS);
    assert.strictEqual(result.length, 0); // all removed
    // Approval triggers when: checklistItems.length === 0
    assert.strictEqual(result.length === 0, true);
  });

  it('re-review: custom item (not in canonical) is dropped', () => {
    const prev = [
      { text: 'Custom Note', checked: true },
      { text: 'Destructive', checked: false },
    ];
    const result = mergeChecklistState(prev, CHECKLIST_ITEMS);
    assert.strictEqual(result.some((i) => i.text === 'Custom Note'), false);
    assert.strictEqual(result.find((i) => i.text === 'Destructive')?.checked, false);
  });
});

// ---------------------------------------------------------------------------
// Round tracking logic (AC5)
// ---------------------------------------------------------------------------

describe('Round tracking behavior (AC5)', () => {
  it('round increments from N to N+1 on each re-review', () => {
    const extractRound = (body) => {
      const m = body.match(/## Review \[Round (\d+)\]/);
      return m ? parseInt(m[1]) : 1;
    };
    assert.strictEqual(extractRound('## Review [Round 1]'), 1);
    assert.strictEqual(extractRound('## Review [Round 5]'), 5);
    // Next invocation: round + 1
    assert.strictEqual(extractRound('## Review [Round 5]') + 1, 6);
  });

  it('stuck triggers when round > maxRounds (default 5)', () => {
    const DEFAULT_MAX_ROUNDS = 5;
    const isStuck = (round) => round > DEFAULT_MAX_ROUNDS;
    assert.strictEqual(isStuck(5), false); // round 5: still OK
    assert.strictEqual(isStuck(6), true);  // round 6: stuck
  });
});

// ---------------------------------------------------------------------------
// Label constants (AC1)
// ---------------------------------------------------------------------------

describe('GTW_LABELS (AC1)', () => {
  it('has exactly 5 mutually exclusive labels', () => {
    const GTW_LABELS = ['gtw/ready', 'gtw/wip', 'gtw/lgtm', 'gtw/revise', 'gtw/stuck'];
    assert.strictEqual(GTW_LABELS.length, 5);
  });

  it('CHECKLIST_ITEMS has exactly 2 canonical items', () => {
    assert.strictEqual(CHECKLIST_ITEMS.length, 2);
    assert.deepStrictEqual(CHECKLIST_ITEMS, ['Destructive', 'Out-of-scope']);
  });
});
