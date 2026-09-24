## Self-Evaluation — PR #3911 billing test:coverage failure — 2026-09-24
### What I set out to do
Find why @oxagen/billing#test:coverage failed on 1419e2e and fix it on the branch.
### What I actually did (measurable deltas)
- Reproduced the 1419e2e failure: two action-metering settlement-order tests (fixed by c7f0a2f8c from another session before I started).
- Ran all 75 billing test files one at a time with coverage and merged the reports: functions 86.26 vs floor 86. statement-render.ts ran 54/100 functions.
- Added 17 tests to statement-render.test.ts: 100/100 functions; package 92.0 fn / 88.3 lines / 91.5 branches (pg suites excluded). Pushed 19d040fd3.
- Ran statements.pg.test.ts against a scratch Postgres 16 (psql-applied migrations): 3/3 pass.
### Quality of my decisions
- Best: merging per-file coverage JSON to get a package reading without a package-wide run.
- Weakest: starting Postgres under a scratchpad path whose parent perms get reset; it died mid-run.
### What I could have done better
- Check the branch head before investigating; the test fix had already landed.
- Put the scratch DB somewhere stable from the start, or use port-only docker, instead of chmod on harness dirs.
### What surprised me
v8 function counts for an unloaded file differ from a loaded one (statement-reads 16 vs 38), so merged totals are approximate.
### Risks I am leaving behind
CI's actual billing log was never read; the threshold diagnosis is from a local merged reading.
### Confidence: medium-high — failing tests reproduced; coverage margin now ~6 points on functions.
