## Self-Evaluation — three apps/app Run test failures from #4018 on main — 2026-09-24

### What I set out to do
Root-cause and fix the three apps/app test failures that #4018 left on main (and that PR #4047 inherited): the runs mapper expectation, the INV-11 public-ids violation on RunSubagent.id, and four Run header tests that never found `run-checkout`.

### What I actually did (measurable deltas)
- mappers/runs.test.ts and live/runs.test.ts (runs.list): expectations now carry effort/thinking/permissionMode/reportedTokens as null (the second file was a fourth failure not in the brief, same cause).
- RunSubagent.id renamed to `ref` in the view contract; live adapter maps wire `id` to `ref` (strict schema would otherwise refuse any work read with a subagent); header chip and fixtures follow; adapter test fixture gained a subagent plus an exact assertion.
- renderRun renders inside an awaited act. run.test.tsx 4 failed/104 passed became 108/108 with no act warning.
- Fail-before proven for public-ids by restoring only the old contract; commit 846998f25.

### Quality of my decisions
- Best: reading React 19.3's `act` source (flushActQueue + `actQueue = null`) instead of guessing, and using the one passing `findByTestId("run-checkout")` test (it awaited userEvent.hover first) as the control. That turned "Suspense never resolves" into a narrated causal chain.
- Weakest: my first `act` form (`let container!` then `async () =>` without await) needed two lint rounds; I should have grepped the house pattern (`act(() => Promise.resolve(...))`) before writing it.

### What I could have done better
1. Run every test file the originating PR touched (#4018's `git show --stat`), not just the three named; live/runs.test.ts failed for the same reason and I only found it because I touched it for the rename.
2. Checked the lint rules for test files (require-await) before the first edit rather than after.
3. Could not confirm from CI whether #4018's own run was green (no gh here); I inferred the mechanism is deterministic, which I believe but did not observe on its branch.

### What surprised me about this codebase/product
- A synchronous RTL `render` of a tree that `use()`s a promise leaves Suspense fallbacks up forever under React 19, and a later `findBy*` does not rescue it; any awaited act (even an unrelated userEvent) does.
- The live adapter test's kernelRead mock does not validate against the capability contract, so a required wire field (`subagents`) can be absent from the fixture and nobody notices.

### Risks I am leaving behind (untouched on purpose, and why)
- Other apps/app tests that render server components using `use(promise)` with a plain `render` would hit the same hang; I did not sweep them (out of scope, and none are failing now).
- The CI outcome for PR #4047 after this commit is not observed by me; the caller's watcher owns it.

### Confidence in the result: high
Each file passes alone after the pre-commit format; public-ids shown failing on the old contract and passing on the new; the act mechanism read from react.development.js and matched by the warning and the control test.
