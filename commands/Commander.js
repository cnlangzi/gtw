import { append, exists, read } from '../utils/fs.js';
import { join, basename } from 'path';
import { homedir } from 'os';
import { log as fileLog } from '../utils/log.js';

/**
 * Generate a short hex ID like OpenClaw uses (e.g. "6fb1a898").
 * @returns {string}
 */
function generateShortId() {
  return Math.random().toString(16).slice(2, 10).padStart(8, '0');
}

/**
 * Commander — base interface for all gtw commands.
 * Each subclass implements execute(args) -> { ok, display?, message? }
 */
export class Commander {
  /**
   * @param {{ api?: object, config?: object, sessionKey?: string, sessionFile?: string|null, log?: function, pendingDirectives?: Map<string, string> }} context
   */
  constructor(context) {
    this.api = context.api;
    this.config = context.config;
    this.sessionKey = context.sessionKey;
    this.sessionFile = context.sessionFile ?? null;
    this.log = context.log || console.log.bind(console);
    this.pendingDirectives = context.pendingDirectives;
  }

  /**
   * @param {string[]} args - parsed args for this command
   * @returns {Promise<{ok: boolean, display?: string, message?: string}>}
   */
  async execute(args) {
    throw new Error('Not implemented');
  }

  /**
   * Resolve the canonical session file path from sessionKey via sessions.json.
   * @returns {string|null}
   */
  _resolveSessionFile() {
    const key = this.sessionKey;
    if (!key) return null;
    const agentId = key.split(':')[1] || 'main';
    const sessionsPath = join(homedir(), '.openclaw', 'agents', agentId, 'sessions', 'sessions.json');
    if (!exists(sessionsPath)) return null;
    try {
      const sessionsData = JSON.parse(read(sessionsPath, 'utf8'));
      const entry = sessionsData[key];
      if (entry?.sessionFile && exists(entry.sessionFile)) {
        return entry.sessionFile;
      }
    } catch (err) {
      this.log('[Commander] _resolveSessionFile failed for %s: %s', sessionsPath, err?.message);
    }
    return null;
  }

  /**
   * Detect whether this is a mid-session vs a fresh session.
   * Mid-session: session file exists AND first line is a session-start record.
   * Fresh session: file doesn't exist, or first line is NOT a session-start record.
   * @returns {boolean}
   */
  _isMidSession() {
    const sessionFile = this.sessionFile;
    if (!sessionFile || !exists(sessionFile)) return false;
    try {
      const content = read(sessionFile, 'utf8');
      const firstLine = content.split('\n')[0];
      if (!firstLine) return false;
      const first = JSON.parse(firstLine);
      return first.type === 'session';
    } catch {
      return false;
    }
  }

  /**
   * Get the ID of the last message in the session file, for setting parentId.
   * @returns {string|null}
   */
  _getLastMessageId() {
    if (!this.sessionFile || !exists(this.sessionFile)) return null;
    try {
      const content = read(this.sessionFile, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry?.id) return entry.id;
        } catch { continue; }
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Inject a directive.
   * - Mid-session (session file exists with prior messages): append to session file using proper OpenClaw message format
   * - Fresh session (file doesn't exist or first record is session-start): store in pendingDirectives for before_prompt_build hook injection
   * @param {string} text - directive text to inject
   * @returns {Promise<{ok: boolean}>}
   */
  async enqueueDirective(text) {
    const targetKey = this.sessionKey;

    if (!targetKey) {
      fileLog('[Commander] No sessionKey — cannot inject directive');
      return { ok: false, reason: 'no_session_key' };
    }

    const isMid = this._isMidSession();
    fileLog('[Commander] enqueueDirective targetKey=%s sessionFile=%s isMidSession=%s text.length=%d', targetKey, this.sessionFile, isMid, text.length);

    if (isMid) {
      // Mid-session: write directly to session file using proper OpenClaw message format
      try {
        const id = generateShortId();
        const parentId = this._getLastMessageId() || '00000000';
        const timestamp = new Date().toISOString();
        const entry = {
          type: 'message',
          id,
          parentId,
          timestamp,
          message: {
            role: 'user',
            content: [{ type: 'text', text }],
            timestamp: Date.now(),
          },
        };
        append(this.sessionFile, JSON.stringify(entry) + '\n');
        fileLog('[Commander] wrote directive to session file: %s id=%s parentId=%s', this.sessionFile, id, parentId);
        return { ok: true, id: 'file:' + this.sessionFile };
      } catch (e) {
        fileLog('[Commander] file write FAILED:', e.message);
        return { ok: false, reason: 'exception', error: e.message };
      }
    } else {
      // Fresh session: store for hook injection (before_prompt_build fires before first agent turn)
      if (!this.pendingDirectives) {
        fileLog('[Commander] No pendingDirectives map — cannot inject directive');
        return { ok: false, reason: 'no_pending_directives_map' };
      }
      this.pendingDirectives.set(targetKey, text);
      fileLog('[Commander] directive stored in pendingDirectives (fresh session), key=%s', targetKey);
      return { ok: true, id: 'hook:' + targetKey };
    }
  }
}