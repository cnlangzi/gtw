#!/usr/bin/env node
/**
 * gtw skill - GitHub Team Workflow
 * Commands: on, new, update, confirm, fix, pr, push, review, issue, show, poll, config
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.openclaw', 'gtw');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token.json');
const wip_FILE = path.join(CONFIG_DIR, 'wip.json');

[CONFIG_DIR].forEach(d => { if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); fs.chmodSync(d, '0700'); } });

const CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const ACCESS_TOKEN = process.env.GITHUB_ACCESS_TOKEN || '';

function apiRequest(method, endpoint, token, body = null) {
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com${endpoint}`;
    const urlObj = new URL(url);
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: urlObj.hostname, port: 443, path: urlObj.pathname + urlObj.search, method,
      headers: { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'github-work-skill/1.0' },
    };
    if (bodyStr) { options.headers['Content-Type'] = 'application/json'; options.headers['Content-Length'] = Buffer.byteLength(bodyStr); }
    const req = https.request(options, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(`GitHub API ${res.statusCode}: ${JSON.stringify(parsed)}`));
        } catch (e) { reject(new Error(`Parse error (${res.statusCode}): ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readJSON(file) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch (e) { return null; } }
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); fs.chmodSync(file, '0600'); }

function getToken() {
  if (ACCESS_TOKEN) return ACCESS_TOKEN;
  const t = readJSON(TOKEN_FILE);
  if (!t?.access_token) throw new Error('Not authenticated. Run /gtw auth or set GITHUB_ACCESS_TOKEN');
  return t.access_token;
}
function saveToken(t) { writeJSON(TOKEN_FILE, t); }

async function deviceFlow() {
  if (!CLIENT_ID) throw new Error('GITHUB_CLIENT_ID not configured');
  const codeResp = await postForm('https://github.com/login/device/code', { client_id: CLIENT_ID, scope: 'repo workflow' });
  if (!codeResp.device_code) throw new Error(`Device flow failed: ${JSON.stringify(codeResp)}`);
  console.log(`\nOpen: https://github.com/login/device\n   Enter code: ${codeResp.user_code}\nWaiting...`);
  let attempts = (codeResp.expires_in || 300) / (codeResp.interval || 5);
  while (attempts-- > 0) {
    await sleep((codeResp.interval || 5) * 1000);
    const r = await postForm('https://github.com/login/oauth/access_token', { client_id: CLIENT_ID, device_code: codeResp.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (r.access_token) { saveToken({ access_token: r.access_token }); console.log('Auth successful!'); return readJSON(TOKEN_FILE); }
    if (r.error === 'authorization_pending') { process.stdout.write('.'); continue; }
    if (r.error === 'slow_down') { await sleep((codeResp.interval || 5) * 1000); continue; }
    throw new Error(`OAuth error: ${r.error}`);
  }
  throw new Error('Auth timed out');
}

function postForm(urlStr, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const body = Object.entries(data).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const options = { hostname: urlObj.hostname, port: 443, path: urlObj.pathname, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'Accept': 'application/json', 'User-Agent': 'github-work-skill/1.0' } };
    const req = https.request(options, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

function getWip() { return readJSON(wip_FILE) || {}; }
function saveWip(p) { writeJSON(wip_FILE, p); }
function clearWip() { if (fs.existsSync(wip_FILE)) fs.unlinkSync(wip_FILE); }

function git(cmd, cwd) {
  try { return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch (e) { throw new Error(`Git error: ${e.message}`); }
}

function getRemoteRepo(workdir) {
  const remotes = git('git remote -v', workdir).split('\n');
  const match = remotes.find(l => l.includes('origin'));
  if (!match) throw new Error('No origin remote found');
  const m = match.match(/git@github\.com:([^/]+\/[^.]+)\.git/) || match.match(/https:\/\/github\.com\/([^/]+\/[^/]+)/);
  if (!m) throw new Error(`Cannot parse remote: ${match}`);
  return m[1];
}

function getCurrentBranch(cwd) { return git('git branch --show-current', cwd); }

function getDefaultBranch(cwd) {
  try { return execSync('git symbolic-ref refs/remotes/origin/HEAD', { encoding: 'utf8' }).trim().split('/').pop(); } catch (e) {}
  return 'main';
}

// --- Review checklist ---
const REVIEW_ITEMS = [
  'Does the implementation match the Issue requirements?',
  'Are there any out-of-scope changes?',
  'Are there any missing pieces?',
];

// --- Commands ---

async function cmdStart(args) {
  const workdir = args[0];
  if (!workdir) throw new Error('Usage: /gtw on <workdir>');
  const expandedWorkdir = workdir.startsWith('~') ? path.join(os.homedir(), workdir.slice(1)) : workdir;
  const absWorkdir = path.isAbsolute(expandedWorkdir) ? expandedWorkdir : path.join(process.cwd(), expandedWorkdir);
  if (!path.isAbsolute(absWorkdir)) throw new Error('Please use an absolute path, e.g. /Users/name/code/myproject or ~/code/myproject');
  if (!fs.existsSync(absWorkdir)) throw new Error(`Directory not found: ${absWorkdir}`);
  const repo = getRemoteRepo(absWorkdir);
  const wip = { workdir: absWorkdir, repo, createdAt: new Date().toISOString() };
  saveWip(wip);
  return {
    ok: true,
    workdir: absWorkdir,
    repo,
    display: `✅ 已切换工作目录\n\n📁 ${absWorkdir}\n🔗 ${repo}`,
    message: `workdir set to ${absWorkdir}, repo: ${repo}`,
  };
}

async function cmdNew(args) {
  const wip = getWip();
  if (!wip.repo) throw new Error('No repo set. Run /gtw on <workdir> first');
  const title = args[0] || '';
  const body = args.slice(1).join(' ') || '';
  const updated = { ...wip, issue: { action: 'create', id: null, title, body }, updatedAt: new Date().toISOString() };
  saveWip(updated);
  return { ok: true, wip: updated, message: title ? `Issue draft saved: "${title}"` : 'Issue draft saved (title/body will be filled by agent)', display: title ? `📝 Issue 草稿已保存\n\n标题: ${title}` : '📝 Issue 草稿已保存\n\n（agent 将填写标题和正文）' };
}

async function cmdUpdate(args) {
  const id = parseInt(args[0], 10);
  if (isNaN(id)) throw new Error('Usage: /gtw update #<id> [title] [body...]');
  const wip = getWip();
  if (!wip.repo) throw new Error('No repo set. Run /gtw on <workdir> first');
  // Parse remaining args as title body pairs
  const rest = args.slice(1).join(' ');
  const updated = { ...wip, issue: { action: 'update', id, title: rest, body: '' }, updatedAt: new Date().toISOString() };
  saveWip(updated);
  return { ok: true, wip: updated, message: `Issue #${id} update draft saved`, display: `📝 Issue #${id} 更新草稿已保存` };
}

async function cmdConfirm(args) {
  const token = getToken();
  const wip = getWip();
  if (!wip.repo) throw new Error('No pending action. Run /gtw on + /gtw new first');
  const results = [];

  if (wip.issue?.title) {
    const { action, id, title, body } = wip.issue;
    if (action === 'create') {
      const data = await apiRequest('POST', `/repos/${wip.repo}/issues`, token, { title, body: body || 'Created via github-work skill' });
      results.push({ type: 'issue', action: 'created', id: data.number, url: data.html_url });
    } else if (action === 'update' && id) {
      const data = await apiRequest('PATCH', `/repos/${wip.repo}/issues/${id}`, token, { title, body });
      results.push({ type: 'issue', action: 'updated', id, url: data.html_url });
    }
  }

  if (wip.branch?.name && wip.issue?.id) {
    const shaResp = await apiRequest('GET', `/repos/${wip.repo}/git/ref/heads/${getDefaultBranch(wip.workdir)}`, token);
    await apiRequest('POST', `/repos/${wip.repo}/git/refs`, token, { ref: `refs/heads/${wip.branch.name}`, sha: shaResp.object.sha });
    const [owner, repoName] = wip.repo.split('/');
    try { await apiRequest('POST', `/repos/${owner}/${repoName}/issues/${wip.issue.id}/labels`, token, { labels: [`branch:${wip.branch.name}`] }); } catch(e) {}
    results.push({ type: 'branch', action: 'created', name: wip.branch.name });
  }

  if (wip.pr?.title) {
    const baseBranch = getDefaultBranch(wip.workdir);
    const headBranch = wip.branch?.name || getCurrentBranch(wip.workdir);
    const body = wip.pr.body || `Closes #${wip.issue?.id || '?'}`;
    const data = await apiRequest('POST', `/repos/${wip.repo}/pulls`, token, { title: wip.pr.title, body, head: headBranch, base: baseBranch });
    results.push({ type: 'pr', action: 'created', id: data.number, url: data.html_url });
  }

  clearWip();
  return { ok: true, results, message: 'Pending actions executed and cleared', display: `🚀 已执行所有待处理操作并清空 wip.json\n\n${results.map(r => `• ${r.type} #${r.id || r.name}: ${r.action}`).join('\n')}` };
}

async function cmdFix(args) {
  const wip = getWip();
  if (!wip.workdir) throw new Error('No workdir set. Run /gtw on <workdir> first');
  const workdir = wip.workdir;
  const branchName = args[0] || `fix/${Date.now()}`;
  const defaultBranch = getDefaultBranch(workdir);
  git('git fetch origin', workdir);
  git(`git checkout ${defaultBranch}`, workdir);
  git(`git pull --rebase origin ${defaultBranch}`, workdir);
  git(`git checkout -b ${branchName}`, workdir);
  const updated = { ...wip, branch: { name: branchName }, updatedAt: new Date().toISOString() };
  saveWip(updated);
  return { ok: true, branch: branchName, base: defaultBranch, workdir, message: `Switched to new branch '${branchName}' (rebased on ${defaultBranch})`, display: `🌿 已创建并切换到新分支\n\n分支名: ${branchName}\n基于: ${defaultBranch}\n\n执行 /gtw pr 推送分支，或直接写代码后 /gtw push` };
}

async function cmdPr(args) {
  const wip = getWip();
  if (!wip.workdir) throw new Error('No workdir set. Run /gtw on <workdir> first');
  if (!wip.branch?.name) throw new Error('No branch. Run /gtw fix [name] first');
  const workdir = wip.workdir;
  const branchName = wip.branch.name;
  git(`git push -u origin ${branchName}`, workdir);
  let prBody = '';
  if (wip.issue?.id) {
    try {
      const token = getToken();
      const issue = await apiRequest('GET', `/repos/${wip.repo}/issues/${wip.issue.id}`, token);
      prBody = `## Linked Issue\\nCloses #${wip.issue.id}\\n\\n${issue.body || ''}\\n\\n---\\n_Generated by github-work skill_`;
    } catch(e) {}
  }
  const updated = { ...wip, pr: { title: wip.pr?.title || `Fix #${wip.issue?.id || ''}: ${branchName}`, body: prBody }, updatedAt: new Date().toISOString() };
  saveWip(updated);
  return { ok: true, branch: branchName, message: `Branch pushed. Run /gtw confirm to create PR`, display: `⬆️ 分支已推送\n\n分支: ${branchName}\n\n运行 /gtw confirm 创建 PR` };
}

async function cmdPush(args) {
  const wip = getWip();
  if (!wip.workdir) throw new Error('No workdir set. Run /gtw on <workdir> first');
  const workdir = wip.workdir;
  const branch = getCurrentBranch(workdir);
  const diff = git('git diff --cached', workdir) || git('git diff', workdir) || '';
  const stats = git('git diff --stat --cached', workdir) || git('git diff --stat', workdir) || '';
  const updated = { ...wip, push: { branch, diff, stats, staged: !!git('git diff --cached', workdir) }, updatedAt: new Date().toISOString() };
  saveWip(updated);
  return { ok: true, branch, stats, message: `Changes staged. Commit message needed. Use /gtw confirm push`, display: `📦 变更已暂存\n\n分支: ${branch}\n变更统计: ${stats || '无变更'}\n\n运行 /gtw confirm 提交并推送` };
}

// review: fully automatic - claim -> agent reviews -> verdict -> release claim
async function cmdReview(args) {
  const token = getToken();
  const wip = getWip();
  const verdictArg = args.find(a => a === 'approved' || a === 'changes') || null;
  const repo = wip.repo || (args.find(a => String(a).includes('/')) || '');

  if (!repo) throw new Error('No repo set. Run /gtw on <workdir> first');

  const myLogin = (await apiRequest('GET', '/user', token)).login;

  // Parse PR number from args
  let targetPrNum = null;
  for (const a of args) {
    const m = String(a).match(/^#?(\d+)$/);
    if (m) { targetPrNum = parseInt(m[1]); break; }
  }

  let targetPr = null;
  if (targetPrNum) {
    try {
      targetPr = await apiRequest('GET', `/repos/${repo}/pulls/${targetPrNum}`, token);
      if (verdictArg === null) {
        const comments = await apiRequest('GET', `/repos/${repo}/issues/${targetPrNum}/comments`, token);
        const hasClaim = comments.some(c => c.body?.includes('eyes'));
        if (hasClaim) return { ok: true, claimed: false, message: `PR #${targetPrNum} already claimed. Call /gtw review #${targetPrNum} approved|changes after reviewing`, display: `⚠️ PR #${targetPrNum} 已被认领\n\n请先查看该 PR 的评审状态，再调用 /gtw review #${targetPrNum} approved|changes` };
      }
    } catch (e) { throw new Error(`PR #${targetPrNum} not found`); }
  } else {
    const params = new URLSearchParams({ state: 'open', per_page: '50', sort: 'created', direction: 'asc' });
    const prs = await apiRequest('GET', `/repos/${repo}/pulls?${params}`, token);
    for (const pr of prs) {
      if (pr.user?.login === myLogin) continue;
      const comments = await apiRequest('GET', `/repos/${repo}/issues/${pr.number}/comments`, token);
      if (!comments.some(c => c.body?.includes('eyes'))) { targetPr = pr; break; }
    }
  }

  if (!targetPr) return { ok: true, message: 'No unclaimed PRs found', repo, display: `🔍 暂无可认领的 PR\n\n当前没有未被人认领的开放 PR` };

  const prNum = targetPr.number;

  // Get linked issue
  let linkedIssue = { title: '', body: '' };
  const match = targetPr.body?.match(/(?:closes|fixes|cloze)s?\s+#(\d+)/i);
  if (match) {
    try {
      const li = await apiRequest('GET', `/repos/${repo}/issues/${match[1]}`, token);
      linkedIssue = { title: li.title || '', body: li.body || '' };
    } catch (e) {}
  }

  const allComments = await apiRequest('GET', `/repos/${repo}/issues/${prNum}/comments`, token);
  const myPrevComments = allComments.filter(c => c.user?.login === myLogin);

  // Second call with verdict
  if (verdictArg) {
    const emoji = verdictArg;
    const reviewState = verdictArg === 'approved' ? 'APPROVED' : 'CHANGES_REQUESTED';
    for (const c of myPrevComments) { await apiRequest('DELETE', `/repos/${repo}/issues/comments/${c.id}`, token).catch(() => {}); }
    await apiRequest('POST', `/repos/${repo}/issues/${prNum}/comments`, token, { body: `${emoji} **Review complete** by @${myLogin} — ${verdictArg === 'approved' ? 'approves' : 'requests changes'}` });
    await apiRequest('POST', `/repos/${repo}/pulls/${prNum}/reviews`, token, { body: emoji, event: reviewState });
    return { ok: true, verdict: verdictArg, pr: { number: prNum, title: targetPr.title, url: targetPr.html_url }, repo, message: `${emoji} Review complete for PR #${prNum} — claim released`, display: verdictArg === 'approved' ? `✅ PR #${prNum} 评审通过\n\n${targetPr.title}\n\n认领已释放，可进行合并` : `❌ PR #${prNum} 评审需修改\n\n${targetPr.title}\n\n认领已释放，开发者可提交修订` };
  }

  // First call - claim
  const prevChecked = {};
  for (const c of myPrevComments) {
    for (const line of c.body.split('\n')) {
      const m = line.match(/^\s*-\s*\[([ x])\]\s*(.+)/);
      if (m) prevChecked[m[2].trim()] = m[1] === 'x';
    }
  }

  const checklistItems = REVIEW_ITEMS.map(item => ({ text: item, checked: !!prevChecked[item] }));
  const checklistLines = checklistItems.map(i => `  - [${i.checked ? 'x' : ' '}] ${i.text}`).join('\n');

  await apiRequest('POST', `/repos/${repo}/issues/${prNum}/comments`, token, {
    body: `eyes **Review claimed** by @${myLogin}\n\n_Emoji: eyes = in progress, approved = done, changes = needs changes_\n\n## Review Checklist\n\n${checklistLines}\n\n---\n_Agent: review the diff and linked issue, then call:\n  /gtw review #${prNum} approved   # or changes_`,
  });

  const files = await apiRequest('GET', `/repos/${repo}/pulls/${prNum}/files?per_page=100`, token);
  const filesSummary = files.map(f => `  - ${f.filename}: +${f.additions} -${f.deletions}`).join('\n');

  return {
    ok: true, claimed: true,
    pr: { number: prNum, title: targetPr.title, url: targetPr.html_url, user: targetPr.user?.login },
    linkedIssue,
    files: files.map(f => ({ filename: f.filename, additions: f.additions, deletions: f.deletions, patch: f.patch })),
    checklist: checklistItems,
    hasPrevReview: myPrevComments.length > 0,
    repo,
    verdictNeeded: `/gtw review #${prNum} approved   # or changes`,
    message: `eyes Claimed PR #${prNum}: ${targetPr.title}\n\nLinked Issue: ${linkedIssue.title || 'none'}\n\nFiles changed (${files.length}):\n${filesSummary}\n\nReview the diff against the issue requirements, then call:\n/gtw review #${prNum} approved   # or changes`,
  };
}

async function cmdIssue(args) {
  const token = getToken();
  const wip = getWip();
  const repo = args[0] && String(args[0]).includes('/') ? args[0] : wip.repo;
  if (!repo) throw new Error('No repo. Run /gtw on <workdir> first, or pass owner/repo');
  const params = new URLSearchParams({ state: 'open', per_page: '50' });
  const data = await apiRequest('GET', `/repos/${repo}/issues?${params}`, token);
  const issues = data.filter(i => !i.pull_request);
  if (!issues.length) return { ok: true, repo, issues: [], message: `No open issues in ${repo}`, display: `📋 暂无可见的开放 Issue` };
  return { ok: true, repo, issues: issues.map(i => ({ number: i.number, title: i.title, state: i.state, url: i.html_url })), display: issues.map(i => `[#${i.number}] ${i.title}`).join('\n') };
}

async function cmdShow(args) {
  const token = getToken();
  const wip = getWip();
  const id = parseInt(args[0], 10);
  if (isNaN(id)) throw new Error('Usage: /gtw show #<id>');
  const repo = args[1] && String(args[1]).includes('/') ? args[1] : wip.repo;
  if (!repo) throw new Error('No repo set. Run /gtw on <workdir> first');
  const data = await apiRequest('GET', `/repos/${repo}/issues/${id}`, token);
  return { ok: true, issue: { number: data.number, title: data.title, body: data.body, state: data.state, url: data.html_url, assignee: data.assignee?.login }, display: `[#${data.number}] ${data.title}\n\n${data.body || ''}\n\nState: ${data.state}\nURL: ${data.html_url}` };
}

async function cmdPoll(args) {
  const token = getToken();
  const wip = getWip();
  const repo = wip.repo;
  if (!repo) throw new Error('No repo set. Run /gtw on <workdir> first');

  const sub = args[0];

  if (sub === 'issue') {
    const params = new URLSearchParams({ state: 'open', per_page: '10', sort: 'created', direction: 'asc' });
    const data = await apiRequest('GET', `/repos/${repo}/issues?${params}`, token);
    const issues = data.filter(i => !i.pull_request);
    return {
      ok: true, type: 'issue', repo,
      issues: issues.map(i => ({ number: i.number, title: i.title, state: i.state, url: i.html_url, created_at: i.created_at, assignee: i.assignee?.login })),
      display: issues.length ? issues.map(i => `[#${i.number}] ${i.title} (${(i.created_at || '').split('T')[0]})`).join('\n') : 'No open issues',
    };
  }

  if (sub === 'pr') {
    const params = new URLSearchParams({ state: 'open', per_page: '10', sort: 'created', direction: 'asc' });
    const data = await apiRequest('GET', `/repos/${repo}/pulls?${params}`, token);
    const prData = data.map(pr => ({ number: pr.number, title: pr.title, state: pr.state, url: pr.html_url, created_at: pr.created_at, user: pr.user?.login }));
    return {
      ok: true, type: 'pr', repo,
      prs: prData,
      display: prData.length ? prData.map(pr => `[#${pr.number}] ${pr.title} by @${pr.user} (${(pr.created_at || '').split('T')[0]})`).join('\n') : 'No open PRs',
    };
  }

  // Default: both
  const issueParams = new URLSearchParams({ state: 'open', per_page: '10', sort: 'created', direction: 'asc' });
  const prParams = new URLSearchParams({ state: 'open', per_page: '10', sort: 'created', direction: 'asc' });
  const [issuesData, prsData] = await Promise.all([
    apiRequest('GET', `/repos/${repo}/issues?${issueParams}`, token),
    apiRequest('GET', `/repos/${repo}/pulls?${prParams}`, token),
  ]);
  const issues = issuesData.filter(i => !i.pull_request);
  let display = issues.length ? '\nOpen Issues (oldest first):\n' + issues.map(i => `  [#${i.number}] ${i.title} (${(i.created_at || '').split('T')[0]})`).join('\n') : '\nOpen Issues: none';
  display += prsData.length ? '\n\nOpen PRs (oldest first):\n' + prsData.map(pr => `  [#${pr.number}] ${pr.title} by @${pr.user?.login} (${(pr.created_at || '').split('T')[0]})`).join('\n') : '\nOpen PRs: none';
  if (!issues.length && !prsData.length) display = 'Nothing open.';
  return { ok: true, repo, issues, prs: prsData, display };
}

async function cmdConfig(args) {
  return {
    ok: true,
    workDir: process.cwd(),
    hasToken: !!(ACCESS_TOKEN || readJSON(TOKEN_FILE)?.access_token),
    wip: readJSON(wip_FILE) || null,
  };
}

// --- Dispatch ---
async function main() {
  const input = process.argv[2] || '';
  const parts = input.trim().split(/\s+/).filter(Boolean);
  const cmd = parts[0] || '';
  const args = parts.slice(1);
  let result;
  try {
    switch (cmd) {
      case 'auth': result = await deviceFlow(); break;
      case 'on': result = await cmdStart(args); break;
      case 'new': result = await cmdNew(args); break;
      case 'update': result = await cmdUpdate(args); break;
      case 'confirm': result = await cmdConfirm(args); break;
      case 'fix': result = await cmdFix(args); break;
      case 'pr': result = await cmdPr(args); break;
      case 'push': result = await cmdPush(args); break;
      case 'review': result = await cmdReview(args); break;
      case 'issue': result = await cmdIssue(args); break;
      case 'show': result = await cmdShow(args); break;
      case 'poll': result = await cmdPoll(args); break;
      case 'config': result = await cmdConfig(args); break;
      default:
        throw new Error(`Unknown: ${cmd}. Use: start, new, update, confirm, fix, pr, push, review, issue, show, poll, config`);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

main();
