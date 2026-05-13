import { append, read, exists } from '../utils/fs.js';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Commander — base interface for all gtw commands.
 * Each subclass implements execute(args) -> { ok, display?, message? }
 */
export class Commander {
  /**
   * @param {{ api?: object, config?: object, sessionKey?: string, sessionFile?: string|null, log?: function }} context
   */
  constructor(context) {
    this.api = context.api;
    this.config = context.config;
    this.sessionKey = context.sessionKey;
    this.sessionFile = context.sessionFile ?? null;
    this.log = context.log || console.log.bind(console);
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
   * This is the authoritative path — ctx.sessionFile may be wrong for feishu DMs.
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
    } catch {}
    return null;
  }

  /**
   * Enqueue a directive to be processed at the start of the next agent turn.
   * Uses enqueueNextTurnInjection API first, falls back to direct session file injection.
   * @param {string} text - directive text to inject
   * @returns {Promise<boolean>} true if enqueued successfully
   */
  async enqueueDirective(text) {
    // Always inject directly into session file as user message.
    // enqueueNextTurnInjection with prepend_context/append_context stores in
    // pluginNextTurnInjections which may not be accessible to feishu channel.
    const sessionFile = this._resolveSessionFile() || this.sessionFile;
    if (!sessionFile) {
      console.warn('[Commander] No sessionFile — cannot inject directive');
      return false;
    }
    this.log('[Commander] enqueueDirective sessionFile=%s text.length=%d', sessionFile, text.length);
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
      append(sessionFile, entry + '\n');
      this.log('[Commander] sessionFile injection succeeded');
      return true;
    } catch (e) {
      console.warn('[Commander] sessionFile injection failed: %s', e.message);
      return false;
    }
  }
}