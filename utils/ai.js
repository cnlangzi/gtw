import { join } from 'path';
import { homedir } from 'os';
import { exists, read } from './fs.js';
import { jsonrepair } from 'jsonrepair';
import { getConfig, CONFIG_FILE, getLLMTimeoutSeconds } from './config.js';

/**
 * Resolve the path to sessions.json for a given agentId.
 * Centralizes the ~/.openclaw directory layout to avoid drift.
 * @param {string} agentId
 * @returns {string}
 */
function resolveSessionsPath(agentId) {
  return join(homedir(), '.openclaw', 'agents', agentId, 'sessions', 'sessions.json');
}

/**
 * Merge two provider configs: override fields win, base fills gaps.
 * Special handling: `models` is a list merged by id (override wins on duplicate).
 * @param {object} base
 * @param {object} override
 * @returns {object}
 */
export function mergeProviderConfig(base = {}, override = {}) {
  return {
    baseUrl:    override.baseUrl    ?? base.baseUrl    ?? '',
    api:        override.api        ?? base.api        ?? 'anthropic-messages',
    apiKey:     override.apiKey     ?? base.apiKey     ?? '',
    authHeader: override.authHeader ?? base.authHeader ?? true,
    models:     mergeModels(base.models, override.models),
  };
}

/**
 * Merge two models[] arrays by id; override entries win on duplicate.
 * @param {Array|null|undefined} base
 * @param {Array|null|undefined} override
 * @returns {Array}
 */
export function mergeModels(base, override) {
  const a = Array.isArray(base) ? base : [];
  const b = Array.isArray(override) ? override : [];
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const map = new Map();
  for (const m of a) if (m?.id) map.set(m.id, m);
  for (const m of b) if (m?.id) map.set(m.id, m);
  return Array.from(map.values());
}

/**
 * Resolve the model source paths for an agent. Allows tests to inject
 * custom paths via `options` to avoid touching the real ~/.openclaw dir.
 * @param {string} agentId
 * @param {object} [options] - { agentPath, globalPath }
 * @returns {{ agent: string, global: string }}
 */
export function resolveModelSourcePaths(agentId, options = {}) {
  const home = homedir();
  return {
    agent:  options.agentPath  ?? join(home, '.openclaw', 'agents', agentId, 'agent', 'models.json'),
    global: options.globalPath ?? join(home, '.openclaw', 'openclaw.json'),
  };
}

// ─── Source readers (each returns a providers object, or {} on miss/error) ───

function readAgentModels(agentPath) {
  if (!exists(agentPath)) return {};
  try {
    return JSON.parse(read(agentPath, 'utf8')).providers || {};
  } catch (e) {
    console.log(`[gtw] skip ${agentPath}: ${e.message}`);
    return {};
  }
}

function readGlobalModels(globalPath) {
  if (!exists(globalPath)) return { providers: {}, mode: 'merge' };
  try {
    const data = JSON.parse(read(globalPath, 'utf8'));
    return {
      providers: data.models?.providers || {},  // openclaw.json has `models.providers` (one level deeper)
      mode: data.models?.mode ?? 'merge',        // matches OpenClaw default
    };
  } catch (e) {
    console.log(`[gtw] skip ${globalPath}: ${e.message}`);
    return { providers: {}, mode: 'merge' };
  }
}

/**
 * Load and merge model providers from 2 sources with priority cascade
 * that mirrors OpenClaw's `models.mode` semantics:
 *   - mode "merge"   (default): merge global → agent (agent wins on field conflict;
 *                          models[] dedupes by id, higher-priority entry replaces)
 *   - mode "replace"          : use only the global (cfg.models.providers); skip the
 *                          agent models.json entirely, matching OpenClaw's
 *                          loadModelCatalog short-circuit for `mode === "replace"`.
 *
 * @param {string} agentId
 * @param {object} [options] - { agentPath, globalPath } for testing
 * @returns {object} providers object keyed by provider name
 */
export function loadModelsWithFallback(agentId, options = {}) {
  const paths = resolveModelSourcePaths(agentId, options);
  const { providers: global, mode } = readGlobalModels(paths.global);

  // "replace" matches OpenClaw: ignore the agent's models.json, use cfg.models.providers only.
  if (mode === 'replace') {
    const out = {};
    for (const [p, c] of Object.entries(global)) out[p] = mergeProviderConfig({}, c);
    return out;
  }

  // Default "merge": agent > global (low to high; higher overrides).
  const agent = readAgentModels(paths.agent);
  const merged = {};
  for (const [p, c] of Object.entries(global)) merged[p] = mergeProviderConfig({}, c);
  for (const [p, c] of Object.entries(agent))  merged[p] = mergeProviderConfig(merged[p] || {}, c);
  return merged;
}

/**
 * Find the provider config for a given model.
 * By default uses the same source cascade as OpenClaw's `loadModelCatalog`:
 *   - openclaw.json (`models.providers`) — always read
 *   - agent `models.json`                  — read unless `models.mode === "replace"`
 * Field-level merge: agent wins on field conflict; `models[]` is deduped by id
 * with the higher-priority entry replacing the lower one.
 *
 * @param {string} model - Model id (e.g. MiniMax-M2.7 or github/gpt-5-mini)
 * @param {string} [agentId='main'] - Agent ID for lookup
 * @param {string} [customModelsPath] - If provided, bypasses fallback (legacy single-file mode)
 * @param {object} [options] - { agentPath, globalPath } for testing
 * @returns {{ provider: string, baseUrl: string, authHeader: boolean, api: string, modelConf: object } | null}
 */
export function findModelProviderConfig(model, agentId = 'main', customModelsPath = null, options = null) {
  let modelConf;
  if (customModelsPath) {
    // Legacy single-file mode (preserved for backward compat with tests that pass a single file)
    if (!exists(customModelsPath)) return null;
    try {
      modelConf = JSON.parse(read(customModelsPath, 'utf8'));
    } catch {
      console.log(`[gtw] findModelProviderConfig → NOT FOUND: ${model} (parse error: ${customModelsPath})`);
      return null;
    }
  } else {
    // New: 3-source fallback chain, merged by priority
    const providers = loadModelsWithFallback(agentId, options || {});
    modelConf = { providers };
  }

  // Direct lookup: "provider/model-id"
  if (model.includes('/')) {
    const [provider, modelId] = model.split('/');
    const conf = modelConf.providers?.[provider];
    if (conf?.models?.some((m) => m.id === modelId)) {
      console.log(`[gtw] findModelProviderConfig → ${provider}/${modelId} (api=${conf.api || 'anthropic-messages'})`);
      return {
        provider,
        baseUrl: conf.baseUrl || '',
        authHeader: conf.authHeader !== false,
        api: conf.api || 'anthropic-messages',
        modelConf,
      };
    }
    return null;
  }

  // Fallback: search all providers for model id
  for (const [provider, conf] of Object.entries(modelConf.providers || {})) {
    const hasModel = conf.models?.some((m) => m.id === model);
    if (hasModel) {
      console.log(`[gtw] findModelProviderConfig → ${provider}/${model} (api=${conf.api || 'anthropic-messages'})`);
      return {
        provider,
        baseUrl: conf.baseUrl || '',
        authHeader: conf.authHeader !== false,
        api: conf.api || 'anthropic-messages',
        modelConf,
      };
    }
  }

  console.log(`[gtw] findModelProviderConfig → NOT FOUND: ${model}`);
  return null;
}

/**
 * Make an AI API call using OpenClaw's model + auth configuration.
 * Auth token priority (when api.runtime.modelAuth is available):
 *   1. api.runtime.modelAuth.getApiKeyForModel() — resolves the full OpenClaw auth chain
 *   2. auth-profiles.json → profiles[<provider>:default].access  (PAT / device flow token)
 *   3. auth-profiles.json → profiles[<provider>:default].key    (api_key type)
 *   4. models.json        → providers[<provider>].apiKey        (inline apiKey)
 * @param {string} model - Model id (with optional provider prefix)
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {string} [sessionKey] - Session key to resolve agentId and models path from
 * @param {object} [api] - OpenClaw plugin api (optional, for modelAuth)
 * @param {number} [timeoutSeconds] - Override default timeout; uses getLLMTimeoutSeconds() if not provided
 * @returns {Promise<string>} - Response text
 */
export class TimeoutError extends Error {
  constructor(timeoutSeconds, attempt, cause) {
    super(`LLM request timed out after ${timeoutSeconds}s (attempt ${attempt} of 2)`, { cause });
    this.name = 'TimeoutError';
    this.timeoutSeconds = timeoutSeconds;
    this.attempt = attempt;
  }
}

/**
 * Make an LLM API call with timeout and one automatic retry on timeout.
 * @param {string} model
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {string} [sessionKey]
 * @param {object} [api]
 * @param {number} [timeoutSeconds]
 * @returns {Promise<string>}
 */
export async function callAI(model, systemPrompt, userPrompt, sessionKey = null, api = null, timeoutSeconds) {
  const timeout = timeoutSeconds ?? getLLMTimeoutSeconds();
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await _callAIOnce(model, systemPrompt, userPrompt, sessionKey, api, timeout);
    } catch (err) {
      const isAbort = err.name === 'AbortError' || err.code === 'ETIMEDOUT' || err.message?.includes('network timeout');
      if (isAbort) {
        if (attempt === 1) {
          console.log(`[gtw] AI request timed out after ${timeout}s (attempt 1/2), retrying…`);
          lastError = err;
          continue;
        }
        throw new TimeoutError(timeout, 2, lastError ?? err);
      }
      throw err;
    }
  }
}

/**
 * Internal: single LLM API call with AbortController timeout.
 * Resolves providers through loadModelsWithFallback (agent models.json +
 * openclaw.json models.providers, with mode=replace support).
 * @private
 */
async function _callAIOnce(model, systemPrompt, userPrompt, sessionKey, api, timeoutSeconds) {
  const agentId = sessionKey ? (sessionKey.split(':')[1] || 'main') : 'main';

  const result = findModelProviderConfig(model, agentId, null);
  if (!result) throw new Error(`Model ${model} not found in models.json`);

  const { provider, baseUrl, authHeader, api: resolvedApi, modelConf } = result;
  const modelId = model.includes('/') ? model.split('/')[1] : model;
  const providerModels = modelConf.providers?.[provider]?.models || [];
  let token = null;

  // Priority 1: api.runtime.modelAuth (uses the full OpenClaw auth chain)
  if (api?.runtime?.modelAuth) {
    try {
      const cfg = api.runtime.config.current();
      const auth = await api.runtime.modelAuth.getApiKeyForModel({ model, cfg });
      token = auth?.apiKey || null;
    } catch (e) {
      console.log('[gtw] modelAuth error:', e.message);
    }
  }

  // Priority 2: auth-state.json lastGood (OpenClaw's verified working profile)
  if (!token) {
    try {
      const statePath = join(homedir(), '.openclaw', 'agents', agentId, 'agent', 'auth-state.json');
      const state = JSON.parse(read(statePath, 'utf8'));
      const lastGoodProfile = state?.lastGood?.[provider];
      if (lastGoodProfile) {
        const authPath = join(homedir(), '.openclaw', 'agents', agentId, 'agent', 'auth-profiles.json');
        const authData = JSON.parse(read(authPath, 'utf8'));
        const profile = authData.profiles?.[lastGoodProfile];
        token = profile?.access || profile?.key || null;
      }
    } catch { /* no auth state */ }
  }

  // Priority 3: auth-profiles.json — iterate all profiles for this provider
  if (!token) {
    try {
      const authPath = join(homedir(), '.openclaw', 'agents', agentId, 'agent', 'auth-profiles.json');
      const authData = JSON.parse(read(authPath, 'utf8'));
      for (const [key, profile] of Object.entries(authData.profiles || {})) {
        if (key.startsWith(provider + ':')) {
          const found = profile?.access || profile?.key || null;
          if (found) { token = found; break; }
        }
      }
    } catch { /* no auth profile */ }
  }

  // Priority 4: models.json inline apiKey (already parsed in modelConf)
  if (!token) {
    token = modelConf.providers?.[provider]?.apiKey || null;
  }

  const headers = { 'Content-Type': 'application/json' };

  if (token) {
    if (authHeader) {
      headers['Authorization'] = `Bearer ${token}`;
    } else {
      headers['x-api-key'] = token;
    }
  }

  let endpoint;
  let body;

  if (resolvedApi === 'anthropic-messages') {
    headers['anthropic-version'] = '2023-06-01';
    endpoint = baseUrl.replace(/\/v1\/?$/, '') + '/v1/messages';
    const maxTokens = providerModels.find((m) => m.id === modelId)?.maxTokens || 8192;
    body = { model: modelId, max_tokens: maxTokens, messages: [{ role: 'user', content: userPrompt }] };
    if (systemPrompt) body.system = systemPrompt;
  } else {
    endpoint = baseUrl + '/chat/completions';
    body = { model: modelId, messages: [] };
    if (systemPrompt) body.messages.push({ role: 'system', content: systemPrompt });
    body.messages.push({ role: 'user', content: userPrompt });
  }

  console.log(`[gtw] AI request → ${endpoint}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  let res;
  try {
    res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  console.log(`[gtw] AI response ← ${endpoint} [${res.status}]`);
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

  if (resolvedApi === 'anthropic-messages') {
    const data = await res.json();
    return (data.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  } else {
    const data = await res.json();
    return (data.choices || []).map((c) => c.message?.content || '').join('');
  }
}

/**
 * Resolve the model to use for gtw commands.
 * Priority:
 *   1. gtw/config.json model override (set via /gtw model)
 *      - If the model string contains a provider prefix (e.g. "github/gpt-4o"),
 *        the provider is extracted from it.
 *      - If the model has no prefix (e.g. "gpt-4o"), sessions.json is consulted
 *        to backfill the provider while keeping the config model name.
 *   2. Current session model from sessions.json (sessionKey required)
 * @param {string|null} [sessionKey=null] - Session key to read session model from.
 * @param {object} [api] - OpenClaw plugin api (deprecated, unused)
 * @returns {{ model: string, modelProvider: string }}
 * @deprecated The `api` parameter is no longer used. Pass null or omit it.
 */
export async function resolveModel(sessionKey = null, api = null) {
  let model = null;
  let modelProvider = null;

  // 1. gtw/config.json override (set via /gtw model)
  try {
    if (exists(CONFIG_FILE)) {
      const gtwConfig = JSON.parse(read(CONFIG_FILE, 'utf8'));
      if (gtwConfig.model) {
        model = gtwConfig.model;
        // Derive modelProvider from the model string if it has a provider prefix
        if (model.includes('/')) {
          const [provider, modelId] = model.split('/');
          modelProvider = provider;
          model = modelId; // strip provider prefix so downstream never sees "github/gpt-4o" as model
        }
      }
    }
  } catch {}

  // 2. Fallback: read current session model directly from sessions.json
  // Use sessions.json to backfill modelProvider when config gave a bare model name,
  // or to supply both model+provider when config is absent entirely.
  // Trigger whenever modelProvider is missing (config may have set a bare model name).
  if (!modelProvider && sessionKey) {
    try {
      const agentId = sessionKey.split(':')[1] || 'main';
      const sessionsPath = resolveSessionsPath(agentId);
      if (exists(sessionsPath)) {
        const sessionsData = JSON.parse(read(sessionsPath, 'utf8'));
        const entry = sessionsData[sessionKey];
        if (entry?.modelProvider && entry?.model) {
          // Only fill in what is still missing; prefer config's model name if set
          if (!modelProvider) modelProvider = entry.modelProvider;
          if (!model) model = entry.model;
        }
      }
    } catch (e) {
      console.debug('[resolveModel] sessions.json read failed:', e.message);
    }
  }

  if (!model || !modelProvider) {
    throw new Error(
      sessionKey
        ? `Session ${sessionKey} has no model`
        : 'No model configured in gtw/config.json'
    );
  }

  return { model, modelProvider };
}

/**
 * Parse LLM response text as JSON.
 * Uses jsonrepair to handle malformed JSON common in LLM outputs.
 * @param {string} text - Raw response text from LLM
 * @returns {object} Parsed JSON object
 * @throws {Error} If JSON cannot be repaired or result is not an object
 */
export function parseAIResponse(text) {
  try {
    const repaired = jsonrepair(text);
    let parsed = JSON.parse(repaired);

    if (typeof parsed === 'string') {
      try {
        const reparsed = JSON.parse(parsed);
        if (typeof reparsed === 'object' && !Array.isArray(reparsed)) {
          return reparsed;
        }
      } catch {}
    }

    if (Array.isArray(parsed)) {
      const obj = parsed.find(el => typeof el === 'object' && !Array.isArray(el));
      if (obj) return obj;
    }

    if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    throw new Error('Result is not a JSON object');
  } catch (e) {
    throw new Error(`Invalid JSON from AI response: ${e.message}`);
  }
}