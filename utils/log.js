import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Unified log file in ~/.gtw/logs/
const LOG_DIR = join(homedir(), '.gtw', 'logs');
const LOG_FILE = join(LOG_DIR, 'gtw.log');

// Ensure log directory exists
mkdirSync(LOG_DIR, { recursive: true });

/**
 * Write a log message to the unified log file.
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

/**
 * Log raw AI response when JSON parsing fails.
 * Writes to main log file.
 * @param {'new' | 'pr' | 'push'} type - Command type
 * @param {object} data - Data to log
 */
export function logParseFailure(type, data) {
  const entry = {
    timestamp: new Date().toISOString(),
    type: 'parse-fail',
    command: type,
    ...data,
  };
  
  log('[parse-fail]', JSON.stringify(entry));
}

export { LOG_FILE, LOG_DIR };
