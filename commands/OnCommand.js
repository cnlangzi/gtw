import { Commander } from './Commander.js';
import { injectPlanModeDirective } from '../utils/session.js';
import { expandPath } from '../utils/path.js';
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

    const { expanded: absWorkdir, isAbsolute: wasAbsolute, isValid } = expandPath(workdir);

    if (!wasAbsolute) {
      throw new Error('Please use an absolute path, e.g. /Users/name/code/myproject or ~/code/myproject');
    }
    if (!isValid) throw new Error(`Directory not found: ${absWorkdir}`);

    const repo = getRemoteRepo(absWorkdir);
    saveWip({ workdir: absWorkdir, repo, sessionKey: this.sessionKey, createdAt: new Date().toISOString() });

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
