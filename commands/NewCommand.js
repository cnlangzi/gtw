import { Commander } from './Commander.js';
import { join } from 'path';
import { homedir } from 'os';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { getWip, saveWip } from '../utils/wip.js';
import { extractMessages } from '../utils/session.js';
import { getConfig, getLangLabel } from '../utils/config.js';

/**
 * Find the provider config for a given model from OpenClaw's models.json.
 * Supports "model-id" (searches all providers) or "provider/model-id" (direct lookup).
 * @param {string} model - Model id (e.g. MiniMax-M2.7 or github/gpt-5-mini)
 * @returns {{ provider: string, baseUrl: string, authHeader: boolean, api: string } | null}
 */
function findModelProviderConfig(model) {
  const modelsPath = join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'models.json');
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
 * Supports both Anthropic and OpenAI message formats.
 * @param {string} model - Model id
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<string>} - Response text
 */
async function callAI(model, systemPrompt, userPrompt) {
  // 1. Find provider config from models.json
  const providerConfig = findModelProviderConfig(model);
  if (!providerConfig) throw new Error(`Model ${model} not found in models.json`);

  const { provider, baseUrl, authHeader } = providerConfig;
  // Strip provider prefix for the actual API call (provider/model → model)
  const modelId = model.includes('/') ? model.split('/')[1] : model;
  const authKey = `${provider}:default`;

  // 2. Get token from auth-profiles.json (optional — some local providers need no token)
  const headers = { 'Content-Type': 'application/json' };
  try {
    const authPath = join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
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

  // 4. Determine API format from models.json api field
  const api = providerConfig.api || 'openai-chat';
  let endpoint;
  let body;

  if (api === 'anthropic-messages') {
    headers['anthropic-version'] = '2023-06-01';
    const fullEndpoint = baseUrl.replace(/\/$/, '') + '/v1/messages';
    const modelConf = JSON.parse(readFileSync(join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'models.json'), 'utf8'));
    const maxTokens = (
      (modelConf.providers?.[provider]?.models || [])
        .find((m) => m.id === modelId)
    )?.maxTokens || 1024;

    body = { model: modelId, max_tokens: maxTokens, messages: [{ role: 'user', content: userPrompt }] };
    if (systemPrompt) body.system = systemPrompt;

    console.error('[gtw DEBUG] POST', fullEndpoint);
    console.error('[gtw DEBUG] token prefix:', token.slice(0, 8));
    console.error('[gtw DEBUG] body keys:', Object.keys(body));

    const res = await fetch(fullEndpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    console.error('[gtw DEBUG] status:', res.status, 'body prefix:', text.slice(0, 200));
    if (!res.ok) throw new Error(`API ${res.status}: ${text}`);
    const data = JSON.parse(text);
    return (data.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('');

  } else {
    // Default: OpenAI chat completions
    endpoint = baseUrl.replace(/\/$/, '') + '/chat/completions';
    body = { model: modelId, messages: [] };
    if (systemPrompt) body.messages.push({ role: 'system', content: systemPrompt });
    body.messages.push({ role: 'user', content: userPrompt });

    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.choices || []).map((c) => c.message?.content || '').join('');
  }
}

export class NewCommand extends Commander {
  /**
   * @param {{ api: object, config: object }} context
   */
  constructor(context) {
    super(context);
    this.api = context.api;
    this.config = context.config;
    this.sessionKey = context.sessionKey;
    this.extractMessages = context.extractMessages;
  }

  async execute(args) {
    const wip = getWip();

    // Read full openclaw.json config for session.dmScope, session.identityLinks, session.mainKey
    let cfg = {};
    try {
      cfg = JSON.parse(readFileSync(join(homedir(), '.openclaw', 'openclaw.json'), 'utf8'));
    } catch {}

    const dmScope = cfg.session?.dmScope || 'main';
    const MAIN_AGENT_SESSION = 'agent:main:main';
    const { allMessages } = (this.extractMessages || extractMessages)(MAIN_AGENT_SESSION);

    if (!allMessages.length) {
      return {
        ok: false,
        message: "⚠️ No conversation found. Try describing what you want to create in the chat first.",
      };
    }

    // Resolve the current session's model from sessions.json
    let modelProvider = 'minimax-portal';
    let model = 'MiniMax-M2.7';
    try {
      const sessionsPath = join(homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
      if (existsSync(sessionsPath)) {
        const sessionsData = JSON.parse(readFileSync(sessionsPath, 'utf8'));
        const mainSession = sessionsData[MAIN_AGENT_SESSION];
        if (mainSession) {
          modelProvider = mainSession.modelProvider || modelProvider;
          model = mainSession.model || model;
        }
      }
    } catch {}

    // gtw model override (set via /gtw model or /gtw config set model)
    // Resolve repo language: lang:<owner/repo> from config, default 'en'
    const repo = wip?.repo || null;
    const langKey = repo ? `lang:${repo}` : null;
    let lang = 'en';
    try {
      const gtwConfig = getConfig();
      if (gtwConfig.model) model = gtwConfig.model;
      if (langKey) lang = gtwConfig[langKey] || 'en';
    } catch {}

    // Clean messages: strip role prefixes and any JSON-like metadata from discussion
    const cleanMessages = allMessages.map((m) => m.text.replace(/\[(?:User|Assistant)\s*\d+\]\s*/g, '').trim()).join('\n\n');

    // Language-aware prompt — English template with dynamic language instruction
    const langLabel = getLangLabel(lang);
    const prompt = `Write a GitHub issue from this discussion. Output ONLY valid JSON, nothing else.
Generate the issue title and body in ${langLabel}.

Discussion:
${cleanMessages}

JSON:`;

    // Ensure tmp dir exists for session file
    const tmpDir = join(homedir(), '.openclaw', 'gtw');
    mkdirSync(tmpDir, { recursive: true });

    const langLabel = getLangLabel(lang);
    const systemPrompt = `You write GitHub issues from discussions. You ONLY output valid JSON. No markdown. No explanation. No text outside the JSON object.
Generate the issue title and body in ${langLabel}.

JSON format:
{"title":"fix: short description","body":"## Background\\n\\n## Changes\\n\\n## Acceptance Criteria\\n"}`;

    let rawText;
    try {
      rawText = await callAI(model, systemPrompt, prompt);
      console.error('[gtw DEBUG] rawText length:', rawText.length, 'first 300:', JSON.stringify(rawText.slice(0, 300)));
    } catch (e) {
      return { ok: false, message: `⚠️ AI call failed: ${e.message}` };
    }

    // Extract JSON with multiple fallback strategies
    let title = '', body = '';

    // Strategy 0: rawText is a bare JSON object {"title":...,"body":...}
    try {
      const parsed = JSON.parse(rawText);
      console.error('[gtw DEBUG] Strategy 0 parse OK, parsed type:', typeof parsed, 'keys:', Object.keys(parsed).join(','));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed.title || parsed.body)) {
        title = parsed.title || '';
        body = parsed.body || '';
        console.error('[gtw DEBUG] Strategy 0 matched, title:', title.slice(0, 80));
      } else {
        console.error('[gtw DEBUG] Strategy 0 condition failed: parsed type:', typeof parsed, 'isArray:', Array.isArray(parsed), 'hasTitle:', !!(parsed && parsed.title), 'hasBody:', !!(parsed && parsed.body));
      }
    } catch (e) {
      console.error('[gtw DEBUG] Strategy 0 failed:', e.message);
    }

    // Strategy 1: rawText is a JSON string "{\"title\":...}" (starts with outer quotes)
    if (!title) {
      try {
        const inner = JSON.parse(rawText);
        // inner is the parsed JSON — if it's a string (JSON string in JSON), parse again
        const obj = typeof inner === 'string' ? JSON.parse(inner) : inner;
        console.error('[gtw DEBUG] Strategy 1 parse OK, keys:', Object.keys(obj).join(','));
        if (obj && (obj.title || obj.body)) {
          title = obj.title || '';
          body = obj.body || '';
          console.error('[gtw DEBUG] Strategy 1 matched, title:', title.slice(0, 80));
        }
      } catch (e) {
        console.error('[gtw DEBUG] Strategy 1 failed:', e.message);
      }
    }

    // Strategy 2: Strip markdown code fences, then find JSON object
    if (!title) {
      let cleanText = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      console.error('[gtw DEBUG] Strategy 2 cleanText starts with:', cleanText.slice(0, 50).replace(/\n/g, '\\n'));
      const match = cleanText.match(/\{[\s\S]*?\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          console.error('[gtw DEBUG] Strategy 2 parse OK, keys:', Object.keys(parsed).join(','));
          if (parsed && (parsed.title || parsed.body)) {
            title = parsed.title || '';
            body = parsed.body || '';
            console.error('[gtw DEBUG] Strategy 2 matched, title:', title.slice(0, 80));
          }
        } catch (e) {
          console.error('[gtw DEBUG] Strategy 2 JSON parse failed:', e.message);
        }
      }
    }

    // Strategy 3: Plain text fallback — split by newlines, take first meaningful line as title
    if (!title) {
      const text = rawText.replace(/\r/g, '');
      const parts = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      if (parts.length > 0) {
        title = parts[0].replace(/^#+ /, '');
        if (title.length < 5 || title.length > 100) title = '';
      }
    }
    if (!title) {
      const preview = rawText.slice(0, 200).replace(/\n/g, ' ');
      return {
        ok: false,
        message: `⚠️ AI didn't return valid JSON. Raw response (${rawText.length} chars): ${preview}`,
      };
    }

    const updated = { ...wip, issue: { action: 'create', id: null, title, body }, updatedAt: new Date().toISOString() };
    saveWip(updated);

    return {
      ok: true,
      wip: updated,
      message: `Issue draft generated: "${title}"`,
      display: `Draft saved:\n\nTitle: ${title}\n\nBody:\n${body}\n\nRun /gtw confirm to create the issue.`,
    };
  }
}
