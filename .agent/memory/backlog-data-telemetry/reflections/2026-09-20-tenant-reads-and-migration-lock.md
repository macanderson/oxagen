## Self-evaluation: tenant reads and migration coordination, 2026-09-20
### What I set out to do
Audit the data and telemetry rows of #2972 against fresh main, then fix remaining defects within a reviewable change.
### What I actually did
Audited the issue's rows against 0d03a96b9. Replaced the ClickHouse mention-only tenant guard with a scoped source. Added a Postgres migration lock, adversarial unit tests, real-store CI cases, and ADR-116. Recorded the unfinished issue rows in the verification artifact.
### Quality of my decisions
- Best decision: treated checked issue rows as claims to verify. Several still describe the current implementation.
- Weakest decision: initially conflated ADR-054's migration connection with the application's system bypass pool. Re-reading tenant.ts corrected that report before edits.
### What I could have done better
- Read the system connection implementation before summarizing its role design.
- Separate completed ledger work from outstanding cross-process coordination at the start of the issue audit.
### What surprised me
The issue's parent rows are checked while their nested acceptance boxes and code still show live defects.
### Risks I am leaving behind
RLS bypass hardening, nullable-workspace writes, security-event partitioning, and durable telemetry buffering remain outside this PR. They need coordinated schema, credentials, or billing changes. No production mutations ran.
### Confidence in the result
Medium pending CI. All 17 tenant seam tests passed locally. Real-store and migration-lock cases remain for CI.
