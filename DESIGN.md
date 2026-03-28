# gtw — Architecture Design

## Overview

gtw (GitHub Team Workflow) is an OpenClaw plugin that provides a structured GitHub workflow through slash commands.

## Command Architecture

gtw uses an **OOP Commander pattern** with a **Factory** to create command instances.

### File Structure

```
gtw/
  index.js                  ← Plugin entry: parses args, routes to factory
  commands/
    Commander.js             ← Base interface (execute(args))
    CommanderFactory.js      ← Factory: cmd string → Commander instance
    OnCommand.js            ← Set workdir + repo + inject phase directive
    NewCommand.js           ← Auto-generate issue draft from session (AI)
    FixCommand.js           ← Create fix branch
    PrCommand.js            ← Push branch + prepare PR body
    PushCommand.js          ← git add → commit → push
    ConfirmCommand.js       ← Execute pending actions (issue/PR creation)
    ReviewCommand.js        ← Claim + review + verdict PR
    IssueCommand.js         ← List open issues
    ShowCommand.js          ← Show issue detail
    PollCommand.js          ← Poll issues/PRs
    ConfigCommand.js        ← Show current config + WIP state
    ModelCommand.js         ← Set/unset AI model for draft generation
    AuthCommand.js          ← Check gh CLI auth status
    UpdateCommand.js        ← Save issue update draft
  utils/
    api.js                  ← GitHub REST API requests + token management
    wip.js                  ← WIP state read/write (wip.json)
    git.js                  ← Git operations (git(), getRemoteRepo(), etc.)
    config.js               ← Config read/write (config.json)
    session.js              ← Parent session JSONL read/write
  scripts/
    index.cjs               ← (Legacy CLI entry, keep for compatibility)
  tests/
    *.test.js
```

## Design Principles

### Open-Closed Principle
- **Open for extension**: add a new command by creating a new file + one MAP entry
- **Closed for modification**: existing command files and index.js stay untouched

### Single Responsibility
- Each `Command` class handles exactly one command
- Shared logic (git, API, WIP state) lives in `utils/`
- index.js only parses args and routes; it does not contain business logic

### Factory Pattern
`CommanderFactory.create(cmd)` returns the correct `Commander` instance from the MAP registry. Unknown commands throw a clear error with the list of valid commands.

### Execution Flow

```
User: /gtw on ~/code/myrepo
  │
  ▼
OpenClaw gateway → plugin handler (index.js)
  │  rawArgs = "on ~/code/myrepo"
  │  parts   = ["on", "~/code/myrepo"]
  │  cmd     = "on"
  │  args    = ["~/code/myrepo"]
  ▼
CommanderFactory.create("on") → new OnCommand(context)
  │
  ▼
OnCommand.execute(args)
  │
  ▼
saveWip({ workdir, repo, createdAt })
  │
  ▼
injectMessage(sessionKey, phaseText)  ← appends requirements directive to session JSONL
  │
  ▼
return { text: display }
```

### AI Integration

Only `NewCommand` uses the AI:

1. `extractMessages(sessionKey)` reads the parent session JSONL for the current session
2. Finds cutoff: last `/gtw confirm` message (or from start if not found)
3. Extracts all `role === 'user'` and `role === 'assistant'` messages from cutoff onwards
4. Builds a prompt with those messages. The current session already has the requirements phase directive injected via OnCommand, so the agent knows not to code yet. The subagent session spawned by NewCommand is isolated and unaffected.
5. Calls `api.runtime.agent.runEmbeddedPiAgent()` with `disableTools: true` in a clean, isolated subagent session
6. Parses AI's JSON response → extracts `title` + `body`
7. Saves draft to `wip.json`

No other command uses the AI.

**Session key resolution:** `sessionKey` comes from `ctx.sessionKey` (set by OpenClaw at plugin invocation). The agent ID is parsed as `sessionKey.split(':')[1]` to locate the correct `sessions/sessions.json` file — no hardcoding.

## Adding a New Command

1. Create `commands/XxxCommand.js` implementing `Commander.execute(args)`
2. Import it in `CommanderFactory.js`
3. Add `xxx: XxxCommand` to the `MAP` object

That's it — index.js does not change.

## Key Data Files

| File | Purpose |
|------|---------|
| `~/.openclaw/gtw/wip.json` | Current workdir, repo, pending issue/branch/pr |
| `~/.openclaw/gtw/config.json` | Custom AI model setting |
| `~/.openclaw/gtw/token.json` | Cached gh CLI token |

## Workflow

```
/gtw on <workdir>     → set workdir + repo + inject requirements phase directive
/gtw new              → auto-generate issue draft from chat via AI (no args)
/gtw confirm          → create issue from wip.issue.title/body + wip.repo
```

## Notes for AI Agents

- **Read this file first** when working on gtw
- Commands are isolated: modify only the specific `XxxCommand.js` file
- Do not add business logic to `index.js` — route it through the factory
- The legacy `scripts/index.cjs` is kept for CLI compatibility but is not used by the plugin

## Phase Directive

OnCommand calls `injectMessage(sessionKey, phaseText)` after saving wip state. This appends a user message to the current session JSONL. The agent reads it on its next response and enters **requirements clarification phase**.

```
Workdir: <absWorkdir>
Repo: <repo>

You are in REQUIREMENTS CLARIFICATION phase.

Your ONLY task right now:
- Read and understand the existing code
- Identify what the current code does and how it works
- Confirm your understanding by describing it back to User
- Ask any clarifying questions

You MUST NOT:
- Write any code
- Modify any files
- Refactor anything
- Suggest fixes (unless asked)

When User confirms your understanding is correct and explicitly says "可以开始了" (or "you can start"), THEN you may begin implementation.

Reply format:
## 当前理解
[用自己的话描述代码逻辑]
## 疑问
[有任何不确定的地方列出来]
```

The subagent session used by NewCommand is isolated and unaffected — it does not read this directive.
