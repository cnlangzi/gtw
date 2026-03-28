/**
 * Commander — base interface for all gtw commands.
 * Each subclass implements execute(args) -> { ok, display?, message? }
 */
export class Commander {
  constructor({ log }) {
    this.log = log || (() => {});
  }

  /**
   * @param {string[]} args - parsed args for this command
   * @returns {Promise<{ok: boolean, display?: string, message?: string}>}
   */
  async execute(args) {
    throw new Error('Not implemented');
  }

  log(...args) {
    this.log('[Commander]', ...args);
  }
}
