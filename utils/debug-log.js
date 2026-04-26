import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Log raw AI response when JSON parsing fails.
 * @param {'new' | 'pr' | 'push'} type - Command type
 * @param {object} data - Data to log
 */
export function logParseFailure(type, data) {
  const logDir = join(homedir(), '.gtw', 'logs');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${type}-fail-${Date.now()}.json`);
  const logData = {
    timestamp: new Date().toISOString(),
    ...data,
  };
  writeFileSync(logFile, JSON.stringify(logData, null, 2));
  console.error(`[gtw] JSON parse failed, logged to ${logFile}`);
}
