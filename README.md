# gtw — GitHub Team Workflow (OpenClaw Plugin)

> GitHub team workflow automation — session-based issue generation, git operations, and PR review coordination via slash command.

## Features

- **Session-based workflow** — Draft in `wip.json`, confirm when ready. No accidental API calls.
- **AI-assisted issue creation** — `/gtw new` reads the parent session history and auto-generates a structured issue draft (title + body) with no manual input required.
- **Git operations** — `fix`, `push`, and `pr` commands wrap standard git workflows.
- **Emoji review protocol** — eyes claim → checklist → approved/changes verdict.
- **GitHub CLI integration** — Uses `gh` for auth; no manual token config needed.

## Installation

```bash
openclaw plugins install -l /home/devin/code/plugins/gtw
```

This registers the `/gtw` slash command and enables the plugin. Gateway hot-reloads automatically.

## Usage

```
/gtw <command> [args]
```

### Setup

```
/gtw on <workdir>       Set working directory (resolves git remote)
```

### Issue Management

```
/gtw new                Read conversation history, auto-generate issue draft (title + body) via AI, save to wip.json
/gtw update #<id>       Update issue draft
/gtw confirm            Execute all pending operations (create issue/branch/PR)
/gtw issue              List open issues
/gtw show #<id>         Show issue details
/gtw poll              List open issues and PRs
```

### Git Operations

```
/gtw fix <issue_id>     Claim issue (add gtw/wip label), fetch issue, derive branch name, create branch,
                          inject directive to trigger subagent, subagent fixes automatically, creates
                          pendingCommit, requires /gtw confirm to push, then unclaims (removes label)
/gtw push               Stage → auto-commit (conventional format) → generate commit draft → save as pendingCommit
                          (two-step: run /gtw confirm to actually push)
/gtw rebase [branch]    Sync current branch with remote — 有分支名：fetch → checkout → rebase 远程分支
                          — 无分支名：git pull --rebase origin <当前分支>
/gtw pr [issue_id]      Generate PR title/body via LLM from commit diff, save as pendingPr draft
                          — /gtw pr (no args): uses current branch; never reads wip.json
                          — /gtw pr <issue_id>: derives branch from issue title (same as /gtw fix)
                            If remote branch exists → checks out and hard-resets to it.
                            If local branch exists but remote missing → checks out and prompts to run /gtw push.
                            If neither exists → uses current branch.
                          (two-step: run /gtw confirm to actually create the PR)
```

### Review

```
/gtw review             Claim earliest PR with gtw/ready label from watch list
/gtw review <pr>       Claim/review specific PR in current repo
/gtw watch add <owner>/<repo>   Add repo to watch list
/gtw watch rm <owner>/<repo>    Remove repo from watch list
/gtw watch list         Show watched repos
```

### Config

```
/gtw config             Show current config and wip.json
```

## Configuration

### Authentication

`gtw` supports multiple authentication methods:

**Method 1: Personal Access Token (PAT) - Recommended for CI**

Set the `GITHUB_TOKEN` environment variable:

```bash
export GITHUB_TOKEN=ghp_your_token_here
```

**Method 2: Interactive OAuth Login**

Use the device code flow for interactive login:

```
/gtw login
```

This will:
1. Display a verification URL and user code
2. Wait for you to authorize in your browser
3. Cache the OAuth token in `~/.openclaw/gtw/token.json`
4. Automatically reuse the device code if called again within the expiration window (5 minutes)

**Method 3: GitHub CLI Integration**

`gtw` can use `gh` CLI for authentication. Make sure `gh auth login` has been run with `repo` scope:

```bash
gh auth login --hostname github.com --scopes repo,workflow
gh auth status
```

**Token Priority:**
1. `GITHUB_TOKEN` environment variable (PAT)
2. Cached token in `~/.openclaw/gtw/token.json`
3. `gh auth token` (validated before use)

Check auth status anytime:

```
/gtw config
```

## Standard Workflow

```
You: /gtw on ~/code/myproject
→ ✅ Switched to owner/repo
   📁 Workdir: /home/user/code/myproject
   Let's discuss the requirements first — no code yet.

You: /gtw new
→ Draft saved:
   Title: fix: handle null pointer in auth
   Body:
   ## Background
   ...
   ## Acceptance Criteria
   ...

You: /gtw fix 42
→ 🌿 Fix workflow started
   Issue: #42
   Title: fix: handle null pointer in auth
   Branch: fix/handle-null-pointer
   ⏳ Subagent spawned — the main session will now:
   1. Spawn coding subagent to fix the issue
   2. Wait for subagent to finish
   3. Run push + confirm automatically
   (gtw/wip label is applied to issue #42)

You: /gtw push
→ 🔍 Commit draft — run /gtw confirm to push
   📝 Commit Message: fix(auth): handle null pointer in auth
   📊 Changes: +10 -2
   Run /gtw confirm to commit and push.

You: /gtw confirm
→ 📦 Committed and pushed
   Branch: fix/handle-null-pointer
   (gtw/wip label removed from issue #42)

You: /gtw pr
→ 🔍 PR draft — run /gtw confirm to create PR
   📝 Title: fix: handle null pointer in auth
   🌿 Branch: fix/handle-null-pointer → main

You: /gtw confirm
→ ✅ PR #42 created
   URL: https://github.com/owner/repo/pull/42
```

### PR Workflow (with issue)

```
You: /gtw pr 13
→ 🔍 PR draft for issue #13 — run /gtw confirm to create PR
   📝 Title: fix: handle null pointer in auth
   🌿 Branch: fix/handle-null-pointer
   ⚠️  Remote branch missing — please run /gtw push to publish this branch
   Issue: #13 — handle null pointer in auth

You: /gtw push
→ 🔍 Commit draft — run /gtw confirm to push
   📝 Commit Message: fix(auth): handle null pointer in auth
   Run /gtw confirm to commit and push.

You: /gtw confirm
→ 📦 Committed and pushed
   Branch: fix/handle-null-pointer

You: /gtw pr 13
→ 🔍 PR draft for issue #13 — run /gtw confirm to create PR
   📝 Title: fix: handle null pointer in auth
   🌿 Branch: fix/handle-null-pointer → main
   Issue: #13 — handle null pointer in auth

You: /gtw confirm
→ ✅ PR #42 created
   URL: https://github.com/owner/repo/pull/42
```

### Review Workflow

```
You: /gtw watch add owner/repo
→ ✅ Now watching: owner/repo

You: /gtw review
→ eyes Claimed PR #23: fix: handle null pointer
   Linked Issue: #12 — handle null pointer in auth
   Files changed (3):
     - src/auth.js: +10 -2
     - tests/auth.test.js: +5 -0
   Review [Round 1/5]
     - [ ] Destructive
     - [ ] Out-of-scope
   Review the diff against the issue requirements.
   Run /gtw review 23 again after resolving items.

You: /gtw review 23
→ eyes PR #23 re-review (Round 2/5)
   [Items still unresolved kept as unchecked]
   Review the diff and update checklist.
```

**Review protocol:**
- `/gtw review` (no-arg): Scans watch list for PRs labeled `gtw/ready`, picks the oldest by `updated_at`, claims it (`gtw/wip`), creates a Round 1 checklist.
- `/gtw review <pr>`: Reviews specific PR in the current repo (from `wip.json`). If a checklist exists, increments the round and updates the same comment.
- Checklist items (always two): **Destructive** and **Out-of-scope** — the canonical checks to prevent AI-caused unplanned or out-of-scope modifications.
- Each invocation increments the round number. Unresolved items remain unchecked.
- When all checkboxes are resolved (checked): checklist comment is deleted, approved comment posted, `gtw/lgtm` label applied.
- When round reaches 5: `gtw/stuck` label applied, manual intervention required.
- **No GitHub Review API** is used — all review state is tracked via labels and a single persistent checklist comment per PR.

**Label system (mutually exclusive):**
| Label | Meaning |
|-------|---------|
| `gtw/ready` | Pending review |
| `gtw/wip` | Review in progress |
| `gtw/lgtm` | Approved |
| `gtw/revise` | Needs changes |
| `gtw/stuck` | Exceeded max rounds |

## State Files

```
~/.openclaw/gtw/wip.json            # Workdir, repo, pendingCommit, pendingPr, issue, branch
~/.openclaw/gtw/token.json          # Cached token (PAT, OAuth, or gh CLI)
~/.openclaw/gtw/device_code.json    # Cached device code for OAuth login reuse
~/.openclaw/gtw/config.json         # Custom AI model setting
```

### Two-Step Confirm Model

All mutating operations (`/gtw push`, `/gtw pr`) follow a two-step pattern for safety:

1. **Step 1 — Draft**: Command generates a draft (commit message or PR title/body) and saves it as `pendingCommit` or `pendingPr` in `wip.json`. Nothing is pushed or created yet.
2. **Step 2 — Confirm**: `/gtw confirm` reads the pending draft and executes the actual GitHub API call (push or PR creation).

This means every workflow that involves pushing or creating a PR will have a `→ /gtw confirm` step before the final success message.

## Testing / Verification

### End-to-End Checklist for Maintainers

After any change to command logic, verify the affected flow:

**`/gtw push` flow:**
1. `cd <workdir> && echo "// test" >> README.md`
2. `/gtw push` → should show "🔍 Commit draft — run /gtw confirm to push" (NOT immediate push)
3. `cat ~/.openclaw/gtw/wip.json` → should contain `pendingCommit` with title/body/branch
4. `/gtw confirm` → should show "📦 Committed and pushed"
5. `git log --oneline -1` → should show the commit

**`/gtw fix` flow:**
1. `/gtw fix 13` → should claim issue (gtw/wip label appears on GitHub), create branch
2. After subagent completes: `git log --oneline` → should have fix commits
3. `/gtw confirm` → should push the branch
4. GitHub issue #13 → gtw/wip label should be removed

**`/gtw pr` flow:**
1. Ensure branch is pushed and on the correct branch
2. `/gtw pr` → should show "🔍 PR draft — run /gtw confirm to create PR"
3. `cat ~/.openclaw/gtw/wip.json` → should contain `pendingPr` with title/body
4. `/gtw confirm` → should create PR on GitHub and show URL
5. `cat ~/.openclaw/gtw/wip.json` → `pendingPr` should be cleared, `pr` should be set

**`/gtw review` flow:**
1. `/gtw review` → should claim an unclaimed PR (eyes comment appears)
2. `/gtw review <pr> approved` → should post approved comment and submit GitHub review
3. PR page → should show review state as "Approved"

### What to Observe

| Flow | Check |
|------|-------|
| `pendingCommit` created | `wip.json` contains `pendingCommit` after `/gtw push` |
| `pendingPr` created | `wip.json` contains `pendingPr` after `/gtw pr` |
| `gtw/wip` label applied | GitHub issue shows `gtw/wip` label after `/gtw fix` |
| `gtw/wip` label removed | GitHub issue loses `gtw/wip` label after fix flow completes |
| `gtw/ready` PR claimed | GitHub PR shows `gtw/wip` label after `/gtw review` |
| Checklist comment posted | GitHub PR shows `## Review [Round N]` comment |
| Checklist cleared | Checklist comment deleted, `gtw/lgtm` applied |

## Architecture

```
gtw/
├── index.js                 # Plugin entry (ESM, registerCommand)
├── openclaw.plugin.json     # Plugin manifest
├── package.json             # ESM package
├── commands/                # OOP Commander pattern (one class per command)
│   ├── Commander.js         # Base interface
│   ├── CommanderFactory.js  # Factory: cmd string → Commander instance
│   ├── OnCommand.js         # Set workdir + repo
│   ├── NewCommand.js        # Auto-generate issue draft via AI
│   ├── FixCommand.js        # Claim issue, create branch, spawn subagent fix
│   ├── PushCommand.js       # Generate commit message draft (pendingCommit)
│   ├── ConfirmCommand.js    # Execute pending actions
│   ├── ReviewCommand.js     # Review workflow with checklist comments + labels
│   ├── WatchCommand.js      # Manage watch list (add/rm/list repos)
│   └── *.js
└── utils/
    ├── session.js           # Parent session read/write (JSONL injection)
    └── *.js
```
