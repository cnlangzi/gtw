import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Get the parent session JSONL file path for agent:main:main
 */
export function getParentSessionFile() {
  const sessionsPath = join(homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
  if (!existsSync(sessionsPath)) return null;

  try {
    const sessionsData = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    const mainSession = sessionsData['agent:main:main'];
    if (!mainSession?.sessionFile) return null;
    const jsonlPath = mainSession.sessionFile;
    if (!existsSync(jsonlPath)) return null;
    return jsonlPath;
  } catch {
    return null;
  }
}

/**
 * Append a user message to the parent session JSONL.
 * This influences the agent's next response since it reads the JSONL as context.
 */
export function injectMessageToParentSession(text) {
  const sessionFile = getParentSessionFile();
  if (!sessionFile) return false;

  try {
    const message = JSON.stringify({
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: Date.now(),
    });
    appendFileSync(sessionFile, message + '\n');
    return true;
  } catch (e) {
    return false;
  }
}
