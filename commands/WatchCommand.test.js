/**
 * Unit tests for WatchCommand (AC6).
 * Run: node --test commands/WatchCommand.test.js
 */
import { dirname, join } from 'path';
import { homedir } from 'os';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

// Set GTW_CONFIG_DIR before importing modules that depend on it
process.env.GTW_CONFIG_DIR = join(homedir(), '.gtw');

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { WatchCommand } from './WatchCommand.js';
import { getConfig, saveConfig, CONFIG_FILE } from '../utils/config.js';

const makeContext = () => ({ api: {}, config: {}, sessionKey: 'test' });

function writeConfig(data) {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
}
function readConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WatchCommand (AC6)', () => {
  // Snapshot original
  const orig = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {};

  // Reset before each test
  const cleanup = () => { writeConfig({}); };

  it('list: returns empty when no watch list', async () => {
    cleanup();
    const cmd = new WatchCommand(makeContext());
    const result = await cmd.execute(['list']);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.watchList, []);
  });

  it('list: shows all watched repos', async () => {
    writeConfig({ watchList: ['a/b', 'c/d'] });
    const cmd = new WatchCommand(makeContext());
    const result = await cmd.execute(['list']);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.watchList.length, 2);
    assert.ok(result.message.includes('a/b'));
    cleanup();
  });

  it('add: adds repo to watch list', async () => {
    cleanup();
    const cmd = new WatchCommand(makeContext());
    const result = await cmd.execute(['add', 'octocat/Hello-World']);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.added, 'octocat/Hello-World');
    assert.ok(readConfig().watchList.includes('octocat/Hello-World'));
    cleanup();
  });

  it('add: ignores duplicate repos', async () => {
    writeConfig({ watchList: ['octocat/Hello-World'] });
    const cmd = new WatchCommand(makeContext());
    const result = await cmd.execute(['add', 'octocat/Hello-World']);
    assert.strictEqual(result.ok, true);
    assert.ok(result.message.includes('already'));
    assert.strictEqual(readConfig().watchList.length, 1); // unchanged
    cleanup();
  });

  it('add: rejects invalid format', async () => {
    cleanup();
    const cmd = new WatchCommand(makeContext());
    const r1 = await cmd.execute(['add', 'not-valid']);
    assert.strictEqual(r1.ok, false);
    const r2 = await cmd.execute(['add', 'missing-slash']);
    assert.strictEqual(r2.ok, false);
    const r3 = await cmd.execute(['add', '']);
    assert.strictEqual(r3.ok, false);
    cleanup();
  });

  it('add: preserves existing items', async () => {
    writeConfig({ watchList: ['a/b', 'c/d'] });
    const cmd = new WatchCommand(makeContext());
    await cmd.execute(['add', 'e/f']);
    const list = readConfig().watchList;
    assert.strictEqual(list.length, 3);
    assert.ok(list.includes('a/b'));
    assert.ok(list.includes('c/d'));
    assert.ok(list.includes('e/f'));
    cleanup();
  });

  it('rm: removes repo from watch list', async () => {
    writeConfig({ watchList: ['octocat/Hello-World', 'cnlangzi/gtw'] });
    const cmd = new WatchCommand(makeContext());
    const result = await cmd.execute(['rm', 'octocat/Hello-World']);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.removed, 'octocat/Hello-World');
    assert.ok(!readConfig().watchList.includes('octocat/Hello-World'));
    assert.ok(readConfig().watchList.includes('cnlangzi/gtw'));
    cleanup();
  });

  it('rm: handles non-existing repo gracefully', async () => {
    writeConfig({ watchList: ['cnlangzi/gtw'] });
    const cmd = new WatchCommand(makeContext());
    const result = await cmd.execute(['rm', 'nonexistent/repo']);
    assert.strictEqual(result.ok, true);
    assert.ok(result.message.includes('not in the watch list'));
    assert.strictEqual(readConfig().watchList.length, 1);
    cleanup();
  });

  it('rm: removes last repo → empty list', async () => {
    writeConfig({ watchList: ['only/one'] });
    const cmd = new WatchCommand(makeContext());
    const result = await cmd.execute(['rm', 'only/one']);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(readConfig().watchList, []);
    cleanup();
  });

  it('rm: works with "remove" alias', async () => {
    writeConfig({ watchList: ['a/b'] });
    const cmd = new WatchCommand(makeContext());
    const result = await cmd.execute(['remove', 'a/b']);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(readConfig().watchList, []);
    cleanup();
  });

  it('unknown subcommand returns usage', async () => {
    cleanup();
    const cmd = new WatchCommand(makeContext());
    const result = await cmd.execute(['unknown']);
    assert.strictEqual(result.ok, true);
    assert.ok(result.message.includes('Usage'));
    cleanup();
  });
});
