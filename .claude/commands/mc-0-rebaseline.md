---
description: Rev1 app session 0: re-baseline the gap record at head, record the 2026-09-14 cuts in an ADR, make the parity gate check its proofs, and bring PRs #3479 and #3459 to green. Runs the mc-0-rebaseline workflow.
---

# /mc-0-rebaseline

Run this session first. It corrects the record every later session reads and closes two integrity holes in the parity gate.

Read `oxagen-roadmap:docs/oxagen/mission-control/BUILD-CHUNKS.md` first. Its section for this session lists the lanes, what is already built on main, and the "Done when" boxes. The workflow sandbox has no filesystem access, so you scout inline, then hand the facts to the workflow.

`oxagen-roadmap:<path>` means `<path>` in https://github.com/macanderson/oxagen-roadmap. Check it out beside this repository (`~/Projects/oxagen-roadmap`, or `../oxagen-roadmap` in a cloud session). The build plan, the gap inventory, and the product spec moved there on 2026-09-23 (#3895).

## Before you run it

1. `git fetch origin` and note `origin/main`'s sha. Read `git log --oneline -30 origin/main -- apps/app` for anything that landed on this session's pages since the plan was written.
2. Check the preconditions:
   - `docs/audits/2026-09-19-mission-control-gap-inventory-review.md` exists on main. If it does not, this branch has not merged; run from it.
   - PRs #3479 and #3459: open, merged, or closed. Tell the workflow through `skipLanes: ["prs"]` if both have merged.
3. Decide the worktree root. On the shared machine it is `~/Projects/.worktrees/oxagen`. In a cloud session use `../oxagen-worktrees`. Pass it as `worktreeRoot`.
4. To skip a lane that has already shipped, pass its id in `skipLanes`. To see the scout's verdict without building, pass `dryRun: true` first.

## Run it

```
Workflow({
  name: "mc-0-rebaseline",
  args: { worktreeRoot: "<root>", skipLanes: [], dryRun: false, mergeMain: true }
})
```

Pass `args` as a real JSON object, not a string.

## When it returns

- Report the PR URL, its CI state, each lane's summary, the deviations from the spec, and the residue issue the reviewer filed.
- Subscribe to the PR's activity and drive it to green per the rules in CLAUDE.md. Do not merge it; the maintainer merges.
- Tell the maintainer whether #3479 and #3459 are mergeable now, with the blockers named.
- If a lane returned nothing, say which one and what the integrator did about it.
- Save the workflow's returned JSON under `verifications/<session-id>/mc-0-rebaseline.json`.
