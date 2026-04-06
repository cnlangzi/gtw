# gtw Review Workflow — Specification

## Overview

Deterministic agent-driven PR review flow that prevents unplanned/destructive changes, uses a single persistent checklist comment per PR, supports a watch list of repos, and handles stuck PRs after a maximum number of automated review rounds.

**Out of scope:** Cron scheduling, GitHub Review API.

---

## Label System

Five mutually exclusive labels. When applying any label, all other gtw labels must be removed first. If any label operation fails, abort — do not create comments or modify state.

| Label | Meaning |
|-------|---------|
| `gtw/ready` | Pending review — PR is in the pool |
| `gtw/wip` | Review in progress — claimed by an agent |
| `gtw/revise` | Changes needed — returned to pool for developer |
| `gtw/lgtm` | Approved — ready to merge |
| `gtw/stuck` | Exceeded max rounds — manual intervention required |

---

## Checklist & Comment Strategy

- **No GitHub Review API** — all review state tracked via labels + one persistent checklist comment.
- Checklist items: `Destructive` and `Out-of-scope` only (canonical items to prevent AI-caused unplanned or out-of-scope modifications).
- Comment title includes round number: `## Review [Round N]`.
- Each `/gtw review` invocation targeting a PR increments the round by +1 and updates the same comment.
- **Re-review logic:** compare PR diff to checklist. Remove checkboxes that are resolved (checked in previous comment). Keep unresolved ones.
- When all checkboxes are removed (all resolved): delete checklist comment → post approved comment → apply `gtw/lgtm`.
- When unresolved items remain: apply `gtw/revise` → keep checklist (round preserved) → post changes-needed comment. PR stays with `gtw/revise` until developer addresses the issues.
- When round reaches maximum (default 5): apply `gtw/stuck` → stop automated reviews.

---

## `/gtw review` Behavior

### No argument
1. Scan watch list (config.json repos) for PRs labeled `gtw/ready`.
2. Sort by `updated_at` ascending (oldest first). Pick the earliest.
3. **Claim:** atomically clear other gtw labels → set `gtw/wip`. If label operation fails, abort.
4. **Concurrency check:** re-fetch PR labels. If `gtw/ready` is still present, another runner claimed it — abort without creating comment.
5. Find existing checklist comment. If none → create Round 1 checklist. If exists → increment round, merge checklist state.
6. **If all items resolved:** delete checklist → approved comment → `gtw/lgtm`.
7. **If unresolved items remain:** `gtw/revise` → `gtw/ready` → keep checklist → changes-needed comment.
8. Return: PR title, linked issue summary, diff summary, round number.

### With PR number: `/gtw review <num>`
1. Use repo from `wip.json` (current working repo).
2. Fetch PR `<num>`.
3. Same claim → label → checklist logic. If checklist exists, increment round.

---

## Watch List Management

Repos stored in `config.json` as array of `owner/repo` strings.

| Command | Description |
|---------|-------------|
| `/gtw watch add <owner>/<repo>` | Add repo to watch list (duplicates ignored) |
| `/gtw watch rm <owner>/<repo>` | Remove repo from watch list |
| `/gtw watch list` | Show current watch list |

---

## Round Tracking & wip.json

- Track per-PR state in `wip.json` (round number, checklist comment id, repo/PR).
- Round increments on every `/gtw review` invocation that touches the PR.
- When PR transitions to `gtw/revise` or `gtw/lgtm`, review state is cleared from `wip.json` (PR released back to pool or finished).
- `gtw/stuck` also clears review state.

---

## Error Handling

- Label operation fails → abort, no comment created.
- Comment creation fails → rollback: remove `gtw/wip` (back to `gtw/ready`), return error.
- Concurrency race → detect via re-fetch, abort without creating comment.
- Watch list empty or no `gtw/ready` PRs → report no-op.

---

## State Machine

```
gtw/ready ──(claim)──> gtw/wip
                          │
            ┌─────────────┼─────────────┐
            │             │             │
       (all resolved) (has unresolved) (round > max)
            │             │             │
       gtw/lgtm      gtw/revise       gtw/stuck
```

---

## Defaults

| Parameter | Default | Configurable |
|-----------|---------|--------------|
| Max rounds | 5 | `config.json maxReviewRounds` |
| Watch list | empty | via `/gtw watch add` |

---

## Concurrency

- Multiple agents/cron runners can run concurrently.
- Selection by `updated_at` ascending prevents starvation (oldest PR picked first).
- Atomic label operation + re-fetch verification prevents double-claim.

---

## Config Command

Global key-value config stored at `~/.gtw/config.json`. Backed by a flat JSON map of `key → value` strings.

| Command | Description |
|---------|-------------|
| `/gtw config list` | List all config keys |
| `/gtw config get <key>` | Get a config value |
| `/gtw config set <key> <value>` | Set a config value |
| `/gtw config delete <key>` | Delete a config key |

### Key Naming Conventions

| Key | Value | Description |
|-----|-------|-------------|
| `model` | `provider/model-id` | AI model override (e.g. `github/gpt-5-mini`) |
| `lang:<owner/repo>` | `zh` or `en` | Language for issue/PR generation in a repo |
| `watchList` | JSON array string | Serialized watch list (managed via `/gtw watch`) |

### Examples

```
/gtw config set lang:cnlangzi/gtw zh
/gtw config set lang:octocat/repo en
/gtw config set model github/gpt-5-mini
/gtw config list
/gtw config get lang:cnlangzi/gtw
/gtw config delete model
```

Internally stored as:
```json
{
  "lang:cnlangzi/gtw": "zh",
  "model": "github/gpt-5-mini",
  "watchList": ["cnlangzi/gtw", "octocat/repo"]
}
```

## Command Reference

```
/gtw config list              — list all config keys
/gtw config get <key>          — get a config value
/gtw config set <key> <value> — set a config value
/gtw config delete <key>      — delete a config key
/gtw review           — claim earliest gtw/ready PR from watch list
/gtw review <pr>     — review specific PR in current repo
/gtw watch add <owner>/<repo>  — add repo to watch list
/gtw watch rm <owner>/<repo>   — remove repo from watch list
/gtw watch list      — show watched repos
```
