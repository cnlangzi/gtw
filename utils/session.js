import { readFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Get the session JSONL file path for a given session key.
 * @param {string} sessionKey - e.g. "agent:main:feishu:direct:ou_xxx"
 * @returns {string|null}
 */
export function getSessionFile(sessionKey) {
  const sessionsPath = join(homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
  if (!existsSync(sessionsPath)) return null;

  try {
    const sessionsData = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    const entry = sessionsData[sessionKey];
    if (!entry?.sessionFile) return null;
    if (!existsSync(entry.sessionFile)) return null;
    return entry.sessionFile;
  } catch {
    return null;
  }
}

/**
 * Read and extract messages from a session JSONL.
 * @param {string} sessionKey
 * @returns {{ humanMessages: string[], allMessages: {role:string,text:string}[], cutoffIndex: number }}
 */
export function extractMessages(sessionKey) {
  const jsonlPath = getSessionFile(sessionKey);
  if (!jsonlPath) return { humanMessages: [], allMessages: [], cutoffIndex: 0 };

  try {
    const content = readFileSync(jsonlPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);

    // 从后往前找 /gtw confirm
    let cutoffIndex = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const text = Array.isArray(entry.content)
          ? entry.content.map((c) => (c.type === 'text' ? c.text : '')).filter(Boolean).join(' ')
          : String(entry.content || '');
        if (entry.role === 'user' && /\/gtw\s+confirm\b/i.test(text)) {
          cutoffIndex = i + 1;
          break;
        }
      } catch {}
    }

    const humanMessages = [];
    const allMessages = [];
    for (let i = cutoffIndex; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        const text = Array.isArray(entry.content)
          ? entry.content.map((c) => (c.type === 'text' ? c.text : '')).filter(Boolean).join('\n')
          : String(entry.content || '');
        if (!text.trim()) continue;
        if (entry.role === 'user' || entry.role === 'assistant') {
          allMessages.push({ role: entry.role, text: text.trim() });
        }
        if (entry.role === 'user') humanMessages.push(text.trim());
      } catch {}
    }

    return { humanMessages, allMessages, cutoffIndex };
  } catch {
    return { humanMessages: [], allMessages: [], cutoffIndex: 0 };
  }
}

/**
 * Append a user message to a session JSONL.
 * @param {string} sessionKey
 * @param {string} text
 * @returns {boolean} success
 */
export function injectMessage(sessionKey, text) {
  const sessionFile = getSessionFile(sessionKey);
  if (!sessionFile) return false;

  try {
    const message = JSON.stringify({
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: Date.now(),
    });
    appendFileSync(sessionFile, message + '\n');
    return true;
  } catch {
    return false;
  }
}
