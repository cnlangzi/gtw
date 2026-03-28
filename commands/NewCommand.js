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
    this.extractFn = context.extractHumanMessages;
  }

  async execute(args) {
    const wip = getWip();
    if (!wip.repo) throw new Error('No repo set. Run /gtw on <workdir> first');

    const title = args[0] || '';
    const body = args.slice(1).join(' ') || '';

    // With title/body args: save directly
    if (title) {
      const updated = {
        ...wip,
        issue: { action: 'create', id: null, title, body },
        updatedAt: new Date().toISOString(),
      };
      saveWip(updated);
      return {
        ok: true,
        wip: updated,
        message: `Issue draft saved: "${title}"`,
        display: `📝 Issue draft saved\n\nTitle: ${title}\n\nBody:\n${body || '(none)'}\n\nRun /gtw confirm if satisfied, or describe changes to regenerate.`,
      };
    }

    // No args: show current draft or generate via LLM
    const current = wip.issue || {};
    if (current.title) {
      return {
        ok: true,
        hasDraft: true,
        draft: { title: current.title, body: current.body || '' },
        display: `Current draft:\n\nTitle: ${current.title}\n\nBody:\n${current.body || '(none)'}\n\nDescribe changes to regenerate, or run /gtw confirm if satisfied.`,
      };
    }

    // LLM generation
    return this._generateDraft(wip);
  }

  async _generateDraft(wip) {
    const { humanMessages, allMessages } = (this.extractFn || (() => ({ humanMessages: [], allMessages: [] })))();

    // Prepend repo/workdir + requirements-phase directive as the first user message
    const { workdir, repo } = wip;
    const phaseText = [
      repo ? `Repo: ${repo}` : null,
      workdir ? `Workdir: ${workdir}` : null,
      '',
      "Let's discuss the requirements first — no code yet.",
    ].filter(Boolean).join('\n');

    const discussionMessages = [{ role: 'user', text: phaseText }, ...allMessages];

    if (!allMessages.length) {
      return {
        ok: false,
        error: 'No conversation found. Run /gtw on <workdir> first, then describe what you want to create.',
      };
    }

    const prompt = `Based on the following discussion, generate a GitHub issue:

${discussionMessages.map((m, i) => `[${m.role === 'user' ? 'User' : 'Assistant'} ${i + 1}]\n${m.text}`).join('\n\n')}

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
      return { ok: false, error: `LLM call failed: ${e.message}` };
    }

    const match = rawText.match(/\{[\s\S]*?\}/);
    if (!match) {
      return { ok: false, error: `LLM did not return valid JSON. Response:\n${rawText.substring(0, 500)}` };
    }

    let title = '', body = '';
    try {
      const parsed = JSON.parse(match[0]);
      title = parsed.title || '';
      body = parsed.body || '';
    } catch {
      return { ok: false, error: `Failed to parse LLM JSON response: ${match[0].substring(0, 200)}` };
    }

    if (!title) {
      return { ok: false, error: 'LLM returned empty title. Try /gtw new <title> <body> manually.' };
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
