import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Unified log file in ~/.gtw/
const LOG_FILE = join(homedir(), '.gtw', 'gtw.log');

// Ensure .gtw directory exists
mkdirSync(join(homedir(), '.gtw'), { recursive: true });

/**
 * Write a log message to ~/.gtw/gtw.log
 * @param {...any} args - Values to log
 */
export function log(...args) {
  const msg = '[' + new Date().toISOString() + '] ' + args.map((a) => 
    typeof a === 'object' ? JSON.stringify(a) : String(a)
  ).join(' ') + '\n';
  
  try { 
    appendFileSync(LOG_FILE, msg); 
  } catch { /* ignore */ }
}

export { LOG_FILE };
