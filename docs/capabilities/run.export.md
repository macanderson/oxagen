# export_run

The signed, offline-verifiable evidence bundle for one sealed run (Mission Control spec §13.4 "Exports produce a verifiable bundle: segments, attestations, key ids, and a verifier script"; App. E; ADR-058). The capability queues the job and answers its id. The durable function `evidence.run-export` builds the bundle and records it in `evidence.run_exports`. Read the export back, and get a download URL, with [`get_run_export`](run.export.get.md).

## Mode

**async**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs/export`
- MCP: none; no tool is built. `get_run_export` is on MCP.
- CLI: `oxagen run export <run-id>`
- Authentication: session or API key; org Owner or Admin, checked in the handler (`assertOrgRole`, `apps/app/ARCHITECTURE.md` §3.2) for the signed-in user or the key's creator (`resolveActingUserId`); a key with no recorded creator is refused `forbidden / no_principal`
- Capability name: `export_run`
- `mutates: true`; `agent.requiresApproval: false`; not billed (`noBillingGate: true`). IAM default-deny; high sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `runId` | string | yes | `arun_…` or `tse_…`, sealed |

## Output

| Field | Type | Description |
|---|---|---|
| `exportId` | string | the export job's public id (`rexp_…`) |
| `status` | `queued` | |

## The bundle

A zip written to `evidence/<org>/<workspace>/exports/<export id>/<sha256 hex>.zip` in the organisation's object store, holding:

- `manifest.json`: bundle format (`oxagen.run-export/3`), run id, and per attempt its frame count, Merkle root, sealed `event_stream_digest` (ledger runs), enforcement tier, completeness gaps and replay grade, plus the attester key id and the export instant.
- `frames.ndjson`: one JCS envelope per frame in sequence order. For a ledger run these are the archive segments the seal wrote (spec §13.3). For a wrapped session they are the hash-chained rows as the Run page shows them, each with `event`: the sealed Tacho event, rebuilt from the stored `tacho_events` row by `unflattenEvent` (`packages/tacho/src/columns.ts`). The export keeps the event only when it hashes to the row's `hash`, and otherwise leaves it out rather than guess.
- `attestation.json`: an Ed25519 signature by the deployment's attester key over the RFC 8785 canonical JSON of `(run_id, attempt_id, frame_count, merkle_root, archive_segment_digest, enforcement_tier, completeness_gaps)` (spec §8.3), with the verifying public key (PEM) and its key id.
- `redactions.json`: what the host redacted before the bytes were written, and what the bundle withholds, as kinds and counts. It holds no value, byte span, or `original_digest`. The verifier recomputes it from the frames, so an edited summary shows as broken.
- `verify.mjs`: a Node script with no dependencies that runs the same checks as `oxagen verify`.

`oxagen verify <bundle>` recomputes, per ledger frame, the payload digest and `event_digest` (RFC 8785) and checks `attempt_seq` is dense, then folds the attempt's `event_stream_digest`. Per wrapped frame it checks the `prev_hash` link and `seq`, recomputes the carried event's hash, checks that the event's `session_uuid` is the attempt's, and checks that the frame shows what that event says (`wrappedFrameOf`). `content.bytes_ref` is the control plane's storage location, not part of the event, so only the signed segment digest covers it. A wrapped frame without an event, including every wrapped frame of a format-1 or format-2 bundle, reports its digest `not carried`. Over the bundle it checks the frame count, the Merkle roots, each signature and key id, and `redactions.json`.

When the job cannot build the bundle (no attester key configured, a segment missing) the export row records `status: failed` with the reason.

## The repeated body

A carried wrapped frame shows `body` at its top level and again inside `event`. Format 3 keeps both copies (#3814), for these reasons:

- Every wrapped frame has the same top-level fields, carried or not. A frame the export cannot carry is the row's projection, and `body` is part of it.
- The verifier rebuilds the top level from the carried event (`wrappedFrameOf`) and requires the shown `body` to equal `event.body`, so the copy cannot drift from the hashed event.
- `body` holds the event's facts (tool, model, cost and token totals), not content bytes, which stay behind `content.bytes_ref`. Both copies sit in one line of `frames.ndjson`, inside deflate's 32 KiB window, so the zip stores the second copy as back-references. `run-export-bundle.test.ts` pins that the copy grows a zipped bundle by less than 5 percent.

Bundles in format 3 have shipped since #3810 on 2026-09-23. Dropping the copy would need format 4, accepted beside 3 by `oxagen verify` and by `verify.mjs`, to save a few bytes per frame.

The export rebuilds each wrapped event by trying the readings its row leaves open until one hashes to the row's `hash`. The rows of one session mostly share a reading, so the export tries the reading that rebuilt the previous row first (`unflattenEventReading` with `first`). A row that shares the previous row's reading costs one candidate. A row that no reading rebuilds still costs every reading it leaves open, up to 256.

## Errors

- `forbidden` (403): the actor is not an org Owner or Admin.
- `not_found` (404): no run with that id in the caller's workspace.
- `conflict` (409) `run_not_sealed`: a live run cannot be exported; the attestation signs the seal.
