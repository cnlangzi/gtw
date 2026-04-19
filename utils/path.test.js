import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { expandPath } from './path.js';
import { homedir } from 'os';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

const FIXTURES = {
  tilde: homedir(),
  tildeSlash: join(homedir(), 'subdir'),
  tildeSlashNested: join(homedir(), 'subdir/nested'),
  absolute: '/tmp/gtw-test-abs',
  absoluteNested: '/tmp/gtw-test-abs/nested',
  relative: 'fixtures/rel',
  relativeNested: 'fixtures/rel/nested',
  nonexistent: '/tmp/gtw-nonexistent-dir-123456',
  fileAsDir: '/tmp/gtw-test-file-123456',
};

beforeEach(() => {
  // Set up real directories
  mkdirSync(FIXTURES.absoluteNested, { recursive: true });
  mkdirSync(FIXTURES.tildeSlashNested, { recursive: true });
  // Set up a file where we expect a directory
  writeFileSync(FIXTURES.fileAsDir, 'I am a file');
});

describe('expandPath', () => {
  // ─── Tilde expansion ───────────────────────────────────────────

  describe('tilde (~) expansion', () => {
    it('expands bare ~ to homedir', () => {
      const result = expandPath('~');
      assert.strictEqual(result.expanded, homedir());
      assert.strictEqual(result.isAbsolute, true);
    });

    it('expands ~/path to homedir/path', () => {
      const result = expandPath('~/subdir');
      assert.strictEqual(result.expanded, FIXTURES.tildeSlash);
      assert.strictEqual(result.isAbsolute, true);
    });

    it('expands ~/nested/path correctly', () => {
      const result = expandPath('~/subdir/nested');
      assert.strictEqual(result.expanded, FIXTURES.tildeSlashNested);
      assert.strictEqual(result.isAbsolute, true);
    });

    it('does NOT lose homedir when path starts with ~/ (regression test)', () => {
      // join(homedir(), '/subdir') would return '/subdir' — must use slice(2)
      const result = expandPath('~/foo');
      assert.ok(result.expanded.endsWith('foo'), `Got: ${result.expanded}`);
      assert.notStrictEqual(result.expanded, '/foo');
    });
  });

  // ─── Absolute path handling ───────────────────────────────────

  describe('absolute paths', () => {
    it('returns absolute path unchanged', () => {
      const result = expandPath(FIXTURES.absolute);
      assert.strictEqual(result.expanded, FIXTURES.absolute);
      assert.strictEqual(result.isAbsolute, true);
    });

    it('resolves nested absolute path', () => {
      const result = expandPath(FIXTURES.absoluteNested);
      assert.strictEqual(result.expanded, FIXTURES.absoluteNested);
      assert.strictEqual(result.isAbsolute, true);
    });

    it('marks nonexistent absolute path as invalid', () => {
      const result = expandPath(FIXTURES.nonexistent);
      assert.strictEqual(result.expanded, FIXTURES.nonexistent);
      assert.strictEqual(result.isAbsolute, true);
      assert.strictEqual(result.isValid, false);
    });

    it('marks a file path as invalid when expecting a directory', () => {
      const result = expandPath(FIXTURES.fileAsDir);
      assert.strictEqual(result.isValid, false);
    });
  });

  // ─── Relative path handling ────────────────────────────────────

  describe('relative paths', () => {
    it('resolves relative path against cwd', () => {
      const result = expandPath('fixtures/rel');
      assert.strictEqual(result.isAbsolute, false);
      assert.ok(result.expanded.endsWith('fixtures/rel'), `Got: ${result.expanded}`);
    });
  });

  // ─── Validation ───────────────────────────────────────────────

  describe('validation', () => {
    it('isValid is true for existing directory', () => {
      const result = expandPath(FIXTURES.absolute);
      assert.strictEqual(result.isValid, true);
    });

    it('isValid is false for nonexistent path', () => {
      const result = expandPath('/tmp/this-dir-does-not-exist-789456');
      assert.strictEqual(result.isValid, false);
    });

    it('isValid is false for a file (not a directory)', () => {
      const result = expandPath(FIXTURES.fileAsDir);
      assert.strictEqual(result.isValid, false);
    });
  });

  // ─── Round-trip consistency ───────────────────────────────────

  describe('round-trip', () => {
    it('absolute path is idempotent', () => {
      const r1 = expandPath(FIXTURES.absolute);
      const r2 = expandPath(r1.expanded);
      assert.strictEqual(r1.expanded, r2.expanded);
      assert.strictEqual(r1.isValid, r2.isValid);
    });

    it('expanded tilde path is idempotent on second call', () => {
      const r1 = expandPath('~/subdir');
      const r2 = expandPath(r1.expanded);
      assert.strictEqual(r1.expanded, r2.expanded);
      assert.strictEqual(r1.isValid, r2.isValid);
    });
  });
});
