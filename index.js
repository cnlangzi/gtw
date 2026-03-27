import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GTW_SCRIPT = join(__dirname, 'scripts', 'index.cjs');

const USAGE = `gtw - GitHub Team Workflow

Usage: /gtw <command> [args]

Commands:
  on <workdir>        Set workdir and repo
  new <title> <body>  Create issue draft (title + body, no prefix needed)
  update #<id>        Update existing issue
  confirm            Execute pending actions (create issue/PR, push branch)
  fix [name]         Create fix branch
  pr                 Push branch to origin
  push               Commit and push current branch
  review [pr_url] [#n] [approved|changes]  Review/claim PR
  issue [repo]       List open issues
  show #<id> [repo]  Show issue details
  poll [issue|pr]    Poll open issues/PRs
  auth               Authenticate via GitHub device flow
  config             Show current config

Workflow: /gtw on -> /gtw new -> /gtw confirm`;

function execGtw(rawArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [GTW_SCRIPT, rawArgs], {
      cwd: __dirname,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => {
      if (code === 0) {
        try { resolve(JSON.parse(stdout)); }
        catch { resolve({ ok: true, output: stdout }); }
      } else {
        try { const e = JSON.parse(stderr); reject(new Error(e.error || stderr.trim())); }
        catch { reject(new Error(stderr.trim() || `exit code ${code}`)); }
      }
    });
    child.on('error', reject);
  });
}

function formatResult(result) {
  // Handle auth_required (device flow in progress)
  if (result.action === 'auth_required') {
    return { text: `🔐 Device auth required\n\n1. Open: https://github.com/login/device\n2. Enter code: \`${result.user_code}\`\n\nWaiting for authorization... (expires in ${Math.floor(result.expires_in / 60)} minutes)\n\nThe auth will complete automatically once you authorize on GitHub.` };
  }
  if (result.action === 'auth_success') {
    return { text: `✅ ${result.message}` };
  }
  if (result.display) {
    return { text: result.display };
  }
  return { text: JSON.stringify(result, null, 2) };
}

export default {
  id: 'gtw',
  register(api) {
    api.registerCommand({
      name: 'gtw',
      description: 'GitHub team workflow. Workflow: /gtw on <workdir> -> /gtw new -> /gtw confirm',
      acceptsArgs: true,
      handler: async (ctx) => {
        const rawArgs = (ctx.args || '').trim();
        const parts = rawArgs.split(/\s+/).filter(Boolean);
        const cmd = parts[0] || '';
        const args = parts.slice(1);

        // /gtw new with no args: prompt for title + body
        if (cmd === 'new' && args.length === 0) {
          return { text: '📝 Creating new issue draft.\n\nPlease provide:\n- **Title**: brief description\n- **Body** (optional): details, acceptance criteria, etc.\n\nExample: /gtw new Fix login bug on Safari Add more details here...' };
        }

        if (!rawArgs) {
          return { text: USAGE };
        }

        try {
          const result = await execGtw(rawArgs);
          return formatResult(result);
        } catch (err) {
          return { text: `❌ ${err.message}` };
        }
      }
    });
  }
};
