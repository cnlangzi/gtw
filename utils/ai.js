import { join } from 'path';
import { homedir } from 'os';
import { exists, read } from './fs.js';
import { jsonrepair } from 'jsonrepair';
import { getConfig, CONFIG_FILE, getLLMTimeoutSeconds } from './config.js';

/**
 * Find the provider config for a given model from OpenClaw's models.json.
 * Parses models.json once and returns the data for reuse in _callAIOnce.
 * @param {string} model - Model id (e.g. MiniMax-M2.7 or github/gpt-5-mini)
 * @param {string} [agentId='main'] - Agent ID for models.json lookup
 * @param {string} [customModelsPath] - Override models.json path
 * @returns {{ provider: string, baseUrl: string, authHeader: boolean, api: string, modelConf: object } | null}
 */
export function findModelProviderConfig(model, agentId = 'main', customModelsPath = null) {
  const modelsPath = customModelsPath || join(homedir(), '.openclaw', 'agents', agentId, 'agent', 'models.json');
  if (!exists(modelsPath)) return null;
  let modelConf;
  try {
    modelConf = JSON.parse(read(modelsPath, 'utf8'));
  } catch {
    console.log(`[gtw] findModelProviderConfig → NOT FOUND: ${model} (models.json parse error)`);
    return null;
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
 * Reads models.json exactly once and reuses the parsed object for all lookups.
 * @private
 */
async function _callAIOnce(model, systemPrompt, userPrompt, sessionKey, api, timeoutSeconds) {
  const agentId = sessionKey ? (sessionKey.split(':')[1] || 'main') : 'main';
  const modelsPath = join(homedir(), '.openclaw', 'agents', agentId, 'agent', 'models.json');

  const result = findModelProviderConfig(model, agentId, modelsPath);
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
 * Uses api.runtime.session (OpenClaw official API) when api is available,
 * falls back to gtw/config.json override only.
 * @param {string|null} [sessionKey=null] - Session key to read session model from.
 * @param {object} [api] - OpenClaw plugin api (for api.runtime.session)
 * @returns {{ model: string, modelProvider: string }}
 */
export async function resolveModel(sessionKey = null, api = null) {
  let model = null;
  let modelProvider = null;

  // 1. Session model via api.runtime.session (OpenClaw official API)
  if (sessionKey && api?.runtime?.session) {
    try {
      const storePath = api.runtime.session.resolveStorePath({ agentId: sessionKey.split(':')[1] || 'main' });
      const store = api.runtime.session.loadSessionStore(storePath);
      const { existing: entry } = api.runtime.session.resolveSessionStoreEntry({ store, sessionKey });
      if (entry?.modelProvider && entry?.model) {
        modelProvider = entry.modelProvider;
        model = entry.model;
      }
    } catch (e) {
      console.debug('[resolveModel] api.runtime.session failed:', e.message);
    }
  }

  // 2. gtw/config.json override (always checked)
  try {
    if (exists(CONFIG_FILE)) {
      const gtwConfig = JSON.parse(read(CONFIG_FILE, 'utf8'));
      if (gtwConfig.model) model = gtwConfig.model;
    }
  } catch {}

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