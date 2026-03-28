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

    const prompt = `Based on the following discussion, generate a GitHub issue:

${allMessages.map((m, i) => `[${m.role === 'user' ? 'User' : 'Assistant'} ${i + 1}]\n${m.text}`).join('\n\n')}

Generate a GitHub issue with:
- title: short, descriptive, in conventional commit style (e.g. "fix: handle null pointer in auth" or "feat: add device flow auth")
- body: markdown with ## Background, ## Changes, ## Acceptance Criteria sections

Return ONLY valid JSON, nothing else:
{"title":"...","body":"..."}`;

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

    const match = rawText.match(/\{[\s\S]*?\}/);
    if (!match) {
      return { ok: false, message: `⚠️ AI didn't return valid JSON. Could you try again?` };
    }

    let title = '', body = '';
    try {
      const parsed = JSON.parse(match[0]);
      title = parsed.title || '';
      body = parsed.body || '';
    } catch {
      return { ok: false, message: `⚠️ Failed to parse AI response. Could you try again?` };
    }

    if (!title) {
      return { ok: false, message: "⚠️ Sorry, I couldn't extract a topic from our conversation. Could you describe what you'd like to create?" };
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
