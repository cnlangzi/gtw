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
    OnCommand.js            ← Set workdir + repo
    NewCommand.js           ← Create/update issue draft (LLM generation)
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
OnCommand.execute(args) → { ok, workdir, repo, display }
  │
  ▼
saveWip({ workdir, repo, createdAt })
  │
  ▼
return { text: display }
```

### LLM Integration

Only `NewCommand` (when called with no args) uses the LLM:

1. `extractHumanMessagesFromParentSession()` reads the parent session JSONL
2. Finds cutoff: last `/gtw confirm` message (or from start if not found)
3. Extracts all `role === 'user'` messages from cutoff onwards
4. Builds a prompt with those messages
5. Calls `api.runtime.agent.runEmbeddedPiAgent()` with `disableTools: true`
6. Parses LLM's JSON response → extracts `title` + `body`
7. Saves draft to `wip.json`

No other command uses the LLM.

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
/gtw on <workdir>     → set workdir + repo
/gtw new [title body] → create issue draft (or let LLM generate)
/gtw confirm          → execute: create issue, branch, PR
```

## Notes for LLM Agents

- **Read this file first** when working on gtw
- Commands are isolated: modify only the specific `XxxCommand.js` file
- Do not add business logic to `index.js` — route it through the factory
- The legacy `scripts/index.cjs` is kept for CLI compatibility but is not used by the plugin
