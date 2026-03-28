import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const WIP_FILE = join(homedir(), '.openclaw', 'gtw', 'wip.json');

export function getWip() {
  try {
    return existsSync(WIP_FILE) ? JSON.parse(readFileSync(WIP_FILE, 'utf8')) : {};
  } catch {
    return {};
  }
}

export function saveWip(data) {
  writeFileSync(WIP_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function clearWip() {
  if (existsSync(WIP_FILE)) {
    const wip = getWip();
    const { workdir, repo, createdAt } = wip;
    writeFileSync(WIP_FILE, JSON.stringify({ workdir, repo, createdAt }, null, 2), 'utf8');
  }
}
