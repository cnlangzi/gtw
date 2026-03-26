---
name: gtw
description: gtw - GitHub team workflow skill. Session-based workflow with LLM-assisted issue generation and git operations.
metadata: {"openclaw":{"user-invocable":true,"emoji":"🔧"}}
---

# gtw (gtw)

GitHub team collaboration workflow skill. Session-based design: drafts go to wip.json, confirm before executing.

## Usage

```
/gtw <command> [args]
```

## Configuration

```json
"skills": {
  "entries": {
    "gtw": {
      "env": {
        "GITHUB_ACCESS_TOKEN": "ghp_xxx",
      }
    }
  }
}
```


---

## Command Reference

### Workflow Setup

```
/gtw on <workdir>
```
Resolves git remote from a local directory and writes it to wip.json. All subsequent commands use this repo.

```
/gtw new
```
LLM reads the conversation, generates an Issue draft (title + body), and writes it to wip.json. No GitHub API call.

```
/gtw update #<id>
```
LLM re-reads the conversation to update Issue #<id>'s draft in wip.json.

```
/gtw confirm
```
Executes all pending operations in wip.json:
- `issue.action == 'create'` -> creates Issue
- `issue.action == 'update'` -> updates Issue
- `branch.name` is set -> creates branch (linked to issue)
- `pr.title` is set -> creates Pull Request (linked to issue)
After execution, wip.json is cleared.

---

### Git Operations

```
/gtw fix [name]
```
- `git fetch origin`
- `git checkout main`
- `git pull --rebase origin main`
- `git checkout -b <name>` (default: `fix/<timestamp>`)
Result written to wip.json.branch.

```
/gtw pr
```
- `git push -u origin <branch>`
- Generates PR title/body (linked to issue)
- Result written to wip.json.pr — execute with `/gtw confirm`

```
/gtw push
```
- `git add -A`
- Shows staged changes summary
- LLM generates a [Conventional Commits](https://www.conventionalcommits.org/) formatted commit message
- `git commit && git push`

---

### Review

```
/gtw review
```
Finds the earliest unclaimed open PR in wip.json's repo and:
1. Claims it with eyes
2. Posts a review checklist
3. Returns PR title, linked issue, diff, and checklist

Agent reviews the diff against the issue, then calls:
```
/gtw review #<pr> approved   # or changes
```
Posts verdict, releases claim, submits GitHub Official Review.



### Information

```
/gtw issue              # Lists open issues in current repo (from wip.json)
/gtw show #<id>         # Shows Issue #<id> details
/gtw poll issue         # Top 10 open issues, oldest first
/gtw poll pr           # Top 10 open PRs, oldest first
/gtw config            # Shows config and wip.json contents
```

---

## wip.json Schema

File: `~/.openclaw/gtw/wip.json`

```json
{
  "workdir": "/path/to/workdir",
  "repo": "owner/repo",
  "issue": { "action": "create|update", "id": null, "title": "", "body": "" },
  "branch": { "name": "" },
  "pr": { "title": "", "body": "" },
  "createdAt": "ISO"
}
```

---

## Standard Workflow

```
You: /gtw on ~/code/myproject
Agent: workdir set, repo: owner/repo

You: /gtw new
Agent: Generates Issue draft:
       Title: xxx
       Body: ...
       [wip.json — run /gtw confirm]

You: /gtw fix login-bug
Agent: Branch fix/login-bug created (rebased on main)
       [wip.json — run /gtw confirm]

You: /gtw pr
Agent: Branch pushed. Run /gtw confirm

You: /gtw confirm
Agent: Issue #45 created
       Branch created
       PR #78 created
       [wip.json cleared]
```

---

## Cron Configuration

```json
"cron": {
  "entries": {
    "gtw-poll": {
      "schedule": "*/15 * * * *",
      "task": "/gtw poll",
      "enabled": false
    }
  }
}
```

---

## Implementation

- **Entry**: `scripts/index.js` (Node.js, no npm dependencies)
- **Token**: PAT or OAuth Device Flow
- **Git**: Direct local git command execution
- **GitHub API**: REST API v3
- **Storage**: `~/.openclaw/gtw/wip.json` (0600)
- **Dependencies**: None (pure Node.js built-ins only)
