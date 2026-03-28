import { definePluginEntry } from '/home/devin/.npm-global/lib/node_modules/openclaw/dist/plugin-sdk/plugin-entry.js';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join, homedir } from 'path';
import { CommanderFactory } from './commands/CommanderFactory.js';

const DEBUG_FILE = '/tmp/gtw-plugin.log';

function dbg(...args) {
  const msg = '[' + new Date().toISOString() + '] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') + '\n';
  try { writeFileSync(DEBUG_FILE, msg); } catch { /* ignore */ }
}

/**
 * Read the parent session JSONL and extract human+assistant messages after the last
 * /gtw confirm (or from start if not found).
 */
function extractHumanMessagesFromParentSession() {
  try {
    const sessionsPath = join(homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
    if (!existsSync(sessionsPath)) return { humanMessages: [], allMessages: [], cutoffIndex: 0 };

    const sessionsData = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    const mainSession = sessionsData['agent:main:main'];
    if (!mainSession?.sessionFile) return { humanMessages: [], allMessages: [], cutoffIndex: 0 };

    const jsonlPath = mainSession.sessionFile;
    if (!existsSync(jsonlPath)) return { humanMessages: [], allMessages: [], cutoffIndex: 0 };

    const content = readFileSync(jsonlPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);

    // 从后往前找 /gtw confirm
    let cutoffIndex = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const text = Array.isArray(entry.content)
          ? entry.content.map((c) => (c.type === 'text' ? c.text : '')).filter(Boolean).join(' ')
          : String(entry.content || '');
        if (entry.role === 'user' && /\/gtw\s+confirm\b/i.test(text)) {
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
        const text = Array.isArray(entry.content)
          ? entry.content.map((c) => (c.type === 'text' ? c.text : '')).filter(Boolean).join('\n')
          : String(entry.content || '');
        if (!text.trim()) continue;
        if (entry.role === 'user' || entry.role === 'assistant') {
          allMessages.push({ role: entry.role, text: text.trim() });
        }
        if (entry.role === 'user') humanMessages.push(text.trim());
      } catch {}
    }

    return { humanMessages, allMessages, cutoffIndex };
  } catch (e) {
    dbg('[gtw] extractHumanMessages error:', e.message);
    return { humanMessages: [], allMessages: [], cutoffIndex: 0 };
  }
}

const USAGE = `gtw - GitHub Team Workflow

Usage: /gtw <command> [args]

Commands:
  on <workdir>        Set workdir and repo
  new [title] [body] Create issue draft (LLM auto-generates if no args)
  update #<id>        Update existing issue
  confirm            Execute pending actions (create issue/PR, push branch)
  fix [name]         Create fix branch
  pr                 Push branch to origin
  push               Commit and push current branch
  review [pr_url] [#n] [approved|changes]  Review/claim PR
  issue [repo]       List open issues
  show #<id> [repo]  Show issue details
  poll [issue|pr]    Poll open issues/PRs
  model [model-id]  Set LLM model for draft generation
  auth               Show auth status (uses gh CLI)
  config             Show current config

Workflow: /gtw on -> /gtw new -> /gtw confirm`;

const gtw = definePluginEntry({
  id: 'gtw',
  name: 'GitHub Team Workflow',
  description: 'GitHub team workflow. Workflow: /gtw on <workdir> -> /gtw new -> /gtw confirm',
  acceptsArgs: true,
  register(api) {
    api.registerCommand({
      name: 'gtw',
      description: 'GitHub team workflow. Workflow: /gtw on <workdir> -> /gtw new -> /gtw confirm',
      acceptsArgs: true,
      handler: async (ctx) => {
        try {
          dbg('[gtw] handler entered, args=', ctx.args);

          const rawArgs = (ctx.args || '').trim();
          if (!rawArgs) {
            return { text: USAGE };
          }

          const parts = rawArgs.split(/\s+/).filter(Boolean);
          const cmd = parts[0].toLowerCase();
          const args = parts.slice(1);

          dbg('[gtw] cmd=', cmd, 'args=', args);

          // Build factory with API context
          const factory = new CommanderFactory({
            api,
            config: api.config,
            extractHumanMessages: extractHumanMessagesFromParentSession,
          });

          if (!factory.canHandle(cmd)) {
            return { text: `❌ Unknown command: ${cmd}\n\n${USAGE}` };
          }

          const commander = factory.create(cmd);
          const result = await commander.execute(args);

          if (!result.ok) {
            return { text: `❌ ${result.error || result.message}` };
          }

          return { text: result.display || result.message || 'OK' };
        } catch (err) {
          dbg('[gtw] handler exception:', err.message, err.stack);
          return { text: `❌ ${err.message}` };
        }
      },
    });
  },
});

export default gtw;
