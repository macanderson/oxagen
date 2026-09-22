## Self-Evaluation — DB Migrate wrong path and kill-switch lint — 2026-09-22
### What I set out to do
Address the failed workflow on fccdca099. That commit is the merge of #3708.
### What I actually did (measurable deltas)
DB Migrate (manual) run 35674827817 failed its reachability guard, which is what the workflow is written to do. The migration gate's summary, the drift script, the schema label, and CLAUDE.md all named that workflow as the production Postgres apply path. Those lines now name `infra/tools/run-db-migrations.sh`. CI run 35672984022 also failed `checks` because `pauseAgent` used `as string`. That assertion is gone. The else branch uses the narrowed key.
Shell tests: `check-postgres-drift.test.sh` 31 passed, `migration-gate.test.sh` 17 passed. `actions.test.ts` 100 passed. ESLint on `actions.ts` exited 0. The test-engineer audit said the existing pause cases already pin the narrowed key.
### Quality of my decisions
- Best decision I made and why: I treated the guard failure as a wrong instruction, not as a workflow to make succeed from outside the VPC.
- Weakest decision I made and why: I left ClickHouse behind. The same CI run reported stores code 1, and I did not apply that migration.
### What I could have done better
- Read the gate summary and `db-migrate.yml`'s header in one pass before deciding the failure was operational and out of scope. The contradiction was already in the tree.
- The first `pnpm --filter` attempt spent a cycle on `lefthook install` because `verify-deps-before-run` is on. I should have skipped that check immediately.
### What surprised me about this codebase/product
README.md already said the hosted workflow cannot reach Aurora. CLAUDE.md and the red job's own summary still sent the operator there, and someone dispatched it.
### Risks I am leaving behind (untouched on purpose, and why)
Production schema is still not ready for this commit. Postgres was unknown (code 2) and ClickHouse or Neo4j was behind (code 1) on run 35672984022. Applying either store is a production mutation and stays a manual step. #3712 is the host-lookup fix and was already on main.
### Confidence in the result: high + evidence
The lint error is the exact diagnostic from the checks log, and ESLint on that file is clean. The shell tests lock the new apply sentence. The next production dispatch of DB Migrate will still fail its guard. That is the intended remaining behavior.
