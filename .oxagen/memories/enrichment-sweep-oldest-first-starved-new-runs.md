---
name: enrichment-sweep-oldest-first-starved-new-runs
type: bug
domain: evidence
severity: P1
issue: 4113
date: 2026-09-24
---

**Symptom:** No run sealed on 2026-09-24 had a summary or a model-written name. `summary_observed_at` was null on every one, so `run.enrich` never ran for them.

**Root cause:** The sweep in `packages/inngest-functions/src/functions/run.enrich.ts` took the 500 oldest due runs per store. The job drains about ten runs an hour under `concurrency: { limit: 1, key: orgId }`, and 1,153 runs were due in one org, so every run sealed after 2026-09-21 ranked past 500 and was never queued. The provider's queue also held about 500 jobs, so a queued run waited hours. Separately, `runNarrativeTurn` ignored the stream's error part, so every model failure was logged as `empty_account`.

**Fix:** Newest ended runs first, three per org per store per pass, a 30-minute window in the event id with a stale and superseded check in the job, the 30-minute hold extended to sealed runs that keep changing, and the turn's error part thrown and classified by status.

**Guard:** `run.enrich.test.ts` asserts the compiled window-function order and the per-org limit, plus the stale, superseded and person-request admission cases. `run-enrichment.test.ts` asserts a 403 inside the turn becomes `model_refused` and is not retried.

**Watch-outs:** A sweep feeding a serialized queue must send only what the queue drains between sweeps, or new work lands behind the backlog. A sealed Claude Code session keeps receiving events after its seal (`sealSource: agent_stop`), so any rule that treats "sealed and changed" as urgent will re-read the same active sessions every sweep. Inngest's event-id dedup lasts 24 hours, so an event dropped by the job is not resent until its id changes.
