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
      `🚨 [gtw] PLAN MODE — Requirements Clarification`,
      ``,
      `Project Structure:`,
      '```',
      treeOutput,
      '```',
      ``,
      `Workdir: ${absWorkdir}`,
      `Repo: ${repo}`,
      ``,
      `You are now in PLAN MODE for requirements clarification.`,
      ``,
      `## PLAN MODE Rules`,
      `1. You are in PLAN MODE. Your only job is to understand the codebase and clarify requirements.`,
      `2. You may NOT take ANY action that modifies files or state:`,
      `   - Do NOT create, edit, or delete any files`,
      `   - Do NOT run build/test/deploy commands or any shell commands that change state`,
      `   - Do NOT propose implementation plans or code changes`,
      `   - Do NOT write code, even if the user asks`,
      `3. If the user asks to see code or understand a file, read it and explain.`,
      `4. If the user asks a question, answer based on the code you read.`,
      `5. When the user says EXACTLY one of these trigger phrases, you may exit PLAN MODE and start implementing:`,
      `   - "可以开始了" (you can start)`,
      `   - "start implementation"`,
      `   - "begin"`,
      `   Any other phrase — including "analyze", "check", "review", "look at" — does NOT trigger implementation.`,
      `6. If the user says anything that sounds like a request to start coding, remind them of the trigger phrase.`,
      ``,
      `## Expected Behavior`,
      `After understanding the codebase, respond with:`,
      ``,
      `## 当前理解`,
      `## 疑问`,
      ``,
      `Then wait. Do nothing else until the user explicitly uses a trigger phrase.`,
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