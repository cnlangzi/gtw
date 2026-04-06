import { join } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { getConfig, CONFIG_FILE } from './config.js';
import { getSessionEntry } from './session.js';

/**
 * Find the provider config for a given model from OpenClaw's models.json.
 * Supports "model-id" (searches all providers) or "provider/model-id" (direct lookup).
 * @param {string} model - Model id (e.g. MiniMax-M2.7 or github/gpt-5-mini)
 * @param {string} [agentId='main'] - Agent ID for models.json lookup
 * @returns {{ provider: string, baseUrl: string, authHeader: boolean, api: string } | null}
 */
export function findModelProviderConfig(model, agentId = 'main') {
  const modelsPath = join(homedir(), '.openclaw', 'agents', agentId, 'agent', 'models.json');
  if (!existsSync(modelsPath)) return null;
  try {
    const data = JSON.parse(readFileSync(modelsPath, 'utf8'));

    // Direct lookup: "provider/model-id"
    if (model.includes('/')) {
      const [provider, modelId] = model.split('/');
      const conf = data.providers?.[provider];
      if (conf?.models?.some((m) => m.id === modelId)) {
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
        return {
          provider,
          baseUrl: conf.baseUrl || '',
          authHeader: conf.authHeader !== false,
          api: conf.api || 'anthropic-messages',
        };
      }
    }
  } catch {}
  return null;
}

/**
 * Make an AI API call using OpenClaw's model + auth configuration.
 * @param {string} model - Model id (with optional provider prefix)
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {string} [agentId='main'] - Agent ID for models.json lookup
 * @returns {Promise<string>} - Response text
 */
export async function callAI(model, systemPrompt, userPrompt, agentId = 'main') {
  const providerConfig = findModelProviderConfig(model, agentId);
  if (!providerConfig) throw new Error(`Model ${model} not found in models.json`);

  const { provider, baseUrl, authHeader } = providerConfig;
  const modelId = model.includes('/') ? model.split('/')[1] : model;
  const authKey = `${provider}:default`;

  const headers = { 'Content-Type': 'application/json' };
  try {
    const authPath = join(homedir(), '.openclaw', 'agents', agentId, 'agent', 'auth-profiles.json');
    const authData = JSON.parse(readFileSync(authPath, 'utf8'));
    const token = authData.profiles?.[authKey]?.access;
    if (token) {
      if (authHeader) {
        headers['Authorization'] = `Bearer ${token}`;
      } else {
        headers['x-api-key'] = token;
      }
    }
  } catch { /* no auth needed */ }

  const api = providerConfig.api || 'openai-chat';
  let endpoint;
  let body;

  if (api === 'anthropic-messages') {
    headers['anthropic-version'] = '2023-06-01';
    endpoint = baseUrl.replace(/\/$/, '') + '/v1/messages';
    const modelsPath = join(homedir(), '.openclaw', 'agents', agentId, 'agent', 'models.json');
    const modelConf = JSON.parse(readFileSync(modelsPath, 'utf8'));
    const maxTokens = (
      (modelConf.providers?.[provider]?.models || [])
        .find((m) => m.id === modelId)
    )?.maxTokens || 8192;

    body = { model: modelId, max_tokens: maxTokens, messages: [{ role: 'user', content: userPrompt }] };
    if (systemPrompt) body.system = systemPrompt;
  } else {
    endpoint = baseUrl.replace(/\/$/, '') + '/chat/completions';
    body = { model: modelId, messages: [] };
    if (systemPrompt) body.messages.push({ role: 'system', content: systemPrompt });
    body.messages.push({ role: 'user', content: userPrompt });
  }

  const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

  if (api === 'anthropic-messages') {
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
 * @returns {{ model: string, modelProvider: string }}
 */
export async function resolveModel(sessionKey = null) {
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
    if (existsSync(CONFIG_FILE)) {
      const gtwConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
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
