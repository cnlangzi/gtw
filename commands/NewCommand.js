import { Commander } from './Commander.js';
import { join } from 'path';
import { homedir } from 'os';
import { readFileSync, existsSync } from 'fs';
import { getWip, saveWip } from '../utils/wip.js';
import { extractMessages } from '../utils/session.js';

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

    const prompt = `Based on the following discussion, generate a GitHub issue.

IMPORTANT: You must respond with ONLY valid JSON. No markdown, no explanation, no code blocks. Just the JSON object.

${allMessages.map((m, i) => `[${m.role === 'user' ? 'User' : 'Assistant'} ${i + 1}]\n${m.text}`).join('\n\n')}

Respond with this exact JSON format (no trailing text):
{"title":"short conventional commit title","body":"## Background\n\n## Changes\n\n## Acceptance Criteria\n"}`;

    let rawText;
    try {
      const tmpDir = join(homedir(), '.openclaw', 'gtw');
      const sessionFile = join(tmpDir, `gtw-new-${Date.now()}.json`);

      const result = await this.api.runtime.agent.runEmbeddedPiAgent({
        sessionId: `gtw-new-${Date.now()}`,
        sessionFile,
        workspaceDir: process.cwd(),
        config: this.config,
        prompt,
        timeoutMs: 30000,
        runId: `gtw-new-${Date.now()}`,
        disableTools: true,
        provider: modelProvider,
        model,
      });

      rawText = (result.payloads || [])
        .map((p) => {
          if (p.type === 'text') return p.text || '';
          if (p.type === 'content_block' && p.content?.text) return p.content.text;
          return '';
        })
        .join('');

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

    // Strategy 3: Extract title/body from text patterns as last resort
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        title = parsed.title || '';
        body = parsed.body || '';
      } catch {
        match = null; // JSON-like text but not valid JSON
      }
    }

    if (!match) {
      // Strategy 3: Try regex to extract title and body separately
      const titleMatch = rawText.match(/(?:title\s*[:=]\s*["'`]?\s*([^"'`\n]{10,100})/i)
        || rawText.match(/^#?\s*(.+)$/m);
      const bodyMatch = rawText.match(/(?:body\s*[:=]\s*["'`]\s*)([\s\S]{50,})["'`]$/m)
        || rawText.match(/(?:##\s*(?:Changes?|Body|内容)[\s\S]{0,50})([\s\S]{50,})/m);

      if (titleMatch) {
        title = titleMatch[1].trim();
      }
      if (bodyMatch) {
        body = bodyMatch[1].trim();
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
