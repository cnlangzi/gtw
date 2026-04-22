import { describe, it } from 'node:test';
import assert from 'node:assert';
import { TimeoutError } from './ai.js';

describe('TimeoutError', () => {
  it('first attempt: correct message with timeout and attempt', () => {
    const err = new TimeoutError(60, 1);
    assert.strictEqual(err.name, 'TimeoutError');
    assert.strictEqual(err.timeoutSeconds, 60);
    assert.strictEqual(err.attempt, 1);
    assert.strictEqual(err.message, 'LLM request timed out after 60s (attempt 1 of 2)');
    assert.strictEqual(err.cause, undefined);
  });

  it('second attempt: message shows attempt 2 of 2', () => {
    const err = new TimeoutError(30, 2);
    assert.strictEqual(err.timeoutSeconds, 30);
    assert.strictEqual(err.attempt, 2);
    assert.strictEqual(err.message, 'LLM request timed out after 30s (attempt 2 of 2)');
  });

  it('includes original error as cause', () => {
    const original = new Error('ECONNRESET');
    const err = new TimeoutError(60, 2, original);
    assert.strictEqual(err.cause, original);
    assert.strictEqual(err.cause.message, 'ECONNRESET');
  });

  it('is an instance of Error', () => {
    assert(new TimeoutError(60, 1) instanceof Error);
  });

  it('attempt 1 error includes the timeout value', () => {
    const err = new TimeoutError(120, 1);
    assert.match(err.message, /120s/);
    assert.match(err.message, /attempt 1 of 2/);
  });
});