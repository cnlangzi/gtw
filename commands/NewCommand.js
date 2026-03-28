import { Commander } from './Commander.js';
import { join } from 'path';
import { homedir } from 'os';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { getWip, saveWip } from '../utils/wip.js';
import { extractMessages } from '../utils/session.js';

/**
 * Make a direct API call to MiniMax using OAuth token from auth-profiles.json.
 * @param {string} token - OAuth access token
 * @param {string} model - Model name (e.g. MiniMax-M2.7)
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<string>} - Response text
 */
async function callMiniMaxApi(token, model, systemPrompt, userPrompt) {
  const res = await fetch('https://api.minimaxi.com/anthropic/v1/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MiniMax API ${res.status}: ${text}`);
  }

  const data = await res.json();
  // Extract text from Anthropic message format
  const content = data.content || [];
  if (Array.isArray(content)) {
    return content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  }
  return String(data.content || data.text || '');
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

    // Resolve the current session's model from sessions.json to pass to subagent
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
      // Read OAuth token from auth-profiles.json
      const authPath = join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
      const authData = JSON.parse(readFileSync(authPath, 'utf8'));
      const token = authData.profiles?.['minimax-portal:default']?.access;
      if (!token) throw new Error('No OAuth token found in auth-profiles.json');

      rawText = await callMiniMaxApi(token, model, systemPrompt, prompt);

      // Save session for audit
      const sessionFile = join(tmpDir, `gtw-new-${Date.now()}.json`);
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
