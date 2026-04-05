import { Commander } from './Commander.js';
import { getConfig, saveConfig } from '../utils/config.js';
import { getSessionEntry } from '../utils/session.js';

export class ModelCommand extends Commander {
  constructor(context) {
    super(context);
    this.sessionKey = context.sessionKey;
  }

  async execute(args) {
    const cfg = getConfig();

    // Resolve session default as "provider/model"
    const sessionDefault = this._resolveSessionDefault();

    if (!args[0]) {
      const model = cfg.model || null;
      const label = model || sessionDefault;
      const display = model
        ? `Current gtw model: \`${model}\`\n\nTo change: /gtw model <provider/model-id>\nTo unset: /gtw model off`
        : `No custom model set.\n\ngtw will use the session default: \`${sessionDefault}\`\nTo set a custom model: /gtw model <provider/model-id>`;
      return { ok: true, model, sessionDefault, display };
    }

    if (args[0] === 'off') {
      delete cfg.model;
      saveConfig(cfg);
      return { ok: true, model: null, display: `Custom model cleared. Using session default: \`${sessionDefault}\`.` };
    }

    cfg.model = args[0];
    saveConfig(cfg);
    return { ok: true, model: args[0], display: `gtw model set to: \`${args[0]}\`` };
  }

  _resolveSessionDefault() {
    const cfg = getConfig();
    const dmScope = cfg.session?.dmScope || 'main';
    const entry = getSessionEntry(this.sessionKey, dmScope, cfg);
    return `${entry.modelProvider}/${entry.model}`;
  }
}
