---
description: Rev1 app session 3: assign and revoke agent roles, revoke and mint enrollment from the agent page, toolbelt input schemas on the contract, budgets read on the agent, and send an invitation from Organization. Runs the mc-3-agents-and-people workflow.
---

# /mc-3-agents-and-people

Independent of sessions 1 and 2. It advances #2956 and #2964. The schemas lane changes a contract and rides the whole parity chain.

Read `oxagen-roadmap:docs/oxagen/mission-control/BUILD-CHUNKS.md` first. Its section for this session lists the lanes, what is already built on main, and the "Done when" boxes. The workflow sandbox has no filesystem access, so you scout inline, then hand the facts to the workflow.

`oxagen-roadmap:<path>` means `<path>` in https://github.com/macanderson/oxagen-roadmap. Check it out beside this repository (`~/Projects/oxagen-roadmap`, or `../oxagen-roadmap` in a cloud session). The build plan, the gap inventory, and the product spec moved there on 2026-09-23 (#3895).

## Before you run it

1. `git fetch origin` and note `origin/main`'s sha. Read `git log --oneline -30 origin/main -- apps/app` for anything that landed on this session's pages since the plan was written.
2. Check the preconditions:
   - Session 0 has merged.
   - `assign_agent_role`, `revoke_tacho_enrollment`, and `send_workspace_invite` still have no binding in `apps/app/capability-ui-map.json`.
   - `beltToolSchema` in `packages/oxagen/src/contracts/agent.toolbelt.get.ts` still has no schema field.
3. Decide the worktree root. On the shared machine it is `~/Projects/.worktrees/oxagen`. In a cloud session use `../oxagen-worktrees`. Pass it as `worktreeRoot`.
4. To skip a lane that has already shipped, pass its id in `skipLanes`. To see the scout's verdict without building, pass `dryRun: true` first.

## Run it

```
Workflow({
  name: "mc-3-agents-and-people",
  args: { worktreeRoot: "<root>", skipLanes: [], dryRun: false, mergeMain: true }
})
```

Pass `args` as a real JSON object, not a string.

## When it returns

- Report the PR URL, its CI state, each lane's summary, the deviations from the spec, and the residue issue the reviewer filed.
- Subscribe to the PR's activity and drive it to green per the rules in CLAUDE.md. Do not merge it; the maintainer merges.
- The enrollment lane leaves agent-scope budgets as a residue question (an ADR on `billing.budgets` scopes). Put that question to the maintainer in one line.
- If a lane returned nothing, say which one and what the integrator did about it.
- Save the workflow's returned JSON under `verifications/<session-id>/mc-3-agents-and-people.json`.
