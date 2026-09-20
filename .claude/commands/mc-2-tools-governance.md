---
description: Rev1 app session 2: auto-approval rules, grant a mandate, a connections table with add connection, and servers in the registry on the Tools page, all over handlers that already ship. Runs the mc-2-tools-governance workflow.
---

# /mc-2-tools-governance

Independent of session 1. It owns the app half of #2970 and the remainder of #2957.

Read `docs/mission-control/BUILD-CHUNKS.md` first. Its section for this session lists the lanes, what is already built on main, and the "Done when" boxes. The workflow sandbox has no filesystem access, so you scout inline, then hand the facts to the workflow.

## Before you run it

1. `git fetch origin` and note `origin/main`'s sha. Read `git log --oneline -30 origin/main -- apps/app` for anything that landed on this session's pages since the plan was written.
2. Check the preconditions:
   - Session 0 has merged, so the five approval-rule and six mandate capability docs exist under `docs/capabilities/`. If not, the rules and grant lanes must write the ones they bind.
   - `TOOLS_TABS` in `apps/app/src/features/tools/view.ts` still lacks `auto-approvals`; `grant_mandate` still has no binding in `apps/app/capability-ui-map.json`.
3. Decide the worktree root. On the shared machine it is `~/Projects/.worktrees/oxagen`. In a cloud session use `../oxagen-worktrees`. Pass it as `worktreeRoot`.
4. To skip a lane that has already shipped, pass its id in `skipLanes`. To see the scout's verdict without building, pass `dryRun: true` first.

## Run it

```
Workflow({
  name: "mc-2-tools-governance",
  args: { worktreeRoot: "<root>", skipLanes: [], dryRun: false, mergeMain: true }
})
```

Pass `args` as a real JSON object, not a string.

## When it returns

- Report the PR URL, its CI state, each lane's summary, the deviations from the spec, and the residue issue the reviewer filed.
- Subscribe to the PR's activity and drive it to green per the rules in CLAUDE.md. Do not merge it; the maintainer merges.

- If a lane returned nothing, say which one and what the integrator did about it.
- Save the workflow's returned JSON under `verifications/<session-id>/mc-2-tools-governance.json`.
