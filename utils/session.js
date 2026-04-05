import { readFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Resolve the real session key for the main agent session from a channel-specific key.
 *
 * session.dmScope controls how DMs are grouped:
 * - main: all DMs share agent:{agentId}:{mainKey} (default: agent:{agentId}:main)
 * - per-peer: all channels share agent:{agentId}:{peerId}
 * - per-channel-peer: each channel has agent:{agentId}:{channel}:{peerId}
 * - per-account-channel-peer: agent:{agentId}:{accountId}:{channel}:{peerId}
 *
 * Strategy: look up sessions.json and find the entry that corresponds to the main
 * session for the current peer. Falls back to ctx.sessionKey itself.
 *
 * @param {string} sessionKey - e.g. "agent:main:feishu:direct:ou_xxx"
 * @param {string} dmScope - from openclaw.json session.dmScope
 * @param {object} cfg - full openclaw.json config (optional, for identityLinks/mainKey)
 * @returns {string|null}
 */
export function resolveRealSessionKey(sessionKey, dmScope, cfg = {}) {
  if (!sessionKey) return null;
  const parts = sessionKey.split(':');
  if (parts.length < 2) return null;
  const agentId = parts[1];

  const sessionsPath = join(homedir(), '.openclaw', 'agents', agentId, 'sessions', 'sessions.json');
  if (!existsSync(sessionsPath)) return sessionKey;

  let sessionsData;
  try {
    sessionsData = JSON.parse(readFileSync(sessionsPath, 'utf8'));
  } catch {
    return sessionKey;
  }

  // identityLinks: map provider-specific peerId to canonical identity
  let peerId = parts[parts.length - 1];
  const identityLinks = cfg.session?.identityLinks;
  if (identityLinks && identityLinks[peerId]) {
    peerId = identityLinks[peerId];
  }

  const mainKey = cfg.session?.mainKey || 'main';

  let candidates = [];

  if (dmScope === 'main') {
    // All DMs share one main session
    candidates.push(`${agentId}:${mainKey}`);
  } else if (dmScope === 'per-peer') {
    // Same peer across channels share one session
    candidates.push(`${agentId}:${peerId}`);
  } else if (dmScope === 'per-channel-peer') {
    // Channel + peer combination
    const channel = parts[2] || 'feishu';
    candidates.push(`${agentId}:${channel}:${peerId}`);
  } else if (dmScope === 'per-account-channel-peer') {
    // Account + channel + peer
    const accountId = parts[2] || 'default';
    const channel = parts[3] || 'feishu';
    candidates.push(`${agentId}:${accountId}:${channel}:${peerId}`);
  }

  // Find first candidate that exists in sessions.json
  for (const candidate of candidates) {
    const fullKey = `agent:${candidate}`;
    if (sessionsData[fullKey]?.sessionFile) {
      return fullKey;
    }
  }

  // Fallback: construct the expected canonical session key from current context
  // (used when dmScope != main and the peer hasn't been seen yet)
  if (dmScope === 'per-peer') {
    return `agent:${agentId}:${peerId}`;
  } else if (dmScope === 'per-channel-peer') {
    const channel = parts[2] || 'feishu';
    return `agent:${agentId}:${channel}:${peerId}`;
  } else if (dmScope === 'per-account-channel-peer') {
    const accountId = parts[2] || 'default';
    const channel = parts[3] || 'feishu';
    return `agent:${agentId}:${accountId}:${channel}:${peerId}`;
  }

  // Final fallback: the current session itself
  return sessionKey;
}

/**
 * Get the session JSONL file path for a given session key.
 * @param {string} sessionKey - e.g. "agent:main:feishu:direct:ou_xxx"
 * @returns {string|null}
 */
export function getSessionFile(sessionKey) {
  const agentId = sessionKey?.split(':')[1]; // "main" from "agent:main:feishu:direct:ou_xxx"
  if (!agentId) return null;
  const sessionsPath = join(homedir(), '.openclaw', 'agents', agentId, 'sessions', 'sessions.json');
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
        const msg = entry.message;
        if (!msg) continue; // skip non-message entries (e.g. session metadata)
        const text = Array.isArray(msg.content)
          ? msg.content.map((c) => (c.type === 'text' ? c.text : '')).filter(Boolean).join(' ')
          : String(msg.content || '');
        if (msg.role === 'user' && /\/gtw\s+confirm\b/i.test(text)) {
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
        const msg = entry.message;
        if (!msg) continue;
        const text = Array.isArray(msg.content)
          ? msg.content.map((c) => (c.type === 'text' ? c.text : '')).filter(Boolean).join('\n')
          : String(msg.content || '');
        if (!text.trim()) continue;
        if (msg.role === 'user' || msg.role === 'assistant') {
          allMessages.push({ role: msg.role, text: text.trim() });
        }
        if (msg.role === 'user') humanMessages.push(text.trim());
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
    const entry = JSON.stringify({
      type: 'message',
      id: `inj-${Date.now()}`,
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    });
    appendFileSync(sessionFile, entry + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Inject a PLAN MODE directive into the session JSONL for requirements clarification.
 * @param {string} sessionKey
 * @param {string} workdir
 * @param {string} repo
 * @returns {boolean} success
 */
export function injectPlanModeDirective(sessionKey, workdir, repo) {
  const sessionFile = getSessionFile(sessionKey);
  if (!sessionFile) return false;

  const directive = [
    `🚨 [gtw] PLAN MODE — Requirements Clarification`,
    ``,
    `Workdir: ${workdir}`,
    `Repo: ${repo}`,
    ``,
    `You are now in PLAN MODE for requirements clarification.`,
    ``,
    `RULES:`,
    `1. Do NOT read code files proactively. Wait for the user to ask questions.`,
    `2. When the user asks a question, read only the relevant files they mention or ask about.`,
    `3. After reading, respond with a structured reply:`,
    `   ## 当前理解`,
    `   [Describe what you understood from the code for the asked scope]`,
    `   ## 疑问`,
    `   [List any clarifying questions]`,
    `4. Do NOT write, modify, or refactor any code.`,
    `5. Do NOT propose fixes or implementation suggestions.`,
    `6. Wait for the user to explicitly say "可以开始了" (or "you can start") before beginning implementation.`,
  ].join('\n');

  try {
    const entry = JSON.stringify({
      type: 'message',
      id: `inj-${Date.now()}`,
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text: directive }],
      },
    });
    appendFileSync(sessionFile, entry + '\n');
    return true;
  } catch {
    return false;
  }
}
