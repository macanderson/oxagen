## Self-Evaluation — contained-run (ADR-152) coverage audit — 2026-09-23

### What I set out to do
Audit test coverage for `rescue/contained-run-20260922` against origin/main in packages/tacho (runner, bundle evaluation, hook handler, collector route, wire schema) and add the missing tests.

### What I actually did (measurable deltas)
- New `packages/tacho/src/contained/runner.test.ts`: 37 tests (endpoint derivation, pre-launch refusals, lifecycle with launcher and bridge doubled by vi.mock, GitHub verify/revoke).
- `host/bundle.test.ts` +6, `collector/hook-handler.test.ts` +7, `collector/collector-units.test.ts` +6 (real loopback listener for `/contained/run`), `wire.test.ts` +9.
- 13 single-line mutants run against the sources; every one turned at least one new test red; sources restored (git status shows test files only).

### Quality of my decisions
- Best: doubling the launcher with a walker that calls prepare, measured, sealed in the real order, so launched(), registration and revoke-in-finally are observed through the runner's own callbacks instead of asserting on internals.
- Weakest: I ran mutants with `npx vitest run <file>` from the package directory rather than the exact `pnpm --filter` form. Equivalent single-file runs, but not the form the caller named.

### What I could have done better
- Read `bridge.ts` before worrying the runner ignored the SessionStart answer; the bridge rewrites the in-container session_id, so the block is enforced there. Ten minutes spent on a non-issue.
- I could not typecheck the new files (banned locally); I eyeballed `HookEnvelope.payload: unknown` only after the first green run. Check the declared types of every field a test indexes before the first run.

### What surprised me about this codebase/product
- The containment check lives in two places with two different trust rules: `evaluatePreToolUse` reads it only after bundle verification, while `operatorBlock` (SessionStart, UserPromptSubmit, PermissionRequest) reads `view.bundle.containment` without `view.verified`.

### Risks I am leaving behind (untouched on purpose, and why)
- A GitHub grant refused before launch (including an over-broad token) is never revoked; pinned as characterization, not fixed (design call).
- daemon.ts wiring (`launchedContained` binding, cancel/kill -> contained.stop), container/hook.mjs fail-closed and ask->deny rewrite: untested, outside the files I was allowed to touch.

### Confidence in the result: high for the named units (mutation-checked), medium overall (no typecheck run locally)
