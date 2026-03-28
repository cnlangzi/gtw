import { Commander } from './Commander.js';
import { readJSON } from '../utils/api.js';
import { join } from 'path';
import { homedir } from 'os';

const WIP_FILE = join(homedir(), '.openclaw', 'gtw', 'wip.json');

export class ConfigCommand extends Commander {
  async execute(args) {
    return {
      ok: true,
      workDir: process.cwd(),
      hasToken: !!(readJSON(WIP_FILE.replace('wip.json', 'token.json'))?.access_token),
      wip: readJSON(WIP_FILE) || null,
    };
  }
}
