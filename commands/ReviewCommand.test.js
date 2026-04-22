/**
 * Unit tests for ReviewCommand — _buildComment format
 * Run: node --test commands/ReviewCommand.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

// Import the module to test
// Since _buildComment is a private method, we test via the class instance
// We'll create a minimal mock to test _buildComment in isolation
import { ReviewCommand } from './ReviewCommand.js';

function createTestInstance() {
  // Create a minimal mock context
  const context = {
    sessionKey: 'test-session',
  };
  return new ReviewCommand(context);
}

describe('_buildComment', () => {
  const instance = createTestInstance();

  // Mock prData
  const mockPrData = {
    pr: {
      number: 202,
      title: 'Add new feature',
    },
    baseBranch: 'main',
  };

  it('generates comment with exact title "GTW Code Review"', () => {
    const results = { items: [], newFunctions: [] };
    const cleanupResults = { cleanups: [] };

    const comment = instance._buildComment(202, mockPrData, results, cleanupResults);

    assert.ok(comment.startsWith('## GTW Code Review'), 'Comment must start with "## GTW Code Review"');
    assert.strictEqual(comment.split('\n')[0], '## GTW Code Review');
  });

  it('contains no PR number, PR title, or base branch in body', () => {
    const results = { items: [], newFunctions: [] };
    const cleanupResults = { cleanups: [] };

    const comment = instance._buildComment(202, mockPrData, results, cleanupResults);

    // Should not contain PR title or base branch
    assert.ok(!comment.includes('Add new feature'), 'Should not contain PR title');
    assert.ok(!comment.includes('main'), 'Should not contain base branch "main"');
    assert.ok(!comment.includes('#202'), 'Should not contain PR number in body');
  });

  describe('no issues scenario', () => {
    it('shows ☑️ Reuse Review | ☑️ Cleanup Review when both have zero findings', () => {
      const results = { items: [], newFunctions: [] };
      const cleanupResults = { cleanups: [] };

      const comment = instance._buildComment(202, mockPrData, results, cleanupResults);

      assert.ok(comment.includes('☑️ Reuse Review | ☑️ Cleanup Review'), 'Should show checkmarks for both');
    });

    it('contains separator and reviewer tag', () => {
      const results = { items: [], newFunctions: [] };
      const cleanupResults = { cleanups: [] };

      const comment = instance._buildComment(202, mockPrData, results, cleanupResults);

      assert.ok(comment.includes('---'), 'Should contain separator');
      assert.ok(comment.includes('*Reviewed by gtw*'), 'Should contain reviewer tag');
    });

    it('does not contain zero-value statistics', () => {
      const results = { items: [], newFunctions: [] };
      const cleanupResults = { cleanups: [] };

      const comment = instance._buildComment(202, mockPrData, results, cleanupResults);

      assert.ok(!comment.includes('Functions analyzed:'), 'Should not contain Functions analyzed');
      assert.ok(!comment.includes('Duplicates found:'), 'Should not contain Duplicates found');
      assert.ok(!comment.includes('Unnecessary cleanups:'), 'Should not contain Unnecessary cleanups');
      assert.ok(!comment.includes('0'), 'Should not contain zero counts');
    });

    it('does not contain "No duplicates" or "No unnecessary cleanups" lines', () => {
      const results = { items: [], newFunctions: [] };
      const cleanupResults = { cleanups: [] };

      const comment = instance._buildComment(202, mockPrData, results, cleanupResults);

      assert.ok(!comment.includes('No duplicates'), 'Should not contain "No duplicates"');
      assert.ok(!comment.includes('No unnecessary cleanups'), 'Should not contain "No unnecessary cleanups"');
    });
  });

  describe('issues present scenario', () => {
    it('shows ❌ with count when reuse issues exist', () => {
      const results = {
        items: [
          {
            verdict: 'duplicate',
            severity: 'critical',
            newFunc: 'newFunc',
            existingFunc: 'existingFunc',
            existingFile: 'file.go',
            reason: 'exact match',
          },
        ],
        newFunctions: ['newFunc'],
      };
      const cleanupResults = { cleanups: [] };

      const comment = instance._buildComment(202, mockPrData, results, cleanupResults);

      assert.ok(comment.includes('❌ Reuse Review (1)'), 'Should show X with count for reuse');
      assert.ok(comment.includes('☑️ Cleanup Review'), 'Should show checkmark for cleanup');
    });

    it('shows ❌ with count when cleanup issues exist', () => {
      const results = { items: [], newFunctions: [] };
      const cleanupResults = {
        cleanups: [
          {
            severity: 'high',
            file: 'file.go',
            symbol: 'myFunc',
            whyCleanup: 'unnecessary change',
          },
        ],
      };

      const comment = instance._buildComment(202, mockPrData, results, cleanupResults);

      assert.ok(comment.includes('☑️ Reuse Review'), 'Should show checkmark for reuse');
      assert.ok(comment.includes('❌ Cleanup Review (1)'), 'Should show X with count for cleanup');
    });

    it('shows counts matching actual issue counts', () => {
      const results = {
        items: [
          { verdict: 'duplicate', severity: 'critical', newFunc: 'f1', existingFunc: 'e1', reason: 'r' },
          { verdict: 'duplicate', severity: 'high', newFunc: 'f2', existingFunc: 'e2', reason: 'r' },
        ],
      };
      const cleanupResults = {
        cleanups: [
          { severity: 'medium', file: 'a.go', symbol: 's1', whyCleanup: 'w' },
          { severity: 'low', file: 'b.go', symbol: 's2', whyCleanup: 'w' },
          { severity: 'low', file: 'c.go', symbol: 's3', whyCleanup: 'w' },
        ],
      };

      const comment = instance._buildComment(202, mockPrData, results, cleanupResults);

      assert.ok(comment.includes('❌ Reuse Review (2)'), 'Should show reuse count of 2');
      assert.ok(comment.includes('❌ Cleanup Review (3)'), 'Should show cleanup count of 3');
    });

    it('groups findings by severity (Critical/High/Medium/Low)', () => {
      const results = {
        items: [
          { verdict: 'duplicate', severity: 'critical', newFunc: 'c1', existingFunc: 'e1', reason: 'r' },
          { verdict: 'duplicate', severity: 'high', newFunc: 'h1', existingFunc: 'e2', reason: 'r' },
          { verdict: 'duplicate', severity: 'medium', newFunc: 'm1', existingFunc: 'e3', reason: 'r' },
          { verdict: 'pattern', severity: 'low', newFunc: 'l1', existingFunc: 'e4', reason: 'r' },
        ],
      };
      const cleanupResults = { cleanups: [] };

      const comment = instance._buildComment(202, mockPrData, results, cleanupResults);

      assert.ok(comment.includes('#### Critical'), 'Should have Critical section');
      assert.ok(comment.includes('#### High'), 'Should have High section');
      assert.ok(comment.includes('#### Medium'), 'Should have Medium section');
      assert.ok(comment.includes('#### Low'), 'Should have Low section');
    });

    it('displays findings in minimal tables with necessary columns', () => {
      const results = {
        items: [
          {
            verdict: 'duplicate',
            severity: 'critical',
            newFunc: 'myNewFunc',
            existingFunc: 'myExistingFunc',
            existingFile: 'utils/helper.go',
            reason: 'identical implementation',
          },
        ],
      };
      const cleanupResults = { cleanups: [] };

      const comment = instance._buildComment(202, mockPrData, results, cleanupResults);

      assert.ok(comment.includes('| Function |'), 'Should have Function column');
      assert.ok(comment.includes('| File |'), 'Should have File column');
      assert.ok(comment.includes('| Symbol |'), 'Should have Symbol column');
      assert.ok(comment.includes('| Reason |'), 'Should have Reason column');
      assert.ok(comment.includes('myNewFunc'), 'Should contain newFunc name');
      assert.ok(comment.includes('myExistingFunc'), 'Should contain existingFunc name');
    });

    it('does not contain verbose explanatory paragraphs', () => {
      const results = {
        items: [
          {
            verdict: 'duplicate',
            severity: 'critical',
            newFunc: 'f1',
            existingFunc: 'e1',
            reason: 'exact match',
            code: 'func example() {}',
          },
        ],
      };
      const cleanupResults = { cleanups: [] };

      const comment = instance._buildComment(202, mockPrData, results, cleanupResults);

      // Should not contain code blocks
      assert.ok(!comment.includes('```'), 'Should not contain code blocks');
      // Should not contain quoted reasons like ">"
      assert.ok(!comment.includes('> '), 'Should not contain quote markers');
    });
  });

  describe('format integrity', () => {
    it('does not render zero-value statistics even when functions analyzed is 0', () => {
      const results = { items: [], newFunctions: [] };
      const cleanupResults = { cleanups: [], modifiedFiles: 0, llmCandidates: [], skipped: [] };

      const comment = instance._buildComment(202, mockPrData, results, cleanupResults);

      assert.ok(!comment.match(/Functions analyzed:\s*0/), 'Should not contain Functions analyzed: 0');
      assert.ok(!comment.match(/Duplicates found:\s*0/), 'Should not contain Duplicates found: 0');
      assert.ok(!comment.match(/Unnecessary cleanups:\s*0/), 'Should not contain Unnecessary cleanups: 0');
    });

    it('status line format starts with emoji and Reuse Review', () => {
      const results = { items: [], newFunctions: [] };
      const cleanupResults = { cleanups: [] };

      const comment = instance._buildComment(202, mockPrData, results, cleanupResults);
      const lines = comment.split('\n');
      // Status line is at index 2 (after title and empty line)
      const statusLine = lines[2];

      // Status line should contain emoji + Reuse Review (check for the actual emoji chars)
      assert.ok(statusLine.includes('Reuse Review'), 'Status line should contain Reuse Review');
      assert.ok(statusLine.includes('Cleanup Review'), 'Status line should contain Cleanup Review');
      // Should contain both checkmarks for no issues
      assert.ok(statusLine.includes('☑️'), 'Should contain checkmark for no issues');
    });
  });
});
