## Self-evaluation: approval history, 2026-09-20
### What I set out to do
Fix backlog issues #3493 and #3478 from a fresh main worktree.
### What I actually did
Confirmed #3493 already has a revision digest and direct-republish tests in merged #3522. Added inherited run correlation, persisted ordinary approval expiry, and a system expiry label for #3478. Added kernel, database, job, and component regressions.
### Quality of my decisions
- Best decision: inspected current main before modifying the steering cache, which already held the fix.
- Weakest decision: started with seam-only correlation coverage before adding a test that checks the actual approval receipts.
### What I could have done better
- Check recent file history alongside the issue before planning edits.
- Plan the single local test allowance around the highest-risk query change before adding fixtures.
### What surprised me
An hourly mandate sweep already owned approval expiry but excluded ordinary parked approvals.
### Risks I am leaving behind
The sweep remains hourly, so expired approvals appear in resolved history after the next successful sweep. CI must run the new Postgres and component cases. No shared dev services were started.
### Confidence in the result
Medium pending CI. The expiry test file passed all eight tests locally. Full checks run in CI.
