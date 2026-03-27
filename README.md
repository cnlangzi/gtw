# gtw — GitHub Team Workflow (OpenClaw Plugin)

> GitHub team workflow automation — session-based issue generation, git operations, and PR review coordination via slash command.

## Features

- **Session-based workflow** — Draft in `wip.json`, confirm when ready. No accidental API calls.
- **LLM-assisted issue creation** — `/gtw new` reads the conversation and generates a structured issue.
- **Git operations** — `fix`, `push`, and `pr` commands wrap standard git workflows.
- **Emoji review protocol** — eyes claim → checklist → approved/changes verdict.
- **Zero external dependencies** — Plain Node.js, no npm packages.

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
/gtw new                Draft a new issue from conversation
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
/gtw push               Stage → auto-commit (conventional format) → push（直接执行，无需 confirm）
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

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_ACCESS_TOKEN` | Yes | GitHub Personal Access Token (`repo` scope) |
| `GITHUB_CLIENT_ID` | No | For OAuth Device Flow |
| `GITHUB_CLIENT_SECRET` | No | For OAuth Device Flow |

Set in `openclaw.json` env or shell environment.

### Getting a GitHub Token

1. **Settings → Developer settings → Personal access tokens → Generate new token (classic)**
2. Grant `repo` scope
3. Set `GITHUB_ACCESS_TOKEN=ghp_xxx` in your environment or openclaw env config

## Standard Workflow

```
You: /gtw on ~/code/myproject
→ ✅ 已切换工作目录 /home/user/code/myproject, repo: owner/repo

You: /gtw new
→ 📝 Issue 草稿已保存

You: /gtw fix login-bug
→ 🌿 已创建并切换到新分支 fix/login-bug

You: /gtw pr
→ ⬆️ 分支已推送（草稿状态）

You: /gtw push
→ 📦 已提交并推送（直接执行，无需 confirm）

You: /gtw confirm
→ 🚀 已执行所有待处理操作并清空 wip.json
```

## State File

```
~/.openclaw/gtw/wip.json
~/.openclaw/gtw/token.json
```

## Architecture

```
gtw/                         # Plugin directory
├── index.js                 # Plugin entry (ESM, registerCommand)
├── openclaw.plugin.json     # Plugin manifest
├── package.json             # ESM package
└── scripts/
    └── index.cjs            # CLI implementation (CJS, no dependencies)
```
