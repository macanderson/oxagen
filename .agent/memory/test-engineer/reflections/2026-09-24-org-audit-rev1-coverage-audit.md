## Self-Evaluation — Organization and Audit rev1 coverage audit (claude/gifted-brown-mv6nov) — 2026-09-24

### What I set out to do
Audit test coverage of the combined Organization and Audit lanes (136 files) and write the missing tests for each new or changed component, action, adapter and mapper.

### What I actually did (measurable deltas)
- Measured per-file coverage by running 31 existing test files one at a time with v8 coverage and merging the JSON.
- Found `src/data/live/mappers/org.test.ts` red on the branch (2 tests): the mappers gained `createdAt` and `namespace` and the expected rows did not. Fixed.
- Added 7 commits of tests: Audit (+12 cases, new `tabs.test.ts`), `organization.test.tsx` (new, 24 cases: tab dispatch, INV-15 facts reads, reads inside the frame), live `org.dataPlane` and `toDataPlane` (redaction), pages.test Model funding route, Data plane statuses, governance PR link guard, Model funding refusal sentences, role untick-revokes, safe-path routes, new `route-tabs.test.tsx`.
- organization.tsx went from 6/23 statements to exercised in every branch; model-funding page from 0/5.

### Quality of my decisions
- Best: measuring before writing. The merged coverage pointed straight at organization.tsx, which no test rendered, and at the red mapper test no lane had run.
- Weakest: naming coverage output directories by test basename. `org.test.ts` exists in two directories, so the second run overwrote the first, and the failing one wrote no coverage at all. I lost the live-adapter picture and had to rerun.

### What I could have done better
- Run every changed test file once (cheaply, no coverage) before the coverage pass, to find red tests first; I found the red mapper test by accident.
- Mutation-probe the INV-15 workspace-facts test and the double-press tests against a scratch mutant. I relied on the strictness of `toEqual` on the call list instead.
- Check the Model funding form for unreachable branches before counting them as gaps: the `ok` verdict render is dead now that Test and save only shows refused verdicts.

### What surprised me about this codebase/product
- `git commit --only <paths>` under lefthook leaves the index holding the pre-format copy (status `MM`) while HEAD and the worktree hold the formatted one.
- An exhausted balance on Model funding reads "could not reach the key service", the same sentence as an outage.

### Risks I am leaving behind (untouched on purpose, and why)
- `model-funding-form.tsx` Verdict `ok`/`okWithTools` branches are unreachable (dead code), not tested.
- The exhausted-balance sentence is pinned as a wart, not fixed: copy change needs the lane's decision.
- `workspacesTab` throws the whole tab if `requireViewer` rejects for one enterable workspace; not characterized.
- Remaining uncovered arms are `??` fallbacks and pending guards in invite-dialog, list-table and form-feedback.

### Confidence in the result: medium-high
Every new or changed test file passed alone once and typechecked through `typecheck-staged.mjs`; lint was left to CI.
