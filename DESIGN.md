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
    NewCommand.js           ← Auto-generate issue draft from session (LLM)
    FixCommand.js           ← Create fix branch
    PrCommand.js            ← Push branch + prepare PR body
    PushCommand.js          ← git add → commit → push
    ConfirmCommand.js       ← Execute pending actions (issue/PR creation)
    ReviewCommand.js        ← Claim + review + verdict PR
    IssueCommand.js         ← List open issues
    ShowCommand.js          ← Show issue detail
    PollCommand.js          ← Poll issues/PRs
    ConfigCommand.js        ← Show current config + WIP state
    ModelCommand.js         ← Set/unset LLM model for draft generation
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
injectMessageToParentSession(phaseText)  ← appends to JSONL
  │
  ▼
return { text: display }
```

### LLM Integration

Only `NewCommand` uses the LLM:

1. `extractMessages(sessionKey)` reads the parent session JSONL for the current session
2. Finds cutoff: last `/gtw confirm` message (or from start if not found)
3. Extracts all `role === 'user'` and `role === 'assistant'` messages from cutoff onwards
4. Builds a prompt with those messages (no "no code" constraint needed — parent session already has it via OnCommand injection)
5. Calls `api.runtime.agent.runEmbeddedPiAgent()` with `disableTools: true` in a clean, isolated subagent session
6. Parses LLM's JSON response → extracts `title` + `body`
7. Saves draft to `wip.json`

No other command uses the LLM.

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
| `~/.openclaw/gtw/config.json` | Custom LLM model setting |
| `~/.openclaw/gtw/token.json` | Cached gh CLI token |

## Workflow

```
/gtw on <workdir>     → set workdir + repo + inject phase directive
/gtw new              → auto-generate issue draft from session (LLM, no args)
/gtw confirm          → execute: create issue, branch, PR
```

## Notes for LLM Agents

- **Read this file first** when working on gtw
- Commands are isolated: modify only the specific `XxxCommand.js` file
- Do not add business logic to `index.js` — route it through the factory
- The legacy `scripts/index.cjs` is kept for CLI compatibility but is not used by the plugin

## Phase Directive

OnCommand calls `injectMessage(sessionKey, text)` after saving wip state. This appends a user message to the parent session JSONL:

```
Workdir: <absWorkdir>
Repo: <repo>

Let's discuss the requirements first — no code yet.
```

The parent agent reads this on its next poll and enters discussion mode (no code). The subagent session used by NewCommand is isolated and unaffected.
