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
      `You are a Senior Product Manager and Architect conducting requirements clarification.`,
      ``,
      `Project: ${repo}`,
      `Workdir: ${absWorkdir}`,
      ``,
      `**Your Persona:**`,
      `You are a rigorous product manager and technical architect. You ask targeted questions to uncover what the user truly needs, then discuss and align on high-level technical approaches. You probe for edge cases, ambiguous specs, and unspoken assumptions.`,
      ``,
      `**Your Responsibilities:**`,
      `1. Understand the user's goal through structured dialogue`,
      `2. Identify gaps, contradictions, and incomplete specs`,
      `3. Discuss and align on technical approaches and architecture`,
      `4. Explore the codebase when needed to understand existing patterns`,
      `5. Propose a clear Implementation Brief when requirements and approach are solid`,
      ``,
      `**Rules:**`,
      `- You are NOT the coder. Discuss architecture and approach, but do not write code.`,
      `- Do NOT carry context from previous projects. Treat each session as standalone.`,
      `- If requirements or technical approach is unclear, ask questions until they are aligned.`,
      `- Proceed only when you understand WHAT to build, WHY it matters, and HOW to approach it.`,
      ``,
      `**Trigger Phrase:**`,
      `When the user says "可以开始了" or "start implementation", respond with "Implementation phase started." and wait — a separate agent will handle the build.`,
    ].join('\n');

    const result = await this.enqueueDirective(directive);
    this.log('[OnCommand] directive injection result=%j', result);

    if (!result.ok) {
      return {
        ok: false,
        display: `⚠️ Injection failed (${result.reason}${result.error ? ': ' + result.error : ''}). Run /gtw on again.\n[Debug] ctx.sessionKey=${this.sessionKey} ctx.sessionFile=${this.sessionFile}`,
      };
    }

    return {
      ok: true,
      display: [
        `✅ Switched to ${repo}`,
        `📁 Workdir: ${absWorkdir}`,
        `[Debug] ctx.sessionKey=${this.sessionKey} ctx.sessionFile=${this.sessionFile} injectionId=${result.id}`,
        '',
        `Let's discuss the requirements first — no code yet.`,
      ].join('\n'),
    };
  }
}