## Self-Evaluation — findings nightly fails in production (#5311) — 2026-10-02

### What I set out to do
Find why no nightly findings pass had finished since 2026-09-27, fix each
cause, and make a failed pass visible beyond a warn log line.

### What I actually did (measurable deltas)
- Pulled every `cost.findings-nightly` line for 2026-09-27..10-02 from
  CloudWatch. Sep 27-28 completed 3/3. Sep 29-30 every workspace failed the
  chSelect fence. Oct 1-2 every workspace failed: three on NO_COMMON_TYPE,
  one (790d804f) on "Field value too long".
- Pinned the deployed commit for each night from the pipeline's
  `deploy api.oxagen.sh` jobs (37d5037e36 for Oct 1, 3a9b28f4ba for Oct 2).
  No pipeline deployed between Sep 29 12:00Z and Sep 30 09:37Z, which is why
  the fence fix (#4752) did not help the Sep 30 night.
- Cause 1: `PROMPTS_QUERY` aliased `toString(root_session_uuid) AS
  root_session_uuid`, and WHERE `session_uuid = root_session_uuid` read the
  alias. Evidence: the error carried only the client default settings (what
  chSelect sends), it also fired at 01:08-01:12 when the event-driven pass
  runs, and it replaced the fence error on the same read once #4752 shipped.
- Cause 2: an unbounded `sessionUuids:Array(UUID)` URL param. Evidence: the
  failing query's logged `clickhouse_settings` were exactly
  `COST_FRAME_QUERY_SETTINGS`, and the only data-sized param in that read is
  the session list. 12,692 log events since Sep 27 05:36Z show the rollup
  hitting the same wall all day.
- Fixes: alias renamed to `root`; `runSessionsFilter` splits the list
  (1,000 per param, OR'ed) with a root-subquery fallback past 10 params;
  applied to four readers; nightly sweep now calls `captureError`.
- Tests: alias guard with a negative case, two live ClickHouse tests, split
  and budget unit tests, capture tests. None run locally (machine rule).

### Quality of my decisions
- Best decision: reading the `clickhouse_settings` block the client logs
  beside each failure. It turned "some query has a big param" into "this
  reader", without touching production data.
- Weakest decision: spending time on ECS and run-list pagination to find the
  deployed commit before going straight to the deploy jobs' completion
  times, which answered it in one call.

### What I could have done better
1. I did not get the actual session count of the large run. One read-only
   SSM send-command against ClickHouse would have sized the problem and told
   me whether the split path or the fallback path will serve it.
2. I wrote the alias rule as a test over four named queries. A guard over
   every `chSelect` call site would catch the next reader too.
3. I left `tacho-turns.ts`, `tacho-events.ts` and `handlers/src/lib/run-work.ts`
   with the same unbounded list; I should have written the follow-up issue
   in the same session instead of only reporting it.

### What surprised me about this codebase/product
- ClickHouse resolves a WHERE name to a same-named SELECT alias first, so a
  harmless-looking `toString(x) AS x` changes the type of every later `x`.
- `@clickhouse/client` puts query params in the URL, so the 128 KiB form
  field limit, not `max_query_size`, is the wall for array params.

### Risks I am leaving behind (untouched on purpose, and why)
- The root-subquery fallback scans the workspace's root column. It only runs
  past 10,000 sessions, and nothing measured its cost in production.
- `readObservedModels` binds an unbounded `boundaries` list; not seen failing,
  so not changed.
- Other session-list readers outside my file list (named above).

### Confidence in the result: medium
Both causes are tied to production evidence, and both fixes follow from them.
Nothing ran: CI has not run the new tests, and only the next 02:00Z nightly
proves a pass completes.
