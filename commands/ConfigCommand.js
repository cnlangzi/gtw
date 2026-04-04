import { Commander } from './Commander.js';
import { readJSON } from '../utils/api.js';
import { join } from 'path';
import { homedir } from 'os';

const BASE_DIR = process.env.GTW_CONFIG_DIR || join(homedir(), '.openclaw', 'gtw');
const WIP_FILE = join(BASE_DIR, 'wip.json');
const TOKEN_FILE = join(BASE_DIR, 'token.json');

export class ConfigCommand extends Commander {
  async execute(args) {
    return {
      ok: true,
      workDir: process.cwd(),
      hasToken: !!(readJSON(TOKEN_FILE)?.access_token),
      wip: readJSON(WIP_FILE) || null,
    };
  }
}
