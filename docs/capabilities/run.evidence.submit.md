# run.evidence.submit

**Domain:** run
**Mode:** sync
**Scope:** tenant (org + workspace)
**Requires approval:** no
**Risk level:** low

## Intent

The narrow, authenticated ingestion path for a **RunEvidenceManifestV1** — the
immutable evidence bridge between Stella's local working-code graph and Oxagen's
governed workspace graph
([spec](../specs/workspace-graph-boundary/spec.md) §"The immutable evidence
bridge"). It records, for one governed agent attempt, the exact commit-addressed
facts: local checkout + graph generation, selected context frames, changed files
with before/after digests, commits, pull-request/tool/approval/verification
receipts, and produced-artifact digests.

This is deliberately **not** the removed `push_graph` capability: it accepts no
arbitrary labels, edges, embeddings, or tombstones — only a typed manifest.

**Launch invariant 4** — no client can author canonical `provider_observed` or
`runner_observed` evidence. The input carries no `evidenceAuthority`; the handler
stamps every client submission `client_attested` (attested-but-unverified).

**Idempotent.** The `manifest_digest` is the sha256 of the canonical JSON of the
submitted manifest (server-added fields excluded). An identical resubmission
returns the existing manifest with `deduplicated: true` and never writes a second
immutable row.

## Input

| Field                    | Type                          | Notes                                                                 |
| ------------------------ | ----------------------------- | --------------------------------------------------------------------- |
| `runId`                  | `string`                      | Run this evidence attests (opaque runner id).                         |
| `attemptId`              | `string` (opt.)               | Attempt within the run.                                               |
| `principals`             | object                        | `{ initiatingPrincipalId, agentPrincipalId? }`.                       |
| `agentVersionId`         | `string` (opt.)               |                                                                       |
| `authorizationSnapshotId`| `string` (opt.)               |                                                                       |
| `localCheckoutSnapshot`  | object                        | LocalCheckoutSnapshotV1: `baseCommitSha` (req.) + `repositoryId?`, `headCommitSha?`, `headTreeSha?`, `dirtyPatchDigest?`, `untrackedManifestDigest?`, `graphGenerationId?`, `graphSchemaVersion?`, `extractorVersion?`, `indexedRootDigest?`, `completedAt?`, `freshnessStatus?`. |
| `context`                | object (opt.)                 | `{ compiledFrameManifestDigest?, frames[] }`. Each frame: `providerId`, `frameId`, `canonicalContentDigest`, `retentionMode` (`hash_only` \| `content_retained`), `uri?`, `localGraphGenerationId?`, `authorizationDecisionId?`, `tokenCost?`. |
| `changes`                | `Change[]`                    | Each: `pathLocator`, `changeKind` (`added` \| `modified` \| `deleted` \| `renamed`), `repositoryId?`, `beforeDigest?`, `afterDigest?`, `codeScopeId?`, `domainSlug?`. `pathLocator` may be a tenant HMAC. |
| `commits`                | `object[]`                    | Retained verbatim in the payload.                                     |
| `pullRequestReceipts`    | `object[]`                    | Retained verbatim.                                                    |
| `toolReceipts`           | `object[]`                    | Retained verbatim.                                                    |
| `approvalReceipts`       | `object[]`                    | Retained verbatim.                                                    |
| `verificationReceipts`   | `object[]`                    | Retained verbatim.                                                    |
| `artifactDigests`        | `string[]`                    | Content digests of produced artifacts.                               |

## Output

| Field            | Type      | Notes                                                     |
| ---------------- | --------- | --------------------------------------------------------- |
| `manifestId`     | `string`  | `publicId` of the stored (or pre-existing) manifest.      |
| `manifestDigest` | `string`  | sha256 of the canonical manifest content.                 |
| `deduplicated`   | `boolean` | `true` when an identical manifest already existed.        |

## Side effects

Appends one immutable `run_evidence_manifests` row plus normalized
`run_evidence_changes` and `run_context_frames` rows (all in one transaction).
Nothing is ever overwritten — the ledger is append-only. No Neo4j or ClickHouse
writes.

## Errors

| code        | meaning                                                    |
| ----------- | ---------------------------------------------------------- |
| `forbidden` | Caller lacks write permission on the run domain.          |

## Surfaces

- **API:** `POST /v1/{org}/{ws}/run/evidence`
- **MCP:** tool `submit_run_evidence`
- **CLI:** `oxagen run evidence submit --file <manifest.json>`
