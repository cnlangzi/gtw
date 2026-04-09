import { Commander } from './Commander.js';
import { getWip } from '../utils/wip.js';
import { execSync } from 'child_process';

/**
 * /gtw make [target]
 * Execute a make target in the current workdir.
 */
export class MakeCommand extends Commander {
  async execute(args) {
    const wip = getWip();

    if (!wip?.workdir) {
      return {
        ok: false,
        message: 'No workdir set. Run /gtw on <workdir> first.',
        display: '❌ No workdir set. Run /gtw on <workdir> first.',
      };
    }

    const target = args.join(' ').trim();
    const cmd = target ? `make ${target}` : 'make';

    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    try {
      stdout = execSync(cmd, {
        cwd: wip.workdir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (e) {
      stdout = e.stdout?.trim() || '';
      stderr = e.stderr?.trim() || '';
      exitCode = e.status ?? 1;
    }

    const output = [stdout, stderr].filter(Boolean).join('\n');
    const exitMsg = exitCode !== 0 ? `\n[exit ${exitCode}]` : '';

    return {
      ok: true,
      exitCode,
      message: output + exitMsg,
      display: output + exitMsg,
    };
  }
}
