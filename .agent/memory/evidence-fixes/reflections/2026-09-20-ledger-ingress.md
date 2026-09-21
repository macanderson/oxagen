## Self-evaluation: ledger ingress, 2026-09-20

### What I set out to do
Implement the ADR-056 run credential and cancellation connection point for #2953.

### What I actually did
Added two API capabilities, scoped expiring credentials, run-lock authorization,
transactional ingress revocation, and a separate revocation flag in the Run UI.
Added HTTP, handler, Postgres concurrency, and component witnesses for CI.

### Quality of my decisions
The run lock serializes issuance, appends, and cancellation. Dedicated-plane
issuance refuses before minting a secret because shared-plane authentication
cannot resolve it. An explicit machine-key refusal avoids treating its creator
as a current operator session.

### What I could have done better
- Trace package links before staging a new export. The shared dependencies
  initially resolved sibling worktree code and caused hook errors.
- Place the revocation field in the shared RunRow mapper on the first edit.
  A broad replacement initially put it in the Chain view, caught before commit.

### What surprised me
The outer SQL snapshot can predate the locked row after waiting for cancellation.
The append fence must be projected from the locking CTE itself.

### Risks left behind
Dedicated-plane credential authentication, and ledger pause, resume, and steer,
remain outside this increment. The feature governs evidence ingress and does
not stop an external process.

### Confidence
Medium pending CI. Independent coverage audit and configured hooks passed.
No local test command ran.
