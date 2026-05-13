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
   * Enqueue a directive to be processed at the start of the next agent turn.
   * Uses OpenClaw's enqueueNextTurnInjection API when available.
   * @param {string} text - directive text to inject
   * @returns {Promise<boolean>} true if enqueued successfully
   */
  async enqueueDirective(text) {
    if (typeof this.api?.enqueueNextTurnInjection !== 'function') {
      console.warn('[Commander] enqueueNextTurnInjection not available');
      return false;
    }
    this.log('[Commander] enqueueDirective sessionKey=%s, text.length=%d', this.sessionKey, text.length);
    try {
      const result = await this.api.enqueueNextTurnInjection({
        sessionKey: this.sessionKey,
        text,
        placement: 'prepend_context',
      });
      this.log('[Commander] enqueueNextTurnInjection result: %o', result);
      return result?.enqueued === true;
    } catch (e) {
      console.warn('[Commander] enqueueNextTurnInjection failed:', e.message);
      return false;
    }
  }
}