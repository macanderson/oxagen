# 6. Testing Policy

### 6.1 Unit Tests

- Every unit of business logic ships with unit tests in the same PR. No logic merges untested.
- Tests assert behavior and contracts, not implementation details. Refactoring internals must not break a correct test.
- Pure functions and domain logic are tested in isolation with no I/O. Mock at the adapter seam, never deep inside vendor SDKs.
- Cover the edge: empty inputs, boundary values, error paths, and the failure mode, not just the happy path.
- Tests are deterministic. No reliance on wall-clock time, network, ordering, or random seeds without control.
- A bug fix lands with a regression test that fails before the fix and passes after.

### 6.2 End-to-End Tests

- Every user-facing capability has at least one e2e test exercising the real path through API and UI against a real database.
- E2e tests run against the actual stack, not mocks. They prove the slice works wired together.
- Keep the e2e suite lean and high-signal. One solid path per capability beats ten brittle permutations. Push detail coverage down to unit tests.
- E2e tests are stable. A flaky e2e test is a bug to fix or quarantine with an owner and a deadline, never a thing to retry-until-green.
- CI gate: unit and e2e both pass, or the PR does not merge. No merging on red, no skipping suites.
