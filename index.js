import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { CommanderFactory } from './commands/CommanderFactory.js';
import { log } from './utils/log.js';

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
  review <pr>            Claim and review PR (no-arg: picks earliest gtw/ready from watch list)
  watch add <owner>/<repo>  Add repo to watch list
  watch rm <owner>/<repo>   Remove repo from watch list
  watch list          Show watched repos
  issue [repo]       List open issues
  show #<id> [repo]  Show issue details
  poll [issue|pr]    Poll open issues/PRs
  model [model-id]  Set LLM model for draft generation
  login              OAuth login or PAT login (--pat)

Workflow: /gtw on -> /gtw new -> /gtw confirm

Auth:
  - /gtw login           # OAuth device flow (non-blocking)
  - /gtw login --pat xxx # Personal Access Token
  - GITHUB_TOKEN env var # CI environments`;

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
          log('[gtw] handler entered, args=', ctx.args);

          const rawArgs = (ctx.args || '').trim();
          if (!rawArgs) {
            return { text: USAGE };
          }

          const parts = rawArgs.split(/\s+/).filter(Boolean);
          const cmd = parts[0].toLowerCase();
          const args = parts.slice(1);

          log('[gtw] cmd=%s args=%s hasSessionKey=%s hasSessionFile=%s', cmd, args, !!ctx.sessionKey, !!ctx.sessionFile);

          const factory = new CommanderFactory({
            api,
            config: api.config,
            sessionKey: ctx.sessionKey,
            sessionFile: ctx.sessionFile,
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
          log('[gtw] handler exception:', err.message, err.stack);
          return { text: `❌ ${err.message}` };
        }
      },
    });
  },
});

export default gtw;