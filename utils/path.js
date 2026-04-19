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
    // ~user/path style — strip ~user, replace with current homedir
    // (does not resolve to actual user's home dir; requires os.userInfo for full support)
    const afterTilde = inputPath.slice(1);
    const slashIdx = afterTilde.indexOf('/');
    const userPart = slashIdx >= 0 ? afterTilde.slice(0, slashIdx) : afterTilde;
    const pathPart = slashIdx >= 0 ? afterTilde.slice(slashIdx) : '';
    expanded = join(homedir(), pathPart);
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
