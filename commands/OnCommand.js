import { Commander } from './Commander.js';
import { injectPlanModeDirective } from '../utils/session.js';
import { existsSync } from 'fs';
import { join, isAbsolute } from 'path';
import { homedir } from 'os';
import { getRemoteRepo } from '../utils/git.js';
import { saveWip } from '../utils/wip.js';

export class OnCommand extends Commander {
  constructor(context) {
    super(context);
    this.sessionKey = context.sessionKey;
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

    // Inject PLAN MODE directive so the agent knows to discuss before coding
    const injected = injectPlanModeDirective(this.sessionKey, absWorkdir, repo);
    if (!injected) {
      console.warn(
        `[OnCommand] Failed to inject PLAN MODE directive for session ${this.sessionKey} (workdir: ${absWorkdir}, repo: ${repo ?? 'unknown'})`
      );
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
