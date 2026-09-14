# run.export

The signed, offline-verifiable evidence bundle for one sealed run (Mission Control spec §13.4 "Exports produce a verifiable bundle: segments, attestations, key ids, and a verifier script"; App. E; ADR-058). The capability queues the job and answers its id; the bundle is built by the durable function `evidence.run-export` and listed under Audit › exports (`evidence.run_exports`).

## Mode

**async**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs/export`
- MCP: `export_run`
- CLI: `oxagen run export <run-id>`
- Authentication: session; org Owner or Admin, checked in the handler (`assertOrgRole`, `apps/app/ARCHITECTURE.md` §3.2)
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

- `manifest.json` — bundle format, run id, attempt ids, frame count, Merkle root, enforcement tier, completeness gaps, replay grade, the attester key id and the export instant;
- `frames.ndjson` — one JCS envelope per frame in sequence order: the ledger's archive segments decompressed (the same bytes the seal wrote, spec §13.3), or the wrapped session's hash-chained events;
- `attestation.json` — an Ed25519 signature by the deployment's attester key over the RFC 8785 canonical JSON of `(run_id, attempt_id, frame_count, merkle_root, archive_segment_digest, enforcement_tier, completeness_gaps)` (spec §8.3), with the verifying public key (PEM) and its key id;
- `verify.mjs` — a Node script with no dependencies that recomputes the RFC 6962 Merkle root from `frames.ndjson`, checks it against the manifest, and verifies the attestation with the bundled key.

When the job cannot build the bundle (no attester key configured, a segment missing) the export row records `status: failed` with the reason.

## Errors

- `forbidden` (403): the actor is not an org Owner or Admin.
- `not_found` (404): no run with that id in the caller's workspace.
- `conflict` (409) `run_not_sealed`: a live run cannot be exported; the attestation signs the seal.
