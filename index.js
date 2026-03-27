import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GTW_SCRIPT = join(__dirname, 'scripts', 'index.cjs');

const USAGE = `gtw - GitHub Team Workflow

Usage: /gtw <command> [args]

Commands:
  on <workdir>        Start a new session in <workdir>
  new <type> <title> Draft a new item (issue/pr)
  update             Update draft from git diff
  confirm            Confirm and execute pending actions
  fix <pr_url>       Create fix branch for PR
  pr <url>           Create PR from draft
  push               Push draft changes
  review <pr_url>    Review a PR
  issue <repo> <#>   Show issue details
  show [key]         Show draft/branch/session info
  poll               Poll pending PR status
  config             Configure GitHub token

Examples:
  /gtw on ~/code/bailing
  /gtw new issue Fix login bug
  /gtw confirm`;

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

export default {
  id: 'gtw',
  register(api) {
    api.registerCommand({
      name: 'gtw',
      description: 'GitHub team workflow. Commands: on, new, update, confirm, fix, pr, push, review, issue, show, poll, config',
      acceptsArgs: true,
      handler: async (ctx) => {
        const rawArgs = (ctx.args || '').trim();
        if (!rawArgs) {
          return { text: USAGE };
        }
        try {
          const result = await execGtw(rawArgs);
          if (result.display) {
            return { text: result.display };
          }
          return { text: JSON.stringify(result, null, 2) };
        } catch (err) {
          return { text: `❌ ${err.message}` };
        }
      }
    });
  }
};
