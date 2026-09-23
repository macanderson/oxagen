## Self-Evaluation — coverage audit for #3733 (wrapped frames carry their sealed event) — 2026-09-23
### What I set out to do
Find behaviour in unflattenEvent, checkWrappedFrame, the VERIFIER_SCRIPT and tachoExportFrame that no test exercised, add tight tests to the existing files, and prove each new test can fail.
### What I actually did (measurable deltas)
- 21 tests added across 4 files (columns +6, run-export +7, run-export-bundle +7 parity cases, run-record +1), 351 lines, additions only.
- 14 source mutations run and restored. 13 were caught. One survivor (script `f[k] === undefined || ...` guard) is equivalent because `canonical(undefined)` never equals a string.
- Before: only `seq` was converted from ClickHouse JSON text in any test. After: each of turn_seq, harness_event_sequence, claude_pid, claude_ppid and spawn_depth fails its own mutation.
### Quality of my decisions
- Best: one `it.each` table that runs every tampering through both verifiers and asserts the same reason string. It pins parity and each script branch in one place, and 4 of 5 script mutations fail it.
- Weakest: my first INTEGER_COLUMNS mutation used `sed 0,/pat/` and hit the first occurrence, in ENVELOPE_COLUMNS, so for a minute I read a wrong result. Anchor mutations to the block you mean to break.
### What I could have done better
- The sort test passed with `.sort()` removed. The two members I picked were already in alphabetical order. For any "sorted" claim, pick inputs whose natural order differs from the sorted order.
- asClickHouseRead (test-helpers) leaves the Nullable(UInt64/UInt32) columns as numbers, although ClickHouse returns UInt64 as JSON text. I tested around it rather than fixing the helper. The helper's claim to model a real read is only partly true.
### What surprised me about this codebase/product
MAX_CANDIDATES = 256 and there are exactly 8 possible ambiguities (5 groups + content + spawn_depth + ts), so `2 ** open.length > MAX_CANDIDATES` can never be true. The cap is dead code today.
### Risks I am leaving behind (untouched on purpose, and why)
- `OFFLINE_COMMANDS` is keyed on classifyCommand, which returns "prompt" when a root option (`-m x`) precedes `verify`. Reported, not fixed: that is a source change, which is out of scope.
- The `hashEvent` throw → null branch in checkWrappedFrame, and the parse-changes-hash branch in unflattenEvent, are unreachable from JSON input. Left unasserted.
### Confidence in the result: high. Every added test was mutation-checked except the equivalent survivor, and each file passes in isolation.
