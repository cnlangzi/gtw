import { Commander } from './Commander.js';
import { existsSync } from 'fs';
import { join, isAbsolute } from 'path';
import { homedir } from 'os';
import { getRemoteRepo } from '../utils/git.js';
import { saveWip } from '../utils/wip.js';

export class OnCommand extends Commander {
  constructor(context) {
    super(context);
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

    // Inject phase directive into parent session so the agent knows we're in discussion mode
    const phaseText = `Workdir: ${absWorkdir}\nRepo: ${repo}\n\nLet's discuss the requirements first — no code yet.`;
    this.injectMessage?.(phaseText);

    return {
      ok: true,
      workdir: absWorkdir,
      repo,
      display: [
        `✅ Switched to ${repo}`,
        `📁 Workdir: ${absWorkdir}`,
        '',
        `Injected phase directive into session.`,
      ].join('\n'),
      message: `workdir set to ${absWorkdir}, repo: ${repo}`,
    };
  }
}
