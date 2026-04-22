/**
 * Unit tests for ReviewCommand verdict/label logic consistency
 *
 * Tests cover the fix for issue #206:
 * "fix: align GTW review verdict and PR label with published comment"
 *
 * Key behavior:
 * - The verdict/label must be based solely on items.length and cleanups.length
 * - Error fields in detection results must NOT cause gtw/revise if findings are zero
 * - This ensures the published comment icons (☐️/❌) are always consistent with the label
 */

import { strict as assert } from 'assert';
import { computeReviewVerdict, computeReviewIcons } from '../commands/ReviewCommand.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('🧪 Testing ReviewCommand verdict/label consistency\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`❌ ${name}`);
    console.log(`   Error: ${e.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: No issues — comment shows ☑️, label gtw/lgtm, verdict APPROVED
// ---------------------------------------------------------------------------

test('No issues: verdict is APPROVED and label is gtw/lgtm', () => {
  const duplicateResults = { items: [], newFunctions: [] };
  const cleanupResults = { cleanups: [] };

  const result = computeReviewVerdict(duplicateResults, cleanupResults);

  assert.strictEqual(result.finalLabel, 'gtw/lgtm', 'Label should be gtw/lgtm');
  assert.strictEqual(result.verdictText, 'APPROVED', 'Verdict should be APPROVED');
  assert.strictEqual(result.totalReuseIssues, 0, 'totalReuseIssues should be 0');
  assert.strictEqual(result.totalCleanupIssues, 0, 'totalCleanupIssues should be 0');
});

test('No issues: comment icons are both ☑️', () => {
  const duplicateResults = { items: [], newFunctions: [] };
  const cleanupResults = { cleanups: [] };

  const icons = computeReviewIcons(duplicateResults, cleanupResults);

  assert.strictEqual(icons.reuseIcon, '☑️', 'Reuse icon should be ☑️');
  assert.strictEqual(icons.cleanupIcon, '☑️', 'Cleanup icon should be ☑️');
});

test('No issues: comment icons and label are consistent', () => {
  const duplicateResults = { items: [], newFunctions: [] };
  const cleanupResults = { cleanups: [] };

  const verdict = computeReviewVerdict(duplicateResults, cleanupResults);
  const icons = computeReviewIcons(duplicateResults, cleanupResults);

  // If icons are both ☑️, label must be gtw/lgtm
  if (icons.reuseIcon === '☑️' && icons.cleanupIcon === '☑️') {
    assert.strictEqual(verdict.finalLabel, 'gtw/lgtm', 'Label must be gtw/lgtm when icons are ☑️');
  }
});

// ---------------------------------------------------------------------------
// Scenario 2: Actual issues present — comment shows ❌, label gtw/revise, verdict CHANGES NEEDED
// ---------------------------------------------------------------------------

test('Reuse issues present: verdict is CHANGES NEEDED and label is gtw/revise', () => {
  const duplicateResults = {
    items: [
      {
        newFunc: 'foo',
        existingFunc: 'bar',
        verdict: 'duplicate',
        severity: 'high',
        reason: 'same functionality',
      },
    ],
    newFunctions: [{ name: 'foo' }],
  };
  const cleanupResults = { cleanups: [] };

  const result = computeReviewVerdict(duplicateResults, cleanupResults);

  assert.strictEqual(result.finalLabel, 'gtw/revise', 'Label should be gtw/revise');
  assert.strictEqual(result.verdictText, 'CHANGES NEEDED', 'Verdict should be CHANGES NEEDED');
  assert.strictEqual(result.totalReuseIssues, 1, 'totalReuseIssues should be 1');
  assert.strictEqual(result.totalCleanupIssues, 0, 'totalCleanupIssues should be 0');
});

test('Cleanup issues present: verdict is CHANGES NEEDED and label is gtw/revise', () => {
  const duplicateResults = { items: [], newFunctions: [] };
  const cleanupResults = {
    cleanups: [
      {
        symbol: 'unusedVar',
        file: 'test.js',
        severity: 'high',
        whyCleanup: 'unnecessary cleanup',
      },
    ],
  };

  const result = computeReviewVerdict(duplicateResults, cleanupResults);

  assert.strictEqual(result.finalLabel, 'gtw/revise', 'Label should be gtw/revise');
  assert.strictEqual(result.verdictText, 'CHANGES NEEDED', 'Verdict should be CHANGES NEEDED');
  assert.strictEqual(result.totalReuseIssues, 0, 'totalReuseIssues should be 0');
  assert.strictEqual(result.totalCleanupIssues, 1, 'totalCleanupIssues should be 1');
});

test('Both issues present: verdict is CHANGES NEEDED and label is gtw/revise', () => {
  const duplicateResults = {
    items: [{ newFunc: 'foo', verdict: 'duplicate', severity: 'low', reason: 'x' }],
    newFunctions: [],
  };
  const cleanupResults = {
    cleanups: [{ symbol: 'x', file: 'y', severity: 'low', whyCleanup: 'z' }],
  };

  const result = computeReviewVerdict(duplicateResults, cleanupResults);

  assert.strictEqual(result.finalLabel, 'gtw/revise', 'Label should be gtw/revise');
  assert.strictEqual(result.verdictText, 'CHANGES NEEDED', 'Verdict should be CHANGES NEEDED');
  assert.strictEqual(result.totalReuseIssues, 1, 'totalReuseIssues should be 1');
  assert.strictEqual(result.totalCleanupIssues, 1, 'totalCleanupIssues should be 1');
});

test('Issues present: comment icons are both ❌', () => {
  const duplicateResults = {
    items: [{ newFunc: 'foo', verdict: 'duplicate', severity: 'low', reason: 'x' }],
  };
  const cleanupResults = {
    cleanups: [{ symbol: 'x', file: 'y', severity: 'low', whyCleanup: 'z' }],
  };

  const icons = computeReviewIcons(duplicateResults, cleanupResults);

  assert.strictEqual(icons.reuseIcon, '❌', 'Reuse icon should be ❌');
  assert.strictEqual(icons.cleanupIcon, '❌', 'Cleanup icon should be ❌');
});

test('Issues present: comment icons and label are consistent', () => {
  const duplicateResults = {
    items: [{ newFunc: 'foo', verdict: 'duplicate', severity: 'low', reason: 'x' }],
  };
  const cleanupResults = { cleanups: [] };

  const verdict = computeReviewVerdict(duplicateResults, cleanupResults);
  const icons = computeReviewIcons(duplicateResults, cleanupResults);

  // If reuse icon is ❌, label must be gtw/revise
  if (icons.reuseIcon === '❌') {
    assert.strictEqual(verdict.finalLabel, 'gtw/revise', 'Label must be gtw/revise when reuse icon is ❌');
  }
});

// ---------------------------------------------------------------------------
// Scenario 3: Detection function errors but yields zero findings
// This is the key bug fix: error fields must NOT cause gtw/revise
// ---------------------------------------------------------------------------

test('detectReuse errors with zero findings: verdict is APPROVED (not CHANGES NEEDED)', () => {
  // This simulates: API timeout returns { error: "timeout", items: [], newFunctions: [] }
  const duplicateResults = { error: 'API timeout', items: [], newFunctions: [] };
  const cleanupResults = { cleanups: [] };

  const result = computeReviewVerdict(duplicateResults, cleanupResults);

  // BUG: Old code would set gtw/revise because duplicateResults.error was truthy
  // FIX: Should be gtw/lgtm because items.length === 0
  assert.strictEqual(result.finalLabel, 'gtw/lgtm', 'Label should be gtw/lgtm even with error');
  assert.strictEqual(result.verdictText, 'APPROVED', 'Verdict should be APPROVED even with error');
  assert.strictEqual(result.totalReuseIssues, 0, 'totalReuseIssues should be 0');
});

test('detectUnnecessaryCleanup errors with zero findings: verdict is APPROVED', () => {
  const duplicateResults = { items: [], newFunctions: [] };
  const cleanupResults = { error: 'Network error', cleanups: [], llmCandidates: [], skipped: [] };

  const result = computeReviewVerdict(duplicateResults, cleanupResults);

  assert.strictEqual(result.finalLabel, 'gtw/lgtm', 'Label should be gtw/lgtm even with error');
  assert.strictEqual(result.verdictText, 'APPROVED', 'Verdict should be APPROVED even with error');
  assert.strictEqual(result.totalCleanupIssues, 0, 'totalCleanupIssues should be 0');
});

test('Both detection functions error with zero findings: verdict is APPROVED', () => {
  const duplicateResults = { error: 'timeout', items: [], newFunctions: [] };
  const cleanupResults = { error: 'network', cleanups: [], llmCandidates: [], skipped: [] };

  const result = computeReviewVerdict(duplicateResults, cleanupResults);

  assert.strictEqual(result.finalLabel, 'gtw/lgtm', 'Label should be gtw/lgtm when both error with zero findings');
  assert.strictEqual(result.verdictText, 'APPROVED', 'Verdict should be APPROVED');
});

test('Error with zero findings: comment icons remain ☑️ (consistent with label)', () => {
  const duplicateResults = { error: 'timeout', items: [], newFunctions: [] };
  const cleanupResults = { error: 'network', cleanups: [] };

  const verdict = computeReviewVerdict(duplicateResults, cleanupResults);
  const icons = computeReviewIcons(duplicateResults, cleanupResults);

  // Both icons should be ☑️ because items.length and cleanups.length are 0
  assert.strictEqual(icons.reuseIcon, '☑️', 'Reuse icon should be ☑️');
  assert.strictEqual(icons.cleanupIcon, '☑️', 'Cleanup icon should be ☑️');
  // And label should match
  assert.strictEqual(verdict.finalLabel, 'gtw/lgtm', 'Label should be gtw/lgtm to match icons');
});

test('Error with actual findings also present: verdict is CHANGES NEEDED', () => {
  // Error occurred BUT there are also actual findings
  const duplicateResults = {
    error: 'partial failure',
    items: [{ newFunc: 'foo', verdict: 'duplicate', severity: 'high', reason: 'x' }],
    newFunctions: [],
  };
  const cleanupResults = { cleanups: [] };

  const result = computeReviewVerdict(duplicateResults, cleanupResults);

  // Error + findings = gtw/revise (correctly based on findings)
  assert.strictEqual(result.finalLabel, 'gtw/revise', 'Label should be gtw/revise when findings exist');
  assert.strictEqual(result.verdictText, 'CHANGES NEEDED', 'Verdict should be CHANGES NEEDED');
  assert.strictEqual(result.totalReuseIssues, 1, 'totalReuseIssues should be 1');
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('Null/undefined items treated as empty array', () => {
  const duplicateResults = { items: null };
  const cleanupResults = { cleanups: undefined };

  const result = computeReviewVerdict(duplicateResults, cleanupResults);

  assert.strictEqual(result.finalLabel, 'gtw/lgtm', 'Null/undefined items should be treated as empty');
  assert.strictEqual(result.totalReuseIssues, 0, 'Null items should count as 0');
  assert.strictEqual(result.totalCleanupIssues, 0, 'Undefined cleanups should count as 0');
});

test('Empty items arrays are distinct from missing items property', () => {
  const results1 = computeReviewVerdict({}, {});
  const results2 = computeReviewVerdict({ items: [] }, { cleanups: [] });

  // Both should be APPROVED
  assert.strictEqual(results1.finalLabel, 'gtw/lgtm');
  assert.strictEqual(results2.finalLabel, 'gtw/lgtm');
});

test('Low severity items still trigger gtw/revise (all items count)', () => {
  // Low severity items are shown in comment but don't appear in summary
  // The verdict should still be CHANGES NEEDED because items.length > 0
  const duplicateResults = {
    items: [{ newFunc: 'foo', verdict: 'pattern', severity: 'low', reason: 'anti-pattern' }],
  };
  const cleanupResults = { cleanups: [] };

  const result = computeReviewVerdict(duplicateResults, cleanupResults);

  // The issue says verdict is based on totals, so any item should trigger revise
  assert.strictEqual(result.finalLabel, 'gtw/revise', 'Any item (even low severity) should trigger revise');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(60));
console.log(`Tests completed: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
