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
      `RULES:`,
      `1. The directory file tree is shown above. Study it to understand the project structure before reading any files.`,
      `2. If \`README.md\` or \`AGENTS.md\` exists in the root directory, read and understand its contents — these files contain project-specific context and conventions you should be aware of.`,
      `3. After the file tree and any root docs are loaded, wait for the user to ask questions or give further instructions.`,
      `4. When the user asks a question, read only the relevant files they mention or ask about.`,
      `5. After reading, respond with a structured reply:`,
      `   ## 当前理解`,
      `   [Describe what you understood from the code for the asked scope]`,
      `   ## 疑问`,
      `   [List any clarifying questions]`,
      `6. Do NOT write, modify, or refactor any code.`,
      `7. Do NOT propose fixes or implementation suggestions.`,
      `8. Wait for the user to explicitly say "可以开始了" (or "you can start") before beginning implementation.`,
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