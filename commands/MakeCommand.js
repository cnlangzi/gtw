import { Commander } from './Commander.js';
import { getWip } from '../utils/wip.js';
import { exec } from '../utils/exec.js';
import { existsSync, statSync } from 'fs';
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
      if (args[i] === '--on') {
        const pathArg = args[i + 1];

        // Detect missing path argument
        if (!pathArg || pathArg.startsWith('-')) {
          return {
            ok: false,
            message: '/gtw make --on requires a path argument. Usage: /gtw make [target] --on <path>',
            display: '❌ /gtw make --on requires a path argument. Usage: /gtw make [target] --on <path>',
          };
        }
        i++; // skip next arg

        // Expand ~ or ~/ to homedir
        let expandedPath = pathArg;
        if (pathArg === '~') {
          expandedPath = homedir();
        } else if (pathArg.startsWith('~/')) {
          expandedPath = join(homedir(), pathArg.slice(2));
        }

        // Resolve to absolute path
        workdir = isAbsolute(expandedPath)
          ? expandedPath
          : join(process.cwd(), expandedPath);

        // Validate it's a directory
        if (!existsSync(workdir) || !statSync(workdir).isDirectory()) {
          return {
            ok: false,
            message: `Not a directory: ${workdir}`,
            display: `❌ Not a directory: ${workdir}`,
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
        cwd: workdir,
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
