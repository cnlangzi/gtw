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
/gtw review             Claim earliest unclaimed PR (adds eyes comment with review checklist)
/gtw review #<pr> approved   # or changes   Finalize review — labels PR, posts verdict comment, releases claim
```

### Config

```
/gtw config             Show current config and wip.json
```

## Configuration

### Authentication

`gtw` uses the GitHub CLI (`gh`) for authentication. Make sure `gh auth login` has been run with `repo` scope:

```bash
gh auth login --hostname github.com
gh auth status
```

Check auth status anytime:

```
/gtw auth
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_ACCESS_TOKEN` | No | Falls back to `gh auth token` if not set |

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
You: /gtw review
→ eyes Claimed PR #23: fix: handle null pointer
   Linked Issue: handle null pointer in auth
   Files changed (3):
     - src/auth.js: +10 -2
     - tests/auth.test.js: +5 -0
   Review the diff against the issue requirements, then call:
   /gtw review #23 approved   # or changes

You: /gtw review #23 approved
→ ✅ PR #23 approved
   Claim released, ready to merge
```

**Two-call review verdict flow:**
1. First call (`/gtw review` or `/gtw review #<pr>`): Claims the PR by adding an `eyes` comment with a review checklist. The PR is considered "in progress".
2. Second call (with `approved` or `changes`): Finalizes the review — deletes the eyes comment, posts the verdict emoji, submits the GitHub review with the appropriate state (APPROVED or CHANGES_REQUESTED), and releases the claim.

## State Files

```
~/.openclaw/gtw/wip.json       # Workdir, repo, pendingCommit, pendingPr, issue, branch
~/.openclaw/gtw/token.json     # Cached gh CLI token
~/.openclaw/gtw/config.json    # Custom AI model setting
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
2. `/gtw review #<pr> approved` → should post approved comment and submit GitHub review
3. PR page → should show review state as "Approved"

### What to Observe

| Flow | Check |
|------|-------|
| `pendingCommit` created | `wip.json` contains `pendingCommit` after `/gtw push` |
| `pendingPr` created | `wip.json` contains `pendingPr` after `/gtw pr` |
| `gtw/wip` label applied | GitHub issue shows `gtw/wip` label after `/gtw fix` |
| `gtw/wip` label removed | GitHub issue loses `gtw/wip` label after fix flow completes |
| Eyes comment posted | GitHub PR shows `eyes` comment from your login |
| Review verdict posted | GitHub PR shows `approved` or `changes` emoji comment |

## Architecture

```
gtw/
├── index.js                 # Plugin entry (ESM, registerCommand)
├── openclaw.plugin.json     # Plugin manifest
├── package.json             # ESM package
├── commands/                # OOP Commander pattern (one class per command)
│   └── *.js
└── utils/
    ├── session.js           # Parent session read/write (JSONL injection)
    └── *.js
```
