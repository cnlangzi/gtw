import { Commander } from './Commander.js';
import { getDirectoryTree } from '../utils/session.js';
import { expandPath } from '../utils/path.js';
import { getRemoteRepo } from '../utils/git.js';
import { saveWip } from '../utils/wip.js';

export class OnCommand extends Commander {
  async execute(args) {
    const workdir = args[0];
    if (!workdir) throw new Error('Usage: /gtw on <workdir>');

    const { expanded: absWorkdir, isAbsolute: wasAbsolute, isValid } = expandPath(workdir);

    if (!wasAbsolute) {
      throw new Error('Please use an absolute path, e.g. /Users/name/code/myproject or ~/code/myproject');
    }
    if (!isValid) throw new Error(`Directory not found: ${absWorkdir}`);

    const repo = getRemoteRepo(absWorkdir);
    this.log('[OnCommand] sessionKey=%s sessionFile=%s workdir=%s repo=%s', !!this.sessionKey, !!this.sessionFile, absWorkdir, repo);
    saveWip({ workdir: absWorkdir, repo, sessionKey: this.sessionKey, createdAt: new Date().toISOString() });

    const treeOutput = getDirectoryTree(absWorkdir);
    const directive = [
      `🚨 [gtw] You are a Senior Product Manager conducting requirements clarification.`,
      ``,
      `📁 Workdir: ${absWorkdir}`,
      `📂 Repo: ${repo}`,
      ``,
      `Project Structure:`,
      '```',
      treeOutput,
      '```',
      ``,
      `Your role: Understand what the user wants to build, probe gaps in understanding, and ensure the implementation plan is solid before any code is written.`,
      ``,
      `As a Senior Product Manager, your focus is on:`,
      `- Understanding user needs and translating them into clear requirements`,
      `- Identifying ambiguous or incomplete specifications`,
      `- Exploring the codebase to understand existing patterns and constraints`,
      `- Asking targeted questions to fill knowledge gaps`,
      `- Structuring a clear implementation brief when ready`,
      ``,
      `Implementation is handled by a separate coding phase — you are not the coder.`,
      ``,
      `## Exit Rule`,
      `When you have fully understood the requirements and the user explicitly says "可以开始了" or "start implementation", the coding phase will begin. No other phrase triggers implementation — not "analyze", "check", "review", "look at", or any other natural language request.`,
    ].join('\n');

    const injected = await this.enqueueDirective(directive);
    if (!injected) {
      console.warn(`[OnCommand] Failed to enqueue PLAN MODE directive for session ${this.sessionKey}`);
    }

    return {
      ok: true,
      workdir: absWorkdir,
      repo,
      display: [
        `✅ Switched to ${repo}`,
        `📁 Workdir: ${absWorkdir}`,
        '',
        `Let's discuss the requirements first — no code yet.`,
      ].join('\n'),
      message: `workdir set to ${absWorkdir}, repo: ${repo}`,
    };
  }
}