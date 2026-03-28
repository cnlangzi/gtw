import { Commander } from './Commander.js';
import { getConfig, saveConfig } from '../utils/config.js';

export class ModelCommand extends Commander {
  async execute(args) {
    const cfg = getConfig();

    if (!args[0]) {
      const model = cfg.model || null;
      const display = model
        ? `Current gtw model: \`${model}\`\n\nTo change: /gtw model <model-id>\nTo unset: /gtw model off`
        : `No custom model set.\n\ngtw will use the session default model.\nTo set a custom model: /gtw model <model-id>`;
      return { ok: true, model, display };
    }

    if (args[0] === 'off') {
      delete cfg.model;
      saveConfig(cfg);
      return { ok: true, model: null, display: 'Custom model cleared. Using session default.' };
    }

    cfg.model = args[0];
    saveConfig(cfg);
    return { ok: true, model: args[0], display: `gtw model set to: \`${args[0]}\`` };
  }
}
