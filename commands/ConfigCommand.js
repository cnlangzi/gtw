import { Commander } from './Commander.js';
import { listConfig, getConfigKey, setConfigKey, deleteConfigKey } from '../utils/config.js';

export class ConfigCommand extends Commander {
  /**
   * /gtw config list
   * /gtw config get <key>
   * /gtw config set <key> <value>
   * /gtw config delete <key>
   */
  async execute(args) {
    const sub = (args[0] || '').toLowerCase();
    const rest = args.slice(1);

    if (sub === 'list') {
      return this._list();
    } else if (sub === 'get') {
      return this._get(rest);
    } else if (sub === 'set') {
      return this._set(rest);
    } else if (sub === 'delete') {
      return this._delete(rest);
    } else {
      return {
        ok: true,
        message: 'Usage:\n  /gtw config list              List all config keys\n  /gtw config get <key>         Get a config value\n  /gtw config set <key> <value> Set a config value\n  /gtw config delete <key>      Delete a config key',
        display: `Usage:\n  /gtw config list              List all config keys\n  /gtw config get <key>         Get a config value\n  /gtw config set <key> <value> Set a config value\n  /gtw config delete <key>      Delete a config key`,
      };
    }
  }

  async _list() {
    const entries = listConfig();
    if (entries.length === 0) {
      return {
        ok: true,
        entries: [],
        message: 'No config keys set.',
        display: 'No config keys set.',
      };
    }
    const lines = entries.map(({ key, value }) => `  ${key}=${value}`).join('\n');
    return {
      ok: true,
      entries,
      message: `Config:\n${lines}`,
      display: `Config:\n\n${lines}`,
    };
  }

  async _get(args) {
    const key = args.join(' ');
    if (!key) {
      return {
        ok: false,
        message: 'Usage: /gtw config get <key>',
      };
    }
    const value = getConfigKey(key);
    if (value === null) {
      return {
        ok: true,
        key,
        value: null,
        message: `Key not set: ${key}`,
        display: `${key} is not set.`,
      };
    }
    return {
      ok: true,
      key,
      value,
      message: `${key}=${value}`,
      display: `${key}=${value}`,
    };
  }

  async _set(args) {
    if (args.length < 2) {
      return {
        ok: false,
        message: 'Usage: /gtw config set <key> <value>',
      };
    }
    const key = args[0];
    const value = args.slice(1).join(' ');
    setConfigKey(key, value);
    return {
      ok: true,
      key,
      value,
      message: `${key}=${value}`,
      display: `Set: ${key}=${value}`,
    };
  }

  async _delete(args) {
    const key = args.join(' ');
    if (!key) {
      return {
        ok: false,
        message: 'Usage: /gtw config delete <key>',
      };
    }
    const existed = deleteConfigKey(key);
    if (!existed) {
      return {
        ok: true,
        key,
        deleted: false,
        message: `Key not found: ${key}`,
        display: `${key} was not set.`,
      };
    }
    return {
      ok: true,
      key,
      deleted: true,
      message: `Deleted: ${key}`,
      display: `Deleted: ${key}`,
    };
  }
}
