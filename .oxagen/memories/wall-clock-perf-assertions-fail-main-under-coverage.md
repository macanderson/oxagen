---
name: wall-clock-perf-assertions-fail-main-under-coverage
type: bug
domain: tacho
severity: P1
linear: none (GitHub #4015)
date: 2026-09-24
---

**Symptom:** main's `test` job failed in `packages/tacho/src/host/wal-index.test.ts` with `expected 435.04 to be less than 291.99`, and every deploy job skipped behind it (run 35943638109).
**Root cause:** the #3694 witness asserted a ratio of `performance.now()` timings. Main's `test` job runs it under coverage beside 41 other packages, so wall time is noise. No tacho source had changed since the previous passing run.
**Fix:** count bytes read from the `.bodies.jsonl` file through a `vi.mock` wrap of `node:fs` `readSync` and `node:fs/promises` `FileHandle.read`, and assert the ratio on bytes (PR #4016).
**Guard:** the same test, now deterministic. Forcing a rescan per batch in `Wal.bodiesOfSession` fails it.
**Watch-outs:** any test that asserts on wall time can hold every production deploy. Measure work done (bytes, calls, rows), not time.
