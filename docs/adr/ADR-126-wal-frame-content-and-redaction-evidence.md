# ADR-126: Keep frame bodies in the WAL and record bounded redaction details

- **Status:** Accepted; the fifth guarantee, open below, is closed by [ADR-185](ADR-185-a-failed-wal-body-write-rolls-back-the-seal.md) (2026-09-25)
- **Date:** 2026-09-19
- **Related:** [ADR-100](ADR-100-frame-bodies-are-captured-by-default-redacted-at-the-host-capped-and-governed-by-retention.md), [#3365](https://github.com/macanderson/oxagen/issues/3365), [#3332](https://github.com/macanderson/oxagen/pull/3332), [#3342](https://github.com/macanderson/oxagen/pull/3342)

## Decision

Keep the WAL body files introduced by #3342. This records option (b), the reconciliation already reported in #3365. The competing per-event BodyStore is absent from the current tree. The daemon remains the sole writer of event and body files.

The hook normalizer carries raw content without assigning a content digest. The recorder redacts the bytes and assigns the digest before sealing the event. Raw prompt correlation hashes and raw source hashes retain their separate names and purposes. Digest-only OTel records remain supplied digests because the harness does not supply their bytes.

Redaction removes every match. The envelope's `MAX_CONTENT_REDACTIONS` is the sole detail-list cap. A frame retains the first 256 detail records and carries the full count in `oxagen.content_redactions_total`. Exceeding that cap does not remove the redacted body or digest. The body-size limit still omits bytes while preserving the redacted digest and redaction evidence.

## Reconciliation of the seven guarantees

| Guarantee | Current implementation and evidence |
|---|---|
| Redaction metadata cannot prevent sealing | `prepareContent` caps details using the envelope constant and records the full count. `frame-body.test.ts` and `hooks.test.ts` cover the cap, overflow, and redacted digest. |
| Retention classes govern host and server | `RETENTION_CLASS_BY_KIND` supplies the host classification and server `retainsBody` decision. `retention.test.ts` checks classes. |
| Narrowing stops queued content from shipping | `spool.ts` rechecks `retentionInForce`. `daemon-bodies.test.ts` covers narrowing before drain. |
| Encoded batches cannot wedge the WAL indefinitely | `fitRequestBudget` counts event JSON and encoded bodies against the shared request ceiling. A 413 splits the batch, then omits a lone body, then quarantines an event that still cannot fit. `collector-units.test.ts` covers these paths. |
| A failed body write must not skip an event | Required, but not yet preserved by the current `Wal.append`: a body write can throw before the event write. This remains open under #3365 and must be repaired before that issue closes. |
| Credential-heavy redaction avoids repeated prefix encoding | `redactBytes` advances its UTF-8 offset across disjoint spans. It no longer encodes the full prefix for each match. |
| Retention requires a verified mandate | The daemon and shipper use `retentionInForce`. An unverified mandate withholds bytes. A confirmed narrowing purges body files and persists purge debt before committing the new bundle. `daemon-bodies.test.ts` covers restart and failed purge-debt persistence. |

No guarantee is deliberately dropped. The failed-body-write row is an implementation gap, not an exception to the contract. The WAL substrate costs a scan and rewrite for selective erasure. It avoids two competing stores and lets the existing event identity and retention machinery own body cleanup.

## Why the #3342 review resolution did not describe the merged code

GitHub records #3342 as merged at `2026-09-18T22:27:26Z`, with head `ec9b3a607` and squash `b9beb0e5c`. That squash retains the 1 MiB route ceiling, a 4 MiB raw body budget, and retryable 413 handling.

The [reply accepting the request-size finding](https://github.com/macanderson/oxagen/pull/3342#discussion_r4051234403) names `6382cbaec`. That commit was created at `2026-09-18T22:43:39Z`, after the merge. The reply followed at `22:45:26Z`. The repair therefore could not have been part of the already completed squash. The current tree has the later request-size fixes, but the reply alone was not evidence for the merged tree.

Verify a review repair against the actual merge commit before treating its resolution as shipped. A commit named after a merge is evidence of follow-up work, not evidence that the earlier merge contained it.

## Verification boundary

This change adds exact-cap, overflow, oversized-redacted-body, and recorder regressions. CI runs them. The session's local test allowance was already used on its billing work, so these files were not run locally. Existing retention, WAL, and shipper tests were inspected rather than rerun. No production change is part of this decision.
