import { Commander } from './Commander.js';
import { join } from 'path';
import { homedir } from 'os';
import { readFileSync, existsSync } from 'fs';
import { getConfig, saveConfig } from '../utils/config.js';
import { resolveRealSessionKey } from '../utils/session.js';

export class ModelCommand extends Commander {
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
    try {
      const sessionsPath = join(homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
      if (!existsSync(sessionsPath)) return 'minimax-portal/MiniMax-M2.7';
      const sessionsData = JSON.parse(readFileSync(sessionsPath, 'utf8'));
      const cfg = JSON.parse(readFileSync(join(homedir(), '.openclaw', 'openclaw.json'), 'utf8'));
      const dmScope = cfg.session?.dmScope || 'main';
      const realKey = resolveRealSessionKey(this.sessionKey, dmScope, cfg);
      const mainSession = sessionsData[realKey];
      if (!mainSession) return 'minimax-portal/MiniMax-M2.7';
      const provider = mainSession.modelProvider || 'minimax-portal';
      const model = mainSession.model || 'MiniMax-M2.7';
      return `${provider}/${model}`;
    } catch {
      return 'minimax-portal/MiniMax-M2.7';
    }
  }
}
