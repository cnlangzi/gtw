import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { BASE_DIR, WIP_FILE } from './config.js';

export function getWip() {
  try {
    return existsSync(WIP_FILE) ? JSON.parse(readFileSync(WIP_FILE, 'utf8')) : {};
  } catch {
    return {};
  }
}

export function saveWip(data) {
  mkdirSync(BASE_DIR, { recursive: true });
  writeFileSync(WIP_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function clearWip() {
  if (existsSync(WIP_FILE)) {
    const wip = getWip();
    const { workdir, repo, createdAt } = wip;
    writeFileSync(WIP_FILE, JSON.stringify({ workdir, repo, createdAt }, null, 2), 'utf8');
  }
}
