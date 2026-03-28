import { Commander } from './Commander.js';
import { join } from 'path';
import { homedir } from 'os';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { getWip, saveWip } from '../utils/wip.js';
import { extractMessages } from '../utils/session.js';

/**
 * Find the provider config for a given model from OpenClaw's models.json.
 * Searches all providers to find which one hosts the model.
 * @param {string} model - Model id (e.g. MiniMax-M2.7)
 * @returns {{ provider: string, baseUrl: string, authHeader: boolean, api: string } | null}
 */
function findModelProviderConfig(model) {
  const modelsPath = join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'models.json');
  if (!existsSync(modelsPath)) return null;
  try {
    const data = JSON.parse(readFileSync(modelsPath, 'utf8'));
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
  const authKey = `${provider}:default`;

  // 2. Get token from auth-profiles.json
  const authPath = join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
  const authData = JSON.parse(readFileSync(authPath, 'utf8'));
  const token = authData.profiles?.[authKey]?.access;
  if (!token) throw new Error(`No token for ${authKey} in auth-profiles.json`);

  // 3. Build headers
  const headers = {
    'Content-Type': 'application/json',
  };
  if (authHeader) {
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    headers['x-api-key'] = token;
  }

  // 4. Determine format from baseUrl or API type
  const isAnthropic = baseUrl.includes('anthropic') || provider.includes('anthropic') || provider.includes('minimax');
  const isOpenAI = baseUrl.includes('openai') || !isAnthropic;

  let body;
  if (isAnthropic) {
    // Anthropic messages API
    headers['anthropic-version'] = '2023-06-01';
    const endpoint = baseUrl.replace(/\/$/, '') + '/v1/messages';
    const modelConf = JSON.parse(readFileSync(join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'models.json'), 'utf8'));
    const maxTokens = (
      (modelConf.providers?.[provider]?.models || [])
        .find((m) => m.id === model)
    )?.maxTokens || 1024;

    body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: userPrompt }] };
    if (systemPrompt) body.system = systemPrompt;

    console.error('[gtw DEBUG] POST', endpoint);
    console.error('[gtw DEBUG] headers:', JSON.stringify(headers));
    console.error('[gtw DEBUG] body:', JSON.stringify(body).slice(0, 300));

    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  } else {
    // OpenAI chat completions API
    const endpoint = baseUrl.replace(/\/$/, '') + '/chat/completions';
    body = {
      model,
      messages: [],
    };
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

    // gtw model override (set via /gtw model)
    try {
      const gtwConfigPath = join(homedir(), '.openclaw', 'gtw', 'config.json');
      if (existsSync(gtwConfigPath)) {
        const gtwConfig = JSON.parse(readFileSync(gtwConfigPath, 'utf8'));
        if (gtwConfig.model) model = gtwConfig.model;
      }
    } catch {}

    const prompt = `You generate a GitHub issue from a discussion. Output ONLY valid JSON — no markdown, no code fences, no explanation, no extra text.

Example:
Input: a discussion about fixing a bug
Output: {"title":"fix: handle null pointer in auth","body":"## Background\\n\\n## Changes\\n\\n## Acceptance Criteria\\n"}

${allMessages.map((m, i) => `[${m.role === 'user' ? 'User' : 'Assistant'} ${i + 1}]\n${m.text}`).join('\n\n')}

Output only the JSON object:`;

    // Ensure tmp dir exists for session file
    const tmpDir = join(homedir(), '.openclaw', 'gtw');
    mkdirSync(tmpDir, { recursive: true });

    const systemPrompt = 'You must respond with ONLY valid JSON. No markdown, no code fences, no explanation. Output exactly: {"title":"...","body":"..."}';

    let rawText;
    try {
      rawText = await callAI(model, systemPrompt, prompt);
    } catch (e) {
      return { ok: false, message: `⚠️ AI call failed: ${e.message}` };
    }

    // Extract JSON with multiple fallback strategies
    let title = '', body = '';

    // Strategy 1: JSON in markdown code blocks
    let match = rawText.match(/```(?:json)?\s*\n?(\{[\s\S]*?\})\n?```/);

    // Strategy 2: Any JSON object in text
    if (!match) {
      match = rawText.match(/\{[\s\S]*?\}/);
    }

    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        title = parsed.title || '';
        body = parsed.body || '';
      } catch {
        match = null;
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
      return {
        ok: false,
        message: `⚠️ AI didn't return valid JSON and couldn't extract issue data. Try again: make sure your response is ONLY valid JSON like {"title":"...","body":"..."}`,
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
