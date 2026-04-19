import { existsSync, statSync } from 'fs';
import { join, isAbsolute } from 'path';
import { homedir } from 'os';

/**
 * Expand a path that may start with ~ or ~/ and resolve it to an absolute path.
 * Bare relative paths (e.g. "code/foo") are treated as relative to homedir (~/code/foo).
 * Only truly relative paths that should be joined with cwd are those starting with "./" or "../".
 *
 * @param {string} inputPath - The path to expand (e.g., "~", "~/foo", "/absolute", "code/foo", "./foo", "../foo")
 * @returns {{ expanded: string, isAbsolute: boolean, isValid: boolean }}
 *   expanded: The resolved absolute path
 *   isAbsolute: Whether the path is absolute-style (NOT ./ or ../ relative to cwd)
 *   isValid: Whether the expanded path exists and is a directory
 */
export function expandPath(inputPath) {
  let expanded;
  let usesHomedir = false;

  if (inputPath === '~') {
    expanded = homedir();
    usesHomedir = true;
  } else if (inputPath.startsWith('~/')) {
    expanded = join(homedir(), inputPath.slice(2));
    usesHomedir = true;
  } else if (inputPath.startsWith('~')) {
    // ~user/path or ~user — keep the full segment after ~ as the first path under homedir
    // ~code/project → ~/code/project  (preserves the typo "code/" segment)
    // ~code          → ~/code
    const afterTilde = inputPath.slice(1); // "user/path" or "user"
    expanded = join(homedir(), afterTilde);
    usesHomedir = true;
  } else if (isAbsolute(inputPath)) {
    expanded = inputPath;
  } else if (inputPath.startsWith('./') || inputPath.startsWith('../')) {
    // Explicit relative-to-cwd path
    expanded = join(process.cwd(), inputPath);
  } else {
    // Bare relative path — default to ~/path
    expanded = join(homedir(), inputPath);
    usesHomedir = true;
  }

  const isValid = existsSync(expanded) && statSync(expanded).isDirectory();

  return {
    expanded,
    // isAbsolute: true for paths that don't need cwd joining (not ./ or ../ prefixed)
    isAbsolute: usesHomedir || isAbsolute(inputPath),
    isValid,
  };
}
