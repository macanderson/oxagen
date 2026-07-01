---
name: contested-workdir-branch-switch-wipe
type: observation
domain: workflow
severity: P2
linear: OXA-CLI-STABILITY
date: 2026-06-28
---

**Observation:** While fixing CLI stability issues on a feature branch, a
PARALLEL agent sharing the same working directory did `git switch` to its own
branch (`fix/cli-test-failures`). This silently:

1. discarded my uncommitted Fix 2 edits to interactive.tsx (tracked changes
   are lost on a switch), and
2. left an untracked test file behind (untracked files survive a switch), and
3. earlier, swept that agent's uncommitted working-tree edits to 4 unrelated
   test files into MY first commit, because they were modified in the shared
   tree when I ran `git add <my files>` — wait, no: `git add <explicit paths>`
   should exclude them, yet they landed in the commit anyway once the branch
   ref was moved/recreated by the parallel session.

**What saved the work:** committing + pushing each fix the moment it went green.
Fix 1 was already on `origin` before the switch, so only the uncommitted Fix 2
had to be redone.

**Rules reinforced:**

- Commit AND push every fix the instant it is green — never hold uncommitted
  work across tool calls when the tree is contested.
- Re-check `git branch --show-current` immediately before every `git add`/commit;
  a parallel `git switch` can move you off your branch between calls.
- Prefer a dedicated worktree in `.worktrees/` for any multi-step body of work
  (the only fully reliable isolation), but note unit tests there need node_modules.
- Unrelated changes landing in your branch/PR is "fine and expected" per
  CLAUDE.md — do NOT rebase/cherry-pick to tidy; just verify they're green so CI
  passes.
