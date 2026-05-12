import { join } from 'path';
import { homedir } from 'os';
import { exists, read } from './fs.js';
import { jsonrepair } from 'jsonrepair';
import { getConfig, CONFIG_FILE, getLLMTimeoutSeconds } from './config.js';
import { getSessionEntry, resolveRealSessionKey } from './session.js';

/**
 * Find the provider config for a given model from OpenClaw's models.json.
 * Supports "model-id" (searches all providers) or "provider/model-id" (direct lookup).
 * @param {string} model - Model id (e.g. MiniMax-M2.7 or github/gpt-5-mini)
 * @param {string} [agentId='main'] - Agent ID for models.json lookup
 * @param {string} [customModelsPath] - Override models.json path
 * @returns {{ provider: string, baseUrl: string, authHeader: boolean, api: string } | null}
 */
export function findModelProviderConfig(model, agentId = 'main', customModelsPath = null) {
  const modelsPath = customModelsPath || join(homedir(), '.openclaw', 'agents', agentId, 'agent', 'models.json');
  if (!exists(modelsPath)) return null;
  try {
    const data = JSON.parse(read(modelsPath, 'utf8'));

    // Direct lookup: "provider/model-id"
    if (model.includes('/')) {
      const [provider, modelId] = model.split('/');
      const conf = data.providers?.[provider];
      if (conf?.models?.some((m) => m.id === modelId)) {
        console.log(`[gtw] findModelProviderConfig → ${provider}/${modelId} (api=${conf.api || 'anthropic-messages'})`);
        return {
          provider,
          baseUrl: conf.baseUrl || '',
          authHeader: conf.authHeader !== false,
          api: conf.api || 'anthropic-messages',
        };
      }
      return null;
    }

    // Fallback: search all providers for model id
    for (const [provider, conf] of Object.entries(data.providers || {})) {
      const hasModel = conf.models?.some((m) => m.id === model);
      if (hasModel) {
        console.log(`[gtw] findModelProviderConfig → ${provider}/${model} (api=${conf.api || 'anthropic-messages'})`);
        return {
          provider,
          baseUrl: conf.baseUrl || '',
          authHeader: conf.authHeader !== false,
          api: conf.api || 'anthropic-messages',
        };
      }
    }
  } catch {}
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
        // Second attempt also timed out — throw with cause
        throw new TimeoutError(timeout, 2, lastError ?? err);
      }
      throw err;
    }
  }
}

/**
 * Internal: single LLM API call with AbortController timeout.
 * @private
 */
async function _callAIOnce(model, systemPrompt, userPrompt, sessionKey, api, timeoutSeconds) {
  // Resolve agentId and modelsPath from sessionKey (always use current session's models.json)
  const agentId = sessionKey ? (sessionKey.split(':')[1] || 'main') : 'main';
  const modelsPath = join(homedir(), '.openclaw', 'agents', agentId, 'agent', 'models.json');

  const providerConfig = findModelProviderConfig(model, agentId, modelsPath);
  if (!providerConfig) throw new Error(`Model ${model} not found in models.json`);

  const { provider, baseUrl, authHeader } = providerConfig;
  const modelId = model.includes('/') ? model.split('/')[1] : model;
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

  const headers = { 'Content-Type': 'application/json' };

  // Priority 4: models.json inline apiKey
  if (!token) {
    try {
      const modelConf = JSON.parse(read(modelsPath, 'utf8'));
      token = modelConf.providers?.[provider]?.apiKey || null;
    } catch { /* no inline key */ }
  }

  if (token) {
    if (authHeader) {
      headers['Authorization'] = `Bearer ${token}`;
    } else {
      headers['x-api-key'] = token;
    }
  }

  const resolvedApi = providerConfig.api || 'openai-chat';
  let endpoint;
  let body;

  // Read models.json once for both api-specific config and maxTokens
  const modelConf = JSON.parse(read(modelsPath, 'utf8'));

  if (resolvedApi === 'anthropic-messages') {
    headers['anthropic-version'] = '2023-06-01';
    endpoint = baseUrl.replace(/\/v1\/?$/, '') + '/v1/messages';
    const maxTokens = (
      (modelConf.providers?.[provider]?.models || [])
        .find((m) => m.id === modelId)
    )?.maxTokens || 8192;

    body = { model: modelId, max_tokens: maxTokens, messages: [{ role: 'user', content: userPrompt }] };
    if (systemPrompt) body.system = systemPrompt;
  } else {
    endpoint = baseUrl + '/chat/completions';
    body = { model: modelId, messages: [] };
    if (systemPrompt) body.messages.push({ role: 'system', content: systemPrompt });
    body.messages.push({ role: 'user', content: userPrompt });
  }

  console.log(`[gtw] AI request → ${endpoint}`);

  // Apply timeout via AbortController
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
 * Priority: /gtw model config (gtw/config.json) > current session model.
 * @param {string|null} [sessionKey=null] - Session key to read session model from.
 *        If not provided, only gtw/config.json is consulted.
 * @param {object} [api] - OpenClaw plugin api (optional, for modelAuth in callAI)
 * @returns {{ model: string, modelProvider: string }}
 */
export async function resolveModel(sessionKey = null, api = null) {
  // 1. Session model (if sessionKey provided — throws if session not found or model missing)
  let model = null;
  let modelProvider = null;
  if (sessionKey) {
    const cfg = getConfig();
    const dmScope = cfg.session?.dmScope || 'main';
    const entry = getSessionEntry(sessionKey, dmScope, cfg);
    modelProvider = entry.modelProvider;
    model = entry.model;
  }

  // 2. gtw/config.json override (always checked; applies on top of session model)
  try {
    if (exists(CONFIG_FILE)) {
      const gtwConfig = JSON.parse(read(CONFIG_FILE, 'utf8'));
      if (gtwConfig.model) model = gtwConfig.model;
    }
  } catch {}

  // 3. At this point model must be set (sessionKey ensures this, or config fallback)
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
 * Uses jsonrepair to handle malformed JSON common in LLM outputs:
 * - Markdown code blocks (```json ... ```)
 * - Trailing commas, single quotes, unquoted keys
 * - Python keywords (True/False/None), unclosed quotes, missing colons
 * @param {string} text - Raw response text from LLM
 * @returns {object} Parsed JSON object
 * @throws {Error} If JSON cannot be repaired or result is not an object
 */
export function parseAIResponse(text) {
  // Step 1: Try jsonrepair
  try {
    const repaired = jsonrepair(text);
    let parsed = JSON.parse(repaired);

    // jsonrepair may return a string (double-encoded) or array (multi-object)
    // Handle double-encoded: string containing JSON object
    if (typeof parsed === 'string') {
      try {
        const reparsed = JSON.parse(parsed);
        if (typeof reparsed === 'object' && !Array.isArray(reparsed)) {
          return reparsed;
        }
      } catch {}
    }

    // Handle array from jsonrepair (e.g., text before/after JSON or multi-object)
    // Extract object if array contains exactly one object element
    if (Array.isArray(parsed)) {
      // Find first object element (skip string elements like "comment" or "text before")
      const obj = parsed.find(el => typeof el === 'object' && !Array.isArray(el));
      if (obj) return obj;
    }

    // If parsed is already an object (not array), return it
    if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}

  // Step 2: Direct JSON.parse fallback for clean JSON
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
