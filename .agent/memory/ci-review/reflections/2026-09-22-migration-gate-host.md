## Self-Evaluation — migration gate Postgres host — 2026-09-22
### What I set out to do
Address the failed CI run on 3493f803 (migration-gate) and the open Bugbot threads on #3699.
### What I actually did (measurable deltas)
Bugbot's three findings were already fixed on main by #3703. The gate still failed because `run-db-migrations.sh` calls `rds:DescribeDBClusters` and the deploy role has no `rds:Describe*`. The script now reads the writer host from `/oxagen/production/DATABASE_URL` and keeps describe as a fallback. 81 assertions in `render-remote-migration.test.sh` passed.
### Quality of my decisions
- Best decision I made and why: I branched from current `origin/main` instead of the failing merge commit, so the fix does not drop #3703's per-commit tarball.
- Weakest decision I made and why: I did not dispatch Store Migrate for `0029_durable_token_usage.sql`. ClickHouse is still one file behind, so deploy-node stays blocked after this fix until a person applies that file.
### What I could have done better
- Confirm the production parameter's host is the writer, not a reader, before relying on it. The coordinator tunnel uses the same parameter, which is the evidence I had, and I did not read the parameter value.
- The test-engineer subagent was unavailable. I judged the assertions myself instead of getting that audit.
### What surprised me about this codebase/product
`pipeline.yml` already recorded that the deploy role cannot describe RDS, and the new gate called that API anyway.
### Risks I am leaving behind (untouched on purpose, and why)
Production ClickHouse is missing `0029_durable_token_usage.sql`. Applying it is a production schema change and stays on the manual Store Migrate workflow.
### Confidence in the result: medium + evidence
The shell test covers host parsing, preference order, password non-disclosure, and AWS `None`. It does not call AWS. The next migration-gate run is the proof that the parameter read works.
