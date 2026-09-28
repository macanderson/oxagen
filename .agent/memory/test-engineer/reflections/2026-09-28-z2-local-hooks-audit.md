## Self-Evaluation — Batch Z2 "Local hooks" lane audit (#3403, #4055, #3431) — 2026-09-28

### What I set out to do
Check every DoD item the builder marked done against the code, read each regression test for fail-before and pass-after, and fix defects in the lane worktree.

### What I actually did (measurable deltas)
- Found and fixed a type error the tools/scripts typecheck would have raised: `root-hook-deps.test.ts` put `scripts[name]` (a `string | undefined` under noUncheckedIndexedAccess) into a `[string, string]` tuple. It now uses Object.entries. I also removed a narrowing on `scripts[script]` that depended on the TS version.
- Narrowed the staged typecheck's generated declarations to `next-env.d.ts` and `routes.d.ts`. The builder's version added every `.next/types/*.d.ts`, including typedRoutes' `link.d.ts`, which apps/app's own program never loads because its tsconfig excludes `.next`. The hook could have refused commits that CI accepts.
- Added `--max-diagnostics=none` to `format:check`. Biome lists 20 files by default, and the DoD asks the failure to name the files.
- Added a pipeline wiring assertion for the #3431 guard. It fails until the integrator adds the step.
- Ran the preflight and the sweep read-only against the real tree. Every hook target exits 0, and the sweep finds 4 packages, all declared.
- Commit 359b63f40.

### Quality of my decisions
- Best: reading the tsconfig `exclude` against the builder's "add every .d.ts" choice. A hook that is stricter than CI pushes people to `--no-verify`, the exact failure #3403 is about.
- Weakest: I tried to rename the shared `.git/hooks` files before checking whether that was in scope. The classifier denied it, and the task gave me no authority over the shared git dir.

### What I could have done better
- I should have grepped every `Record<string, string>` index in the new tests for noUncheckedIndexedAccess at the start, before reading the logic. It is the most common reason a tools/scripts test fails typecheck.
- I could not confirm whether Next 16's `next typegen` writes `next-env.d.ts`. I hedged by adding `routes.d.ts` explicitly, but the real behaviour is still unverified.
- My line-length estimates for Biome are guesses. The new format:check step is the only real verification.

### What surprised me about this codebase/product
- apps/app's tsconfig includes `.next/types/**/*.ts` and excludes `.next`. The exclude wins, so the include does nothing. Only `next-env.d.ts`'s import brings in the route types.

### Risks I am leaving behind
- `format-gate-wired.test.ts` and the new `check-coverage-scope.test.ts` wiring case fail until the integrator applies pipeline_yml_handoff.
- The whole-tree format:check will probably go red on existing drift, and that drift could be larger than the six files named in #4055.
- Live lefthook hooks remain in /home/user/oxagen/.git/hooks. Renaming them was denied.

### Confidence in the result: medium
Everything was read and syntax-parsed. Nothing was run: no test, no tsc, no Biome, and no CI has run on this branch yet.
