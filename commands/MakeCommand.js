import { Commander } from './Commander.js';
import { getWip } from '../utils/wip.js';
import { exec } from '../utils/exec.js';
import { existsSync } from 'fs';
import { join, isAbsolute } from 'path';
import { homedir } from 'os';

/**
 * /gtw make [target] [--on <path>]
 * Execute a make target in the current workdir or in a specified directory.
 *
 * Options:
 *   --on <path>  Execute make in the specified directory (one-time, not persisted)
 */
export class MakeCommand extends Commander {
  async execute(args) {
    // Parse --on <path> from args
    let workdir = null;
    const filteredArgs = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--on' && i + 1 < args.length) {
        const pathArg = args[i + 1];
        i++; // skip next arg

        // Expand ~ to homedir
        const expandedPath = pathArg.startsWith('~')
          ? join(homedir(), pathArg.slice(1))
          : pathArg;
        // Resolve to absolute path
        workdir = isAbsolute(expandedPath)
          ? expandedPath
          : join(process.cwd(), expandedPath);

        // Validate directory exists
        if (!existsSync(workdir)) {
          return {
            ok: false,
            message: `Directory not found: ${workdir}`,
            display: `❌ Directory not found: ${workdir}`,
          };
        }
      } else {
        filteredArgs.push(args[i]);
      }
    }

    // If no --on provided, use wip.workdir
    if (!workdir) {
      const wip = getWip();
      if (!wip?.workdir) {
        return {
          ok: false,
          message: 'No workdir set. Run /gtw on <workdir> first.',
          display: '❌ No workdir set. Run /gtw on <workdir> first.',
        };
      }
      workdir = wip.workdir;
    }

    const target = filteredArgs.join(' ').trim();
    const cmd = target ? `make ${target}` : 'make';

    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    try {
      stdout = exec(cmd, {
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
