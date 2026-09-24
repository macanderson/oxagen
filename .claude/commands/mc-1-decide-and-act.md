---
description: Rev1 app session 1 (P0): approve and deny with a reason on Fleet and Run, the four-hop chain and eligibility line, the enforcement tier and verdict columns, run controls from Fleet, and steer with a delivery mode. Runs the mc-1-decide-and-act workflow.
---

# /mc-1-decide-and-act

The P0 session. It owns #2950, #2953, #3285, and the app half of #2970 and #3286.

Read `oxagen-roadmap:docs/oxagen/mission-control/BUILD-CHUNKS.md` first. Its section for this session lists the lanes, what is already built on main, and the "Done when" boxes. The workflow sandbox has no filesystem access, so you scout inline, then hand the facts to the workflow.

`oxagen-roadmap:<path>` means `<path>` in https://github.com/macanderson/oxagen-roadmap. Check it out beside this repository (`~/Projects/oxagen-roadmap`, or `../oxagen-roadmap` in a cloud session). The build plan, the gap inventory, and the product spec moved there on 2026-09-23 (#3895).

## Before you run it

1. `git fetch origin` and note `origin/main`'s sha. Read `git log --oneline -30 origin/main -- apps/app` for anything that landed on this session's pages since the plan was written.
2. Check the preconditions:
   - Session 0 has merged (the corrected `GAP-INVENTORY.md` is on main). If not, run `/mc-0-rebaseline` first or accept that the lanes read the review document instead.
   - Read issue #2950 and confirm decision 1 (ratify `resolve_approval` as the billed governed action) is still open; the approve lane records it as an ADR.
   - `grep -rn resolve_approval apps/app/src --include=*.tsx --include=*.ts | grep -v test` is empty. If not, someone built it; pass `skipLanes: ["approve"]`.
3. Decide the worktree root. On the shared machine it is `~/Projects/.worktrees/oxagen`. In a cloud session use `../oxagen-worktrees`. Pass it as `worktreeRoot`.
4. To skip a lane that has already shipped, pass its id in `skipLanes`. To see the scout's verdict without building, pass `dryRun: true` first.

## Run it

```
Workflow({
  name: "mc-1-decide-and-act",
  args: { worktreeRoot: "<root>", skipLanes: [], dryRun: false, mergeMain: true }
})
```

Pass `args` as a real JSON object, not a string.

## When it returns

- Report the PR URL, its CI state, each lane's summary, the deviations from the spec, and the residue issue the reviewer filed.
- Subscribe to the PR's activity and drive it to green per the rules in CLAUDE.md. Do not merge it; the maintainer merges.
- Name the ADR the approve lane wrote and ask the maintainer to confirm decision 1 on #2950.
- If a lane returned nothing, say which one and what the integrator did about it.
- Save the workflow's returned JSON under `verifications/<session-id>/mc-1-decide-and-act.json`.
