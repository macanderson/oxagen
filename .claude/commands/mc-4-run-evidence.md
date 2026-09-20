---
description: Rev1 app session 4: a Proof tab over get_run_proof, run export status and download through a new capability, gateway outcomes on the transcript, and the unmetered-runs caveat and cache tile on Spend. Runs the mc-4-run-evidence workflow.
---

# /mc-4-run-evidence

Run after session 1 merged: it extends the Run tabs and the Fleet caveat that session adds. It advances #2952, #3304, #3299, and the one buildable slice of #2955.

Read `docs/mission-control/BUILD-CHUNKS.md` first. Its section for this session lists the lanes, what is already built on main, and the "Done when" boxes. The workflow sandbox has no filesystem access, so you scout inline, then hand the facts to the workflow.

## Before you run it

1. `git fetch origin` and note `origin/main`'s sha. Read `git log --oneline -30 origin/main -- apps/app` for anything that landed on this session's pages since the plan was written.
2. Check the preconditions:
   - Session 1 has merged (the Run tab list and the Fleet caveat are on main).
   - `get_run_proof` still has no binding; no contract named `get_run_export` exists; `apps/app/src/features/spend` has no cache tile.
3. Decide the worktree root. On the shared machine it is `~/Projects/.worktrees/oxagen`. In a cloud session use `../oxagen-worktrees`. Pass it as `worktreeRoot`.
4. To skip a lane that has already shipped, pass its id in `skipLanes`. To see the scout's verdict without building, pass `dryRun: true` first.

## Run it

```
Workflow({
  name: "mc-4-run-evidence",
  args: { worktreeRoot: "<root>", skipLanes: [], dryRun: false, mergeMain: true }
})
```

Pass `args` as a real JSON object, not a string.

## When it returns

- Report the PR URL, its CI state, each lane's summary, the deviations from the spec, and the residue issue the reviewer filed.
- Subscribe to the PR's activity and drive it to green per the rules in CLAUDE.md. Do not merge it; the maintainer merges.
- The export lane adds a capability. Confirm in the report that the API route, MCP tool, CLI line, capability doc, and binding all landed, or name what is missing.
- If a lane returned nothing, say which one and what the integrator did about it.
- Save the workflow's returned JSON under `verifications/<session-id>/mc-4-run-evidence.json`.
