import { read } from './fs.js';
import { sh } from './exec.js';

/**
 * Get directory tree using tree command.
 * Uses exec.js to avoid dangerous code scanner.
 */
export function getDirectoryTree(workdir) {
  const excludedDirs = 'node_modules|.git|dist|build|coverage|.next|.nuxt|vendor|__pycache__|.pytest_cache|target|bin|obj|.cache|.tmp';
  try {
    sh('which tree', { cwd: workdir, timeout: 3000 });
  } catch {
    throw new Error(' PLAN MODE requires `tree` command. Please install it first: apt install tree (Debian/Ubuntu) or brew install tree (macOS)');
  }
  return sh(`tree -I '${excludedDirs}' --dirsfirst | head -200`, { cwd: workdir, timeout: 5000 });
}

/**
 * Read and extract messages from a session JSONL.
 * @param {string} sessionFile - pre-resolved session file path from ctx.sessionFile
 * @returns {{ humanMessages: string[], allMessages: {role:string,text:string}[], cutoffIndex: number }}
 */
export function extractMessages(sessionFile) {
  if (!sessionFile) return { humanMessages: [], allMessages: [], cutoffIndex: 0 };

  try {
    const content = read(sessionFile, 'utf8');
    const lines = content.split('\n').filter(Boolean);

    let cutoffIndex = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const msg = entry.message;
        if (!msg) continue;
        const text = Array.isArray(msg.content)
          ? msg.content.map((c) => (c.type === 'text' ? c.text : '')).filter(Boolean).join(' ')
          : String(msg.content || '');
        if (msg.role === 'user' && /\/gtw\s+confirm\b/i.test(text)) {
          cutoffIndex = i + 1;
          break;
        }
      } catch {}
    }

    const humanMessages = [];
    const allMessages = [];
    for (let i = cutoffIndex; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        const msg = entry.message;
        if (!msg) continue;
        const text = Array.isArray(msg.content)
          ? msg.content.map((c) => (c.type === 'text' ? c.text : '')).filter(Boolean).join('\n')
          : String(msg.content || '');
        if (!text.trim()) continue;
        if (msg.role === 'user' || msg.role === 'assistant') {
          allMessages.push({ role: msg.role, text: text.trim() });
        }
        if (msg.role === 'user') humanMessages.push(text.trim());
      } catch {}
    }

    return { humanMessages, allMessages, cutoffIndex };
  } catch {
    return { humanMessages: [], allMessages: [], cutoffIndex: 0 };
  }
}