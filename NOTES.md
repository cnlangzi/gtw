# gtw — Notes & Changelog

## 2026-03-31 — Documentation Sync

**Issue:** #19 — fix: sync gtw docs with main behavior

Documentation (README.md and DESIGN.md) was out of sync with the actual implementation on `main` as of 2026-03-31. Multiple user-visible commands had different semantics in docs vs code.

### What was fixed

**README.md:**
- `/gtw push`: Removed incorrect claim that it "executes directly, no confirm needed". Now correctly documents the two-step `pendingCommit` → `/gtw confirm` flow in both prose and example workflows.
- `/gtw fix`: Replaced short description with full subagent-driven flow (claim issue → gtw/wip label → fetch → create branch → inject directive → subagent fixes → pendingCommit → `/gtw confirm` → unclaim/remove label). Example workflow updated.
- `/gtw pr`: Now clearly documents the `pendingPr` draft → `/gtw confirm` two-step flow and the branch push vs PR creation separation.
- `/gtw review`: Documents the two-call verdict flow: first call claims PR (`eyes` comment + checklist), second call with `approved|changes` finalizes (posts verdict, submits GitHub review, releases claim). Added review workflow example.
- Standard workflow examples updated to show correct order: `/gtw fix` → push → confirm → pr → confirm.

**DESIGN.md:**
- Rewrote `/gtw fix` section to reflect the current main implementation: full subagent automation, gtw/wip label lifecycle, directive injection, state transitions (unclaimed → claimed → wip branch → fix-spawned → subagent running → pendingCommit → pushed → unclaimed).
- Updated file structure list to accurately describe FixCommand, PrCommand, and PushCommand roles.
- Added notes on why the two-step confirm model exists (safety, human reviewability, retry on failure).
- Documented where pendingCommit and pendingPr are stored (`~/.gtw/wip.json`).

**Added:**
- `NOTES.md` — this changelog entry documenting the sync and date (2026-03-31).

### Reference

Main merge that introduced subagent-driven `/gtw fix`: `fix/subagent-driven-fix` branch merged to main (2026-03-31).
