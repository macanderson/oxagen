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

A malformed frame is refused with a 400 and writes nothing. That covers an
event with both or neither of `payload` and `encryptedPayloadRef`, an event
type outside the registry, a payload that fails its event schema, a raw
content field, and an inline payload over the byte cap. A batch that skips a
sequence answers 409 `run_event_sequence_gap`. A replay whose digest differs
from the recorded event answers 409 `run_event_integrity_conflict`.

The response returns accepted event receipts, the last attempt and run
sequences, and the refreshed `expiresAt`. Each receipt carries `attemptSeq`,
`runSeq`, `eventDigest`, and `idempotent`. It does not carry the ledger's
internal event row id. Earlier responses included that id as `eventId`, and
it was removed on 2026-09-25 (#3665). It refreshes the existing bearer
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
