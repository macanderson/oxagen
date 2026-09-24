---
name: run-page-reads-a-failed-read-as-not-captured
type: observation
domain: runs
severity: P2
linear: "GitHub #4106"
date: 2026-09-24
---

**Symptom:** `get_run_work` failed every call for days while the Run page printed "repo not captured" and "path not captured". Nobody saw an error.
**Root cause:** `apps/app/src/data/live/runs.ts` turns a failed `runs.work` read into empty work, and the header renders empty work as missing evidence. `get_run` and `get_run_outputs` also catch their ClickHouse reads and log a warning.
**Fix:** none in this change. The failure only showed up in `/oxagen-app/api` CloudWatch as `"msg":"unhandled error"` with the ClickHouse code.
**Guard:** none yet.
**Watch-outs:** when a Run page field reads "not captured" on every run, check the API log for the read behind it before looking at ingest. `aws logs filter-log-events --log-group-name /oxagen-app/api --filter-pattern '"_ClickHouseError"'` tallies every ClickHouse failure. A read that filters `chain_verified = true` hides frames the same way (ADR-171).
