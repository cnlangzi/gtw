import { existsSync, statSync } from 'fs';
import { join, isAbsolute } from 'path';
import { homedir } from 'os';

/**
 * Expand a path that may start with ~ or ~/ and resolve it to an absolute path.
 *
 * @param {string} inputPath - The path to expand (e.g., "~", "~/foo", "/absolute", "relative")
 * @returns {{ expanded: string, isAbsolute: boolean, isValid: boolean }}
 *   expanded: The resolved absolute path
 *   isAbsolute: Whether the original input was absolute (after ~ expansion)
 *   isValid: Whether the path exists and is a directory
 */
export function expandPath(inputPath) {
  let expanded;

  if (inputPath === '~') {
    expanded = homedir();
  } else if (inputPath.startsWith('~/')) {
    expanded = join(homedir(), inputPath.slice(2));
  } else if (inputPath.startsWith('~')) {
    // ~user/path style - fall back to homedir for ~user part
    expanded = join(homedir(), inputPath.slice(1));
  } else {
    expanded = inputPath;
  }

  const absPath = isAbsolute(expanded)
    ? expanded
    : join(process.cwd(), expanded);

  const isValid = existsSync(absPath) && statSync(absPath).isDirectory();

  return {
    expanded: absPath,
    isAbsolute: isAbsolute(expanded),
    isValid,
  };
}
