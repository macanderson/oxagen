# GitHub organization polling and record identity

The #2974 audit found that #1265 remained open: organizations were accepted by configuration but never expanded for polling. Enabling expansion also exposed a P1 identity collision. Two repositories with issue 7 produced the same connection natural key and overwrote one graph node.

The change gives issue and pull-request records globally distinct identities, preserves compatible legacy nodes through a canonical alias, expands organization repositories, reads all pages, and refuses incomplete batches. ADR-121 describes reconciliation and the 200-record worker limit.

## Verification

- The isolated `src/dedup/__tests__/resolve.test.ts` run passed 33 tests. This is the only local test file run for this change.
- Added CI regressions for record identity, repository rename, org expansion, duplicate targets, pagination, later-page failure, pipeline identity propagation, canonical alias persistence, and the worker's 200/201 boundary.
- Added a real Neo4j regression that preserves a legacy public ID and relationship through backfill and repository rename. It has not run locally.
- Parent independently reviewed the identity, compatibility, and overflow paths. It requested the canonical alias and explicit capacity-limit documentation; both are included.
- Other test files, package checks, coverage, and integration tests remain CI work. No production, paid-provider, or bulk-backfill calls were made.
