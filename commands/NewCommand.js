import { Commander } from './Commander.js';
import { join } from 'path';
import { homedir } from 'os';
import { getWip, saveWip } from '../utils/wip.js';

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
    return this._generateDraft(wip);
  }

  async _generateDraft(wip) {
    const { humanMessages, allMessages } = (this.extractMessages || (() => ({ humanMessages: [], allMessages: [] })))(this.sessionKey);

    if (!allMessages.length) {
      return {
        ok: false,
        message: "⚠️ No conversation found. Try describing what you want to create in the chat first.",
      };
    }

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
