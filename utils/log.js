import { writeFileSync, mkdirSync, appendFileSync } from 'fs';
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
 * @param {'new' | 'pr' | 'push'} type - Command type
 * @param {object} data - Data to log
 */
export function logParseFailure(type, data) {
  const failFile = join(LOG_DIR, `${type}-fail-${Date.now()}.json`);
  const logData = {
    timestamp: new Date().toISOString(),
    ...data,
  };
  
  try {
    writeFileSync(failFile, JSON.stringify(logData, null, 2));
    // Also log to main log file
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [parse-fail] ${type} failed, logged to ${failFile}\n`);
  } catch { /* ignore */ }
  
  console.error(`[gtw] JSON parse failed, logged to ${failFile}`);
}

export { LOG_FILE, LOG_DIR };
