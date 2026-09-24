## Self-Evaluation — coverage audit of the Run and Mandate rebuild (claude/compassionate-maxwell-2osq69) — 2026-09-24

### What I set out to do
Audit every new or changed component, action, adapter and mapper in the branch's 83-file diff for co-located tests over its states and branches, write what is missing, run each new file once, commit and push.

### What I actually did (measurable deltas)
- Mapped each changed source file to the tests that import it; ranked gaps by money and trust risk.
- Added 4 test files, 39 tests: run/cost.test.tsx (13), run/stats.test.tsx (12), mandate/authority-bar.test.tsx (8), run/player.test.tsx (6). Each ran alone and passed; the pre-commit typecheck passed on each.
- Push blocked: pre-push check:contracts (check-system-db-justifications) fails because origin/main moved after the branch's last integration and shrank the baseline. A trial merge of main hit 4 conflicts plus pre-commit failures that come from main's own files. I aborted it and saved the resolutions to the scratchpad.

### Quality of my decisions
- Best: testing the leaf components over hand-built inputs where the page test only ever passes the builder's one rollup. Every gap I found was a branch the page cannot reach (reportedCost provisional, over-limit, no-cost rollup, mixed currencies).
- Weakest: running `git fetch origin main` early without noting it would move the ref the pre-push hook compares against, then spending time on a merge I could not commit without bypassing hooks.

### What I could have done better
- Check the pre-push hook against the fresh origin/main before writing any test, so the push blocker surfaces in the first minute rather than after three commits.
- Grep origin/main for tests of the same component (main's own cost.test.tsx) before creating a file with that name; the add/add conflict was predictable.
- Mutation-check at least the over-limit and provisional-cost assertions by reverting the branch once.

### What surprised me about this codebase/product
- Main added a cost.test.tsx for the old Cost panel while this branch rewrote it, so the same path means two different components on each side.
- StatRow falls back from the rollup's null cost to the run row's cost, and the player captions a mixed-basis sum with the first frame's basis.

### Risks I am leaving behind (untouched on purpose, and why)
- Mixed-basis caption in player.tsx costBy: pinned by a characterization test, not fixed; that is a product call about what basis a sum carries.
- New exports with no production importer (player.tsx frameFamily/parkedIndex/turnsOf/FRAME_FAMILIES, issues.tsx issueUrl, transcript.tsx chipCounts, stats.tsx promptCount and others) may fail `knip --production --strict` in CI; the baseline is empty. Not verified locally.
- main's packages/handlers/integration/scim-deprovision.test.ts is outside its tsconfig, so any merge that stages it fails the staged ESLint hook.

### Confidence in the result: medium
The four files pass in isolation and typecheck, but the push is blocked, so CI has not seen them.
