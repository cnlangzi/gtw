import { read, write, exists, makeDir } from './fs.js';
import { BASE_DIR, WIP_FILE } from './config.js';

export function getWip() {
  try {
    return exists(WIP_FILE) ? JSON.parse(read(WIP_FILE, 'utf8')) : {};
  } catch {
    return {};
  }
}

export function saveWip(data) {
  makeDir(BASE_DIR, { recursive: true });
  write(WIP_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function clearWip() {
  if (exists(WIP_FILE)) {
    const wip = getWip();
    const { workdir, repo, createdAt } = wip;
    write(WIP_FILE, JSON.stringify({ workdir, repo, createdAt }, null, 2), 'utf8');
  }
}
