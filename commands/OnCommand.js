import { Commander } from './Commander.js';
import { existsSync } from 'fs';
import { join, isAbsolute } from 'path';
import { homedir } from 'os';
import { getRemoteRepo } from '../utils/git.js';
import { saveWip } from '../utils/wip.js';

export class OnCommand extends Commander {
  constructor(context) {
    super(context);
    this.sessionKey = context.sessionKey;
    this.injectMessage = context.injectMessage;
  }

  async execute(args) {
    const workdir = args[0];
    if (!workdir) throw new Error('Usage: /gtw on <workdir>');

    const expandedWorkdir = workdir.startsWith('~')
      ? join(homedir(), workdir.slice(1))
      : workdir;
    const absWorkdir = isAbsolute(expandedWorkdir)
      ? expandedWorkdir
      : join(process.cwd(), expandedWorkdir);

    if (!isAbsolute(absWorkdir)) {
      throw new Error('Please use an absolute path, e.g. /Users/name/code/myproject or ~/code/myproject');
    }
    if (!existsSync(absWorkdir)) throw new Error(`Directory not found: ${absWorkdir}`);

    const repo = getRemoteRepo(absWorkdir);
    saveWip({ workdir: absWorkdir, repo, createdAt: new Date().toISOString() });

    // Inject requirements phase directive so the agent knows to discuss before coding
    const phaseText = `Workdir: ${absWorkdir}\nRepo: ${repo}\n\nYou are in REQUIREMENTS CLARIFICATION phase.\n\nYour ONLY task right now:\n- Read and understand the existing code\n- Identify what the current code does and how it works\n- Confirm your understanding by describing it back to User\n- Ask any clarifying questions\n\nYou MUST NOT:\n- Write any code\n- Modify any files\n- Refactor anything\n- Suggest fixes (unless asked)\n\nWhen User confirms your understanding is correct and explicitly says "可以开始了" (or "you can start"), THEN you may begin implementation.\n\nReply format:\n## 当前理解\n[用自己的话描述代码逻辑]\n## 疑问\n[有任何不确定的地方列出来]`;
    this.injectMessage?.(this.sessionKey, phaseText);

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
