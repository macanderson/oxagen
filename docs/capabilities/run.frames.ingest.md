# ingest_run_frames

**Surfaces:** api

`POST /v1/run-ingest` accepts evidence from a credential issued by
`create_run_token`. The bearer credential supplies the tenant and attempt.
The request cannot supply an organization, workspace, run, or attempt id.

The strict input contains 1 to 200 `events`. Each carries `attemptSeq`,
`eventType`, `observedAt`, and either allowlisted `payload` metadata or an
`encryptedPayloadRef` with `payloadDigest`. An optional `body` carries
`contentType` and base64 bytes. The HTTP request is limited to 2 MiB. The
existing ledger validates event kinds, dense sequences, replay digests,
redaction, and the run's pinned retention policy.

An event the ledger refuses as malformed answers 400 with `bad_request`: an
unknown event type, a payload that fails its event type's schema or carries a
raw content field, an oversized payload, or both or neither of `payload` and
`encryptedPayloadRef`. Nothing in the batch is written.

The response returns accepted event receipts, the last attempt and run
sequences, and the refreshed `expiresAt`. Each receipt carries `attemptSeq`,
`runSeq`, `eventDigest` and `idempotent`. A producer names an event by its
sequence. The receipt has no event id, because the event row's id is internal
and the event table has no public id. The call refreshes the existing bearer
credential rather than replacing its secret. The credential is rechecked
under the run lock before any evidence write. Revocation, expiry, a changed
attempt binding, a sealed attempt, or cancellation refuses the append.

A direct `dispatch_command` cancel locks the same run, fences further
appends and attempt creation, revokes its credentials, and writes an applied
command receipt in one transaction. Its detail is `ledger_ingress_revoked`.
This records enforcement at the ledger boundary. It does not claim that the
external process stopped. Pause, resume, and steer still require a producer
connection and remain refused for ledger runs. Broadcasts target wrapped
sessions. There are no queued ledger commands to deliver on this ingress.
