/**
 * Unit tests for parseAIResponse()
 * Tests jsonrepair handling of various malformed JSON from LLM outputs
 */

import { strict as assert } from 'assert';
import { rmSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

// Set GTW_CONFIG_DIR before importing config-dependent modules
process.env.GTW_CONFIG_DIR = join(homedir(), '.gtw');
const { parseAIResponse } = await import('../utils/ai.js');

console.log('🧪 Testing parseAIResponse() with jsonrepair\n');

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

// Test 1: Clean JSON (already valid)
test('clean JSON object', () => {
  const input = '{"title": "test", "target": "file.js"}';
  const result = parseAIResponse(input);
  assert.deepStrictEqual(result, { title: "test", target: "file.js" });
});

// Test 2: Markdown code block with ```json
test('markdown code block ```json...```', () => {
  const input = '```json\n{"title": "test"}\n```';
  const result = parseAIResponse(input);
  assert.deepStrictEqual(result, { title: "test" });
});

// Test 3: Markdown code block without json label
test('markdown code block ```...```', () => {
  const input = '```\n{"title": "test"}\n```';
  const result = parseAIResponse(input);
  assert.deepStrictEqual(result, { title: "test" });
});

// Test 4: Trailing comma
test('trailing comma', () => {
  const input = '{"title": "test",}';
  const result = parseAIResponse(input);
  assert.deepStrictEqual(result, { title: "test" });
});

// Test 5: Single quotes instead of double quotes
test('single quotes around string values', () => {
  const input = "{'title': 'test'}";
  const result = parseAIResponse(input);
  assert.deepStrictEqual(result, { title: "test" });
});

// Test 6: Unquoted object keys
test('unquoted object keys', () => {
  const input = '{title: "test", target: "file.js"}';
  const result = parseAIResponse(input);
  assert.deepStrictEqual(result, { title: "test", target: "file.js" });
});

// Test 7: Python keywords (True/False/None)
test('python keywords True/False/None', () => {
  const input = '{"active": True, "count": None, "valid": False}';
  const result = parseAIResponse(input);
  assert.deepStrictEqual(result, { active: true, count: null, valid: false });
});

// Test 8: Double-encoded JSON string
test('double-encoded JSON string', () => {
  const input = '"{\\"title\\": \\"test\\"}"';
  const result = parseAIResponse(input);
  assert.deepStrictEqual(result, { title: "test" });
});

// Test 9: Missing closing brace
test('missing closing brace (repaired)', () => {
  const input = '{"title": "test"';
  const result = parseAIResponse(input);
  assert.deepStrictEqual(result, { title: "test" });
});

// Test 10: Array is not a valid return type for our use case (Implementation Brief is an object)
// jsonrepair修复后是array，但函数只返回object，所以会throw
test('array throws error (not a valid return type)', () => {
  let error;
  try {
    parseAIResponse('["a", "b", "c"]');
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof Error, 'should throw Error for array input');
  assert.ok(error.message.includes('Invalid JSON'), 'error should mention Invalid JSON');
});

// Test 11: Text before and after JSON block
test('text before and after JSON block', () => {
  const input = 'Here is the result:\n{"title": "test"}\n\nLet me know if you need changes';
  const result = parseAIResponse(input);
  assert.deepStrictEqual(result, { title: "test" });
});

// Test 12: Line comment after JSON
test('line comment after JSON', () => {
  const input = '{"title": "test"} // comment';
  const result = parseAIResponse(input);
  assert.deepStrictEqual(result, { title: "test" });
});

// Test 13: Block comment inside JSON (repaired)
test('block comment inside JSON', () => {
  const input = '{/* comment */"title": "test"}';
  const result = parseAIResponse(input);
  assert.deepStrictEqual(result, { title: "test" });
});

// Test 14: Invalid JSON throws error with message
test('completely invalid JSON throws descriptive error', () => {
  let error;
  try {
    parseAIResponse('this is not json at all');
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof Error, 'should throw Error');
  assert.ok(error.message.includes('Invalid JSON'), 'error message should mention Invalid JSON');
});

// Test 15: Empty string throws error
test('empty string throws error', () => {
  let error;
  try {
    parseAIResponse('');
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof Error, 'should throw Error');
});

// Summary
console.log('\n' + '='.repeat(60));
console.log(`Tests completed: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);