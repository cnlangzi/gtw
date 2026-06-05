import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TimeoutError, findModelProviderConfig, loadModelsWithFallback, mergeProviderConfig, mergeModels } from './ai.js';

// ─── Test fixtures ───────────────────────────────────────────────
//
// All tests use a single tmp directory created once. Before each test we
// rebuild the source files (or omit them) to control the fallback behavior.
//
// Layout under tmpDir:
//   <tmpDir>/agent/models.json
//   <tmpDir>/openclaw.json
//
// Tests pass these paths explicitly via `options` to avoid touching the
// real ~/.openclaw directory.

let tmpDir;
let agentPath;
let globalPath;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gtw-models-fallback-'));
  agentPath = join(tmpDir, 'agent', 'models.json');
  globalPath = join(tmpDir, 'openclaw.json');
});

after(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  // Wipe and recreate clean state for each test
  rmSync(join(tmpDir, 'agent'), { recursive: true, force: true });
  rmSync(globalPath, { force: true });
  mkdirSync(join(tmpDir, 'agent'), { recursive: true });
});

// Helper: write a JSON source file
function writeAgent(data)  { writeFileSync(agentPath,  JSON.stringify(data, null, 2), 'utf8'); }
function writeGlobal(data) { writeFileSync(globalPath, JSON.stringify(data, null, 2), 'utf8'); }

// Build options object for the function under test
function opts() {
  return { agentPath, globalPath };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('mergeModels (pure)', () => {
  it('returns base when override is empty', () => {
    const result = mergeModels([{ id: 'A' }], []);
    assert.deepStrictEqual(result, [{ id: 'A' }]);
  });

  it('returns override when base is empty', () => {
    const result = mergeModels([], [{ id: 'A' }]);
    assert.deepStrictEqual(result, [{ id: 'A' }]);
  });

  it('concatenates and dedupes by id, override wins', () => {
    const base = [
      { id: 'A', name: 'base-A' },
      { id: 'B', name: 'base-B' },
    ];
    const override = [
      { id: 'B', name: 'override-B' },  // duplicate, should win
      { id: 'C', name: 'override-C' },
    ];
    const result = mergeModels(base, override);
    assert.strictEqual(result.length, 3);
    const a = result.find((m) => m.id === 'A');
    const b = result.find((m) => m.id === 'B');
    const c = result.find((m) => m.id === 'C');
    assert.strictEqual(a.name, 'base-A');
    assert.strictEqual(b.name, 'override-B');  // override wins
    assert.strictEqual(c.name, 'override-C');
  });

  it('handles both null/undefined', () => {
    assert.deepStrictEqual(mergeModels(null, null), []);
    assert.deepStrictEqual(mergeModels(undefined, undefined), []);
  });
});

describe('mergeProviderConfig (pure)', () => {
  it('higher priority fields win, lower priority fills gaps', () => {
    const base = { baseUrl: 'https://low.com', api: 'openai', apiKey: 'low-key' };
    const override = { baseUrl: 'https://high.com' };  // only baseUrl
    const result = mergeProviderConfig(base, override);
    assert.strictEqual(result.baseUrl, 'https://high.com');  // override wins
    assert.strictEqual(result.api, 'openai');               // base fills gap
    assert.strictEqual(result.apiKey, 'low-key');           // base fills gap
  });

  it('merges models lists', () => {
    const base = { models: [{ id: 'A' }] };
    const override = { models: [{ id: 'B' }] };
    const result = mergeProviderConfig(base, override);
    assert.strictEqual(result.models.length, 2);
  });

  it('authHeader defaults to undefined → caller treats as enabled', () => {
    const base = { authHeader: false };
    const override = { baseUrl: 'https://x.com' };
    const result = mergeProviderConfig(base, override);
    assert.strictEqual(result.authHeader, false);  // base preserved when override missing
  });
});

// ─── Single-source hit cases ─────────────────────────────────────

describe('loadModelsWithFallback — single source', () => {
  it('returns provider from agent models.json when present', () => {
    writeAgent({
      providers: { minimax: { baseUrl: 'https://a.com', api: 'anthropic-messages', models: [{ id: 'M3' }] } },
    });
    const merged = loadModelsWithFallback('main', opts());
    assert.deepStrictEqual(Object.keys(merged), ['minimax']);
    assert.strictEqual(merged.minimax.baseUrl, 'https://a.com');
    assert.strictEqual(merged.minimax.models[0].id, 'M3');
  });

  it('falls back to openclaw.json when agent is empty/missing', () => {
    // agent: missing, only global present
    writeGlobal({ models: { providers: { minimax: { baseUrl: 'https://global.com', models: [{ id: 'M3' }] } } } });
    const merged = loadModelsWithFallback('main', opts());
    assert.strictEqual(merged.minimax.baseUrl, 'https://global.com');
  });
});

// ─── Priority: higher overrides lower ────────────────────────────

describe('loadModelsWithFallback — priority', () => {
  it('agent overrides global when both have same provider', () => {
    writeAgent({ providers: { minimax: { baseUrl: 'https://agent.com' } } });
    writeGlobal({ models: { providers: { minimax: { baseUrl: 'https://global.com' } } } });
    const merged = loadModelsWithFallback('main', opts());
    assert.strictEqual(merged.minimax.baseUrl, 'https://agent.com');
  });
});

// ─── Field-level merge ──────────────────────────────────────────

describe('loadModelsWithFallback — field merge', () => {
  it('merges baseUrl from agent + apiKey/api from global', () => {
    writeAgent({ providers: { minimax: { baseUrl: 'https://agent.com' } } });
    writeGlobal({ models: { providers: { minimax: { apiKey: 'global-key', api: 'openai' } } } });
    const merged = loadModelsWithFallback('main', opts());
    assert.strictEqual(merged.minimax.baseUrl, 'https://agent.com');  // agent wins
    assert.strictEqual(merged.minimax.apiKey, 'global-key');          // global fills
    assert.strictEqual(merged.minimax.api, 'openai');                  // global fills
  });

  it('merges models[] from global + agent (dedupe by id, agent wins on duplicate)', () => {
    writeGlobal({ models: { providers: { minimax: { models: [{ id: 'M3' }, { id: 'M2.7', name: 'global-version' }] } } } });
    writeAgent({ providers: { minimax: { models: [{ id: 'M2.7', name: 'agent-version' }] } } });
    const merged = loadModelsWithFallback('main', opts());
    // Both M2.7 and M3 should be present
    const ids = merged.minimax.models.map((m) => m.id).sort();
    assert.deepStrictEqual(ids, ['M2.7', 'M3']);
    // Higher priority (agent) wins for duplicate M2.7
    const m27 = merged.minimax.models.find((m) => m.id === 'M2.7');
    assert.strictEqual(m27.name, 'agent-version');
  });
});

// ─── Error handling ─────────────────────────────────────────────

describe('loadModelsWithFallback — error handling', () => {
  it('skips agent when file does not exist', () => {
    // No agent file written
    writeGlobal({ models: { providers: { minimax: { baseUrl: 'https://global.com' } } } });
    const merged = loadModelsWithFallback('main', opts());
    assert.strictEqual(merged.minimax.baseUrl, 'https://global.com');
  });

  it('skips agent when JSON is malformed', () => {
    writeFileSync(agentPath, '{ this is not json', 'utf8');
    writeGlobal({ models: { providers: { minimax: { baseUrl: 'https://global.com' } } } });
    const merged = loadModelsWithFallback('main', opts());
    assert.strictEqual(merged.minimax.baseUrl, 'https://global.com');
  });

  it('skips openclaw.json when JSON is malformed', () => {
    writeAgent({ providers: { minimax: { baseUrl: 'https://agent.com' } } });
    writeFileSync(globalPath, '{ this is not json', 'utf8');
    const merged = loadModelsWithFallback('main', opts());
    assert.strictEqual(merged.minimax.baseUrl, 'https://agent.com');
  });

  it('treats openclaw.json without `models` field as empty', () => {
    writeAgent({ providers: { minimax: { baseUrl: 'https://agent.com' } } });
    writeGlobal({ agents: {} });  // no models
    const merged = loadModelsWithFallback('main', opts());
    assert.strictEqual(merged.minimax.baseUrl, 'https://agent.com');
  });

  it('returns empty object when all sources missing/empty', () => {
    const merged = loadModelsWithFallback('main', opts());
    assert.deepStrictEqual(merged, {});
  });

  it('handles empty providers object in agent', () => {
    writeAgent({ providers: {} });
    writeGlobal({ models: { providers: { minimax: { baseUrl: 'https://global.com' } } } });
    const merged = loadModelsWithFallback('main', opts());
    assert.strictEqual(merged.minimax.baseUrl, 'https://global.com');
  });
});

// ─── models.mode (replace / merge) — mirrors OpenClaw semantics ─────────

describe('loadModelsWithFallback — models.mode', () => {
  it('default (mode absent) behaves as merge: agent wins on conflict', () => {
    writeAgent({ providers: { minimax: { baseUrl: 'https://agent.com' } } });
    writeGlobal({ models: { providers: { minimax: { baseUrl: 'https://global.com' } } } });
    // no mode field on global → default merge
    const merged = loadModelsWithFallback('main', opts());
    assert.strictEqual(merged.minimax.baseUrl, 'https://agent.com');
  });

  it('mode "merge" explicitly: agent wins on conflict', () => {
    writeAgent({ providers: { minimax: { baseUrl: 'https://agent.com' } } });
    writeGlobal({ models: { mode: 'merge', providers: { minimax: { baseUrl: 'https://global.com' } } } });
    const merged = loadModelsWithFallback('main', opts());
    assert.strictEqual(merged.minimax.baseUrl, 'https://agent.com');
  });

  it('mode "replace": agent models.json is IGNORED, only global is used', () => {
    // Agent has a different baseUrl — replace must discard it entirely
    writeAgent({ providers: { minimax: { baseUrl: 'https://agent.com' } } });
    writeGlobal({ models: { mode: 'replace', providers: { minimax: { baseUrl: 'https://global.com' } } } });
    const merged = loadModelsWithFallback('main', opts());
    assert.strictEqual(merged.minimax.baseUrl, 'https://global.com');
  });

  it('mode "replace": provider that exists ONLY in agent is dropped', () => {
    // github is in agent only; replace must not include it
    writeAgent({ providers: { github: { baseUrl: 'http://127.0.0.1:8081' } } });
    writeGlobal({ models: { mode: 'replace', providers: { minimax: { baseUrl: 'https://global.com' } } } });
    const merged = loadModelsWithFallback('main', opts());
    assert.strictEqual(merged.github, undefined);
    assert.strictEqual(merged.minimax.baseUrl, 'https://global.com');
  });

  it('mode "replace" with no global: falls through to default merge (file missing = mode unknown)', () => {
    writeAgent({ providers: { minimax: { baseUrl: 'https://agent.com' } } });
    // No global file → readGlobalModels returns {providers:{}, mode:'merge'} as a safe default
    const merged = loadModelsWithFallback('main', opts());
    assert.strictEqual(merged.minimax.baseUrl, 'https://agent.com');
  });

  it('mode "replace" still falls back through mergeProviderConfig for fields', () => {
    // Replace uses cfg.models.providers as the seed; mergeProviderConfig fills
    // any missing fields with defaults (api, authHeader) — same as merge path.
    writeGlobal({ models: { mode: 'replace', providers: { minimax: { baseUrl: 'https://g.com' } } } });
    const merged = loadModelsWithFallback('main', opts());
    assert.strictEqual(merged.minimax.api, 'anthropic-messages');
    assert.strictEqual(merged.minimax.authHeader, true);
  });
});

// ─── findModelProviderConfig integration ─────────────────────────

describe('findModelProviderConfig — fallback chain', () => {
  it('finds direct "provider/model" in agent', () => {
    writeAgent({ providers: { minimax: { baseUrl: 'https://a.com', models: [{ id: 'M3' }] } } });
    const result = findModelProviderConfig('minimax/M3', 'main', null, opts());
    assert.strictEqual(result.provider, 'minimax');
    assert.strictEqual(result.baseUrl, 'https://a.com');
  });

  it('finds bare model name in global when agent is empty', () => {
    writeAgent({ providers: {} });
    writeGlobal({ models: { providers: { minimax: { baseUrl: 'https://global.com', models: [{ id: 'M3' }] } } } });
    const result = findModelProviderConfig('M3', 'main', null, opts());
    assert.strictEqual(result.provider, 'minimax');
    assert.strictEqual(result.baseUrl, 'https://global.com');
  });

  it('returns null when no source has the model', () => {
    const result = findModelProviderConfig('M3', 'main', null, opts());
    assert.strictEqual(result, null);
  });

  it('reproduces the original bug: agent missing minimax, falls back to openclaw.json', () => {
    // Simulate the broken state from the bug report (the original fix was
    // a 3-source cascade; the trimmed 2-source version still resolves it
    // via openclaw.json)
    writeAgent({ providers: { github: { baseUrl: 'http://127.0.0.1:8081', models: [{ id: 'gpt-5-mini' }] } } });
    writeGlobal({
      models: {
        providers: {
          minimax: {
            baseUrl: 'https://api.minimaxi.com/anthropic',
            api: 'anthropic-messages',
            authHeader: true,
            models: [
              { id: 'MiniMax-M3', name: 'MiniMax M3', reasoning: true, input: ['text', 'image'] },
              { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
            ],
          },
        },
      },
    });
    // This should now work via fallback
    const result = findModelProviderConfig('MiniMax-M3', 'main', null, opts());
    assert.strictEqual(result.provider, 'minimax');
    assert.strictEqual(result.baseUrl, 'https://api.minimaxi.com/anthropic');
    assert.strictEqual(result.api, 'anthropic-messages');
  });
});

describe('findModelProviderConfig — backward compat', () => {
  it('customModelsPath bypasses fallback (single-file mode)', () => {
    // When 4th arg is null, uses fallback. When customModelsPath is provided,
    // should use that single file (old behavior preserved).
    const customPath = join(tmpDir, 'custom-models.json');
    writeFileSync(customPath, JSON.stringify({ providers: { foo: { baseUrl: 'https://foo.com', models: [{ id: 'F' }] } } }), 'utf8');
    // Also write an agent that doesn't have it
    writeAgent({ providers: {} });
    const result = findModelProviderConfig('F', 'main', customPath, opts());
    assert.strictEqual(result.provider, 'foo');
  });
});
