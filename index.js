import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { writeFileSync } from 'fs';
import { CommanderFactory } from './commands/CommanderFactory.js';
import { extractMessages, injectMessage } from './utils/session.js';

const DEBUG_FILE = '/tmp/gtw-plugin.log';

function dbg(...args) {
  const msg = '[' + new Date().toISOString() + '] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') + '\n';
  try { writeFileSync(DEBUG_FILE, msg); } catch { /* ignore */ }
}

const USAGE = `gtw - GitHub Team Workflow

Usage: /gtw <command> [args]

Commands:
  on <workdir>        Set workdir and repo
  new                 Auto-generate issue draft from chat via AI
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

          // Build factory with API context + session helpers
          const factory = new CommanderFactory({
            api,
            config: api.config,
            sessionKey: ctx.sessionKey,
            extractMessages,
            injectMessage,
          });

          if (!factory.canHandle(cmd)) {
            return { text: `❌ Unknown command: ${cmd}\n\n${USAGE}` };
          }

          const commander = factory.create(cmd);
          const result = await commander.execute(args);

          if (!result.ok) {
            return { text: result.message || 'Failed' };
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
