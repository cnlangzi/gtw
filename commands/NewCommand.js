import { Commander } from './Commander.js';
import { join } from 'path';
import { homedir } from 'os';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { getWip, saveWip } from '../utils/wip.js';
import { extractMessages, resolveRealSessionKey } from '../utils/session.js';
import { getConfig, getLangLabel } from '../utils/config.js';
import { callAI, resolveModel } from '../utils/ai.js';

export class NewCommand extends Commander {
  /**
   * @param {{ api: object, config: object }} context
   */
  constructor(context) {
    super(context);
    this.api = context.api;
    this.config = context.config;
    this.sessionKey = context.sessionKey;
  }

  async execute(args) {
    const wip = getWip();

    // Read full openclaw.json config for session.dmScope, session.identityLinks, session.mainKey
    let cfg = {};
    try {
      cfg = JSON.parse(readFileSync(join(homedir(), '.openclaw', 'openclaw.json'), 'utf8'));
    } catch {}

    const dmScope = cfg.session?.dmScope || 'main';
    const realSessionKey = resolveRealSessionKey(this.sessionKey, dmScope, cfg);
    const { allMessages } = extractMessages(realSessionKey);

    if (!allMessages.length) {
      return {
        ok: false,
        message: "⚠️ No conversation found. Try describing what you want to create in the chat first.",
      };
    }

    // Resolve model from session (throws if missing) + gtw/config.json override
    const { model, modelProvider } = await resolveModel(realSessionKey);

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

    // Language label for AI prompts (used in both prompt and systemPrompt below)
    const langLabel = getLangLabel(lang);

    // Clean messages: strip role prefixes and any JSON-like metadata from discussion
    const cleanMessages = allMessages.map((m) => m.text.replace(/\[(?:User|Assistant)\s*\d+\]\s*/g, '').trim()).join('\n\n');

    // Language-aware prompt — generates issue in the configured language
    const prompt = `Write a GitHub issue from this discussion. Output ONLY valid JSON, nothing else.
Generate the issue title and body in ${langLabel}.

Discussion:
${cleanMessages}

JSON:`;

    // Ensure tmp dir exists for session file
    const tmpDir = join(homedir(), '.openclaw', 'gtw');
    mkdirSync(tmpDir, { recursive: true });

    const systemPrompt = `You write GitHub issues from discussions. You ONLY output valid JSON. No markdown. No explanation. No text outside the JSON object.
Generate the issue title and body in ${langLabel}.

JSON format:
{"title":"fix: short description","body":"## Background\\n\\n## Changes\\n\\n## Acceptance Criteria\\n"}`;

    const agentId = realSessionKey?.split(':')[1] || 'main';
    let rawText;
    try {
      rawText = await callAI(model, systemPrompt, prompt, agentId);
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
