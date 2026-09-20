## Self-evaluation: approval-rule invalidation, 2026-09-19

### What I set out to do
Close the ordering gaps in #3133 and its absorbed measure-change finding #3142.

### What I actually did
Added transactional invalidation to classification, fresh tool publication, and
version publication. Preserved the recorded author and attached a disabled
reason and event. Removed stale process caches and rechecked policy before
committing auto-approval. Added UI copy, ADR-119, schemas, and regression tests.
The isolated helper file passed 14 tests. Postgres and UI execution remain in CI.

### Quality of my decisions
Checking both publish paths under one workspace lock avoids races between rule
authoring and tool changes. The first draft held a transaction while a callback
opened a second connection. Independent review caught the resulting pool
starvation risk. The callback and authority reads now share the transaction.

### What I could have done better
- Trace callback connection ownership before moving a writer into a transaction.
- Inspect both initial evaluation and deferred commit when removing stale reads.

### What surprised me
The auto-approval path accepted a rule set from an earlier transaction, then
returned a deferred commit without rechecking its authority.

### Risks left behind
CI must validate migrations, Postgres concurrency, UI, and full package coverage.
The approval-resume and external-tool paths are separate concurrent backlog
changes and need integration review when their branches meet.

### Confidence
Medium pending CI. The isolated helper tests and independent audit support the
local implementation, but do not substitute for Postgres and app execution.
