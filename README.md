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
/gtw fix [name]         Create fix branch (rebased on main)
/gtw pr                 Push branch and draft PR
/gtw push               Stage → auto-commit (conventional format) → push (executes directly, no confirm needed)
```

### Review

```
/gtw review             Find and claim earliest unclaimed PR
/gtw review #<pr> approved   # or changes
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

You: /gtw fix login-bug
→ 🌿 Created and checked out new branch fix/login-bug

You: /gtw pr
→ ⬆️ Branch pushed to origin (draft state)

You: /gtw push
→ 📦 Committed and pushed (executes directly, no confirm needed)

You: /gtw confirm
→ 🚀 Executed all pending actions and cleared wip.json
```

**Phase directive:** `/gtw on` injects a "no code yet" message into the parent session so the agent stays in discussion mode until `/gtw confirm`.

## State File

```
~/.openclaw/gtw/wip.json
~/.openclaw/gtw/token.json
```

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
