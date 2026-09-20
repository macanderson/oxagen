---
description: Rev1 app session 5: Steering tabs as path segments, the Memory and Policy tabs, and a page for one published record. The UI-only half of Phase 2; Preview, skill sync, and ontology notes wait on Phases 1 and 2. Runs the mc-5-steering-hub workflow.
---

# /mc-5-steering-hub

Run only after PR #3479 has merged (Skills as a tab of Steering, the creation wizards, `propose_skill`) and after session 2 (the auto-approvals editor). ADR-091 §6 freezes new governance ceremony: this session adds tabs and reads, never a new proposal state, check, or review step.

Read `docs/mission-control/BUILD-CHUNKS.md` first. Its section for this session lists the lanes, what is already built on main, and the "Done when" boxes. The workflow sandbox has no filesystem access, so you scout inline, then hand the facts to the workflow.

## Before you run it

1. `git fetch origin` and note `origin/main`'s sha. Read `git log --oneline -30 origin/main -- apps/app` for anything that landed on this session's pages since the plan was written.
2. Check the preconditions:
   - PR #3479 has merged. If it has not, stop and say so; do not build against its branch.
   - Session 2 has merged: `TOOLS_TABS` in `apps/app/src/features/tools/view.ts` includes `auto-approvals`. The Policy tab links there.
   - Phase 1 (#3296) state: if `assembleSteering` now exists in source, tell the segments lane so Preview renders the real manifest instead of the NotBacked line.
   - `apps/app/src/features/steering/view.ts` still routes tabs by `?tab=`.
3. Decide the worktree root. On the shared machine it is `~/Projects/.worktrees/oxagen`. In a cloud session use `../oxagen-worktrees`. Pass it as `worktreeRoot`.
4. To skip a lane that has already shipped, pass its id in `skipLanes`. To see the scout's verdict without building, pass `dryRun: true` first.

## Run it

```
Workflow({
  name: "mc-5-steering-hub",
  args: { worktreeRoot: "<root>", skipLanes: [], dryRun: false, mergeMain: true }
})
```

Pass `args` as a real JSON object, not a string.

## When it returns

- Report the PR URL, its CI state, each lane's summary, the deviations from the spec, and the residue issue the reviewer filed.
- Subscribe to the PR's activity and drive it to green per the rules in CLAUDE.md. Do not merge it; the maintainer merges.
- List which of the seven tabs are real after this PR and which still render the NotBacked line, with the phase each waits on.
- If a lane returned nothing, say which one and what the integrator did about it.
- Save the workflow's returned JSON under `verifications/<session-id>/mc-5-steering-hub.json`.
