# Immutable Run Evidence Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finalize every sealed attempt into one immutable, tenant-scoped, independently verifiable manifest with encrypted exact payloads, authoritative receipt references, honest replay grade, and separately authorized replay access.

**Architecture:** An in-process durable-worker finalizer rebuilds `RunEvidenceEnvelopeV1` from the authoritative attempt log and receipt sink, then invokes the internal `ingest_run_evidence` capability through the kernel using a service principal plus the attempt's one-shot grant. The ledger verifies all bindings, derives coverage/grade, signs the server-stamped manifest with asymmetric KMS, inserts the manifest and grant use atomically, and creates mutable downstream-delivery rows. Exact bytes are AES-GCM envelope-encrypted with tenant-bound AAD before private blob storage.

**Tech Stack:** TypeScript 6, Zod 3, RFC 8785 JCS, PostgreSQL/Drizzle/Atlas, AWS KMS, AES-256-GCM, `@oxagen/storage`, Vitest, capability kernel, durable agent worker.

## Global Constraints

- PR 2 consumes the schemas, limits, and digest code from PR 0B and the attempts, seals, grants, authorization decisions, and obligations from PR 1A. It does not define a second evidence contract.
- The envelope carries producer observations only. Tenant, principals, agent version, authorization snapshot, authority, completeness, replay grade, manifest ID, and attestation are server-stamped.
- Every object schema is strict and bounded. Canonical envelope size is checked after JCS and must remain within the 1 MiB launch ceiling from PR 0B.
- Raw source, prompts, model/tool payloads, diffs, paths, credentials, chain-of-thought, storage keys, KMS ARNs, and internal UUIDs never appear in a manifest, API response, ClickHouse, or Neo4j.
- Exact bytes are persisted only as tenant-encrypted evidence blobs and referenced by `evb_` public ID plus plaintext digest/length/media type.
- The manifest and blob index are immutable. Claims, exports, and downstream deliveries use separate mutable coordination rows.
- Evidence finalization is kernel-enforced and default deny in every tier. It has no API, MCP, CLI, app, or agent discovery surface and no second billing gate.
- A service principal proves workload identity; the one-shot grant proves authority over one sealed attempt/digest. The finalizer requires both.
- The foundation grant public ID is the stable envelope `submission_id`; retries never mint a replacement submission identity.
- KMS failure, blob-policy mismatch, malformed evidence, missing receipt, or identity conflict leaves the immutable obligation pending. It never creates an unsigned or partial manifest.
- Runner-captured GitHub responses are attempt receipts with `runner_observed` authority. Only PR 4's independent exact-connection re-fetch may mint an `rpo_` `provider_observed` receipt.
- `packages/replay` remains a local recorder/restore library. Reuse its lessons and tests, not its hash implementation or `record-v1` envelope.

---

## Reviewable PR Decomposition

| PR | Tasks | Dependency | Merge result |
|---|---|---|---|
| 2A | Tasks 2–3 | PR 0B | Evidence-specific encryption, strict storage behavior, attestation signer, configuration, and KMS infrastructure exist without accepting evidence |
| 2B | Tasks 1, 4, 4A, 5–6, 8 | PR 1A + PR 2A | Immutable ledger, durable receipt-producing ports, and finalizer are live internally, every seal is consumable once, and external `record_execution` is gone |
| 2C | Tasks 7 and 7B | PR 2B | Replay read/export is separately authorized and audited, and retention expiry/manual erasure appends verifiable receipts |

PR 2A may run in parallel with PR 1A. PR 2B depends on both PR 1A and PR 2A. PR 1B, PR 3, and PR 4 depend on PR 2B; preview/production enablement also depends on PR 2C. Keep each PR's commits limited to its listed tasks even though this file describes the full evidence subsystem.

---

## Task 1: Add the Immutable Evidence Schema

**Files:**

- Create: `packages/database/src/schema/run-evidence.ts`
- Create: `packages/database/src/__tests__/run-evidence-schema.test.ts`
- Create: `packages/database/integration/run-evidence-ledger.test.ts`
- Create: `packages/database/atlas/migrations/20260806130000_run_evidence_ledger.sql`
- Modify: `packages/database/src/schema/_schemas.ts`
- Modify: `packages/database/src/schema/index.ts`
- Modify: `packages/database/src/relations.ts`
- Modify: `packages/database/src/types.ts`
- Modify: `packages/database/src/tenant-policy.manifest.ts`
- Modify: `packages/database/src/tenant-policy.manifest.test.ts`
- Modify: `packages/database/atlas/migrations/atlas.sum`
- Modify: `packages/database/storage-manifest.json`

- [ ] Write schema and live-database tests first for RLS, cross-tenant rejection, append-only grants, finalization uniqueness, and mutable delivery isolation.
- [ ] Create `evidence.run_evidence_manifests`: `revm_` public ID; scoped run/attempt/seal, submission, both principals, agent/version, authorization snapshot, immutable retention-policy public ID/digest/expiry, verification-key version, envelope digest, runner authority, replay grade, completeness, envelope/manifest JSON, signed canonical bytes, algorithm/fingerprint/signed digest/signature, and received time. It has no `updated_at`.
- [ ] Enforce `UNIQUE(org_id, submission_id)` and `UNIQUE(attempt_id)`, strict digest/authority/grade checks, and complete tenant bindings.
- [ ] Create `evidence.run_evidence_blobs`: `evb_` public ID; tenant/retention/content-class scope; plaintext and ciphertext digests/lengths; canonical media type; driver/key; `effective_access = 'private'`; encryption key version, envelope version, AAD digest, and creation time. Enforce one canonical blob identity per `(org, workspace, retention-policy version, content class, media type, plaintext digest)` and never expose `storage_key`.
- [ ] Create mutable fenced `evidence.run_evidence_blob_write_intents` keyed by that canonical content identity. It preallocates the stable `evb_`/storage key/AAD identity, coordinates exactly one upload, and tracks expiry/error digest; an orphan sweeper may delete ciphertext only when no immutable blob row/ref exists.
- [ ] Create immutable versioned `evidence.path_locator_keys` and `evidence.run_path_locators`: opaque `rpl_` public ID, tenant/key version, internal HMAC, optional encrypted exact-path blob ref, and creation time. Enforce tenant-local HMAC uniqueness; API/manifest types expose only `rpl_`, never the HMAC or raw path. Rotation inserts a key version and preserves resolution of older locators.
- [ ] Create immutable `evidence.run_evidence_erasure_receipts` plus key-tombstone rows that bind manifest/blob/content class, policy/authorization decision, erased key version or ciphertext target, actor/workload, reason, and time. Erasure never updates a manifest or claims that the historical digest disappeared.
- [ ] Create immutable `evidence.run_evidence_manifest_blob_refs` with manifest/blob, bounded purpose enum, ordinal, and unique `(manifest_id, purpose, ordinal)`.
- [ ] Create immutable `evidence.run_evidence_finalization_grant_uses` keyed by foundation grant, with one attempt/seal/manifest and envelope digest. Insert it in the manifest transaction.
- [ ] Create mutable `evidence.run_evidence_finalization_claims` with `ready|leased|backoff|operator_attention` status, random fence token, claim owner/expiry, retry count/next time, and last error digest. Pending truth remains the immutable obligation anti-joined to grant use; no claim status satisfies or deletes an obligation.
- [ ] Create mutable `evidence.run_evidence_deliveries` with one row per unique `(manifest_id, destination)` for `clickhouse|neo4j|provider_reconciliation`, plus random claim fence token, claimant/expiry, bounded retry/time, error digest, status, and delivered time. Success/failure updates require the live token; a failed delivery never changes a manifest.
- [ ] Create immutable `evidence.run_evidence_verification_keys`: `revk_` public ID, org, algorithm, internal provider key locator, public SPKI, fingerprint/certificate chain, activation/retirement times, registration principal, and registration attestation digest. A manifest exposes only the `revk_` ID and public verification material.
- [ ] Create immutable access receipts and mutable export coordination tables for Task 7. `run_evidence_export_requests` has `rpex_` public ID, requester/mode/manifest, `pending|leased|complete|failed|expired`, current decision, random fence/claim expiry/backoff, wrapped-DEK metadata, request expiry, and digest-only error. `run_evidence_export_chunks` has request/ordinal, ciphertext and plaintext digests/lengths, AAD, storage reference, and expiry with unique `(request_id, ordinal)`. Access receipts bind authorization-decision reference and never update.
- [ ] Grant `oxagen_app` only `SELECT, INSERT` on manifests, blobs, refs, grant uses, and access receipts; explicitly revoke update/delete and add rejection triggers. Verification-key registration uses a separate audited deployment role/function and the app/finalizer roles have `SELECT` only on keys. Grant narrowly scoped update only on claims/deliveries/export coordination.
- [ ] Re-check and renumber the migration after PR 1A merges, then hash/validate Atlas.
- [ ] Run `pnpm --filter @oxagen/database test:unit -- src/__tests__/run-evidence-schema.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/database test:integration -- integration/run-evidence-ledger.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/database atlas:validate`; expect pass.
- [ ] Commit: `feat(database): add immutable run evidence ledger`

## Task 2: Add Evidence Encryption and Asymmetric Attestation

**Files:**

- Modify: `packages/crypto/src/types.ts`
- Modify: `packages/crypto/src/envelope.ts`
- Modify: `packages/crypto/src/envelope.test.ts`
- Create: `packages/crypto/src/kms/attestation.ts`
- Create: `packages/crypto/src/kms/attestation.test.ts`
- Modify: `packages/crypto/src/kms/aws.ts`
- Modify: `packages/crypto/src/kms/aws.test.ts`
- Modify: `packages/crypto/src/kms/index.ts`
- Modify: `packages/crypto/src/index.ts`
- Modify: `packages/storage/src/types.ts`
- Modify: `packages/storage/src/vercel-blob.ts`
- Modify: `packages/storage/src/vercel-blob.test.ts`
- Modify: `packages/storage/src/fs-driver.ts`
- Modify: `packages/storage/src/fs-driver.test.ts`
- Modify: `packages/config/src/env.ts`
- Modify: `packages/config/src/env.test.ts`
- Modify: `packages/config/src/registry.ts`
- Modify: `packages/config/src/registry.test.ts`
- Modify: `.env.example` via `pnpm env:check --write`

- [ ] Write AES-GCM tests first for tenant-bound associated data, ciphertext/AAD tampering, wrong tenant/policy/blob ID, v1 decryption compatibility, and v2 evidence output.
- [ ] Add associated data to the existing envelope primitive without breaking v1. Evidence writes use v2 AAD over org, workspace, stable blob public ID, plaintext digest, immutable retention-policy public ID/digest, content class, and canonical media type; pass matching tenant encryption context to AWS KMS.
- [ ] Add an `EvidenceKeyResolver` that chooses a server-configured encryption key/version. Producers cannot submit key IDs.
- [ ] Define a separate `AttestationSigner` rather than overloading the symmetric `KmsAdapter`. Production uses `AWS_KMS_ECDSA_P256_SHA256_DER`, `Sign` with `MessageType=DIGEST`, and `GetPublicKey`; require `ECC_NIST_P256` and `SIGN_VERIFY`.
- [ ] Fingerprint the exact SPKI DER with SHA-256 and store DER signature bytes with an explicit algorithm. Never put the KMS ARN in the manifest.
- [ ] Add an audited `registerEvidenceVerificationKey` bootstrap/rotation command available only to the deployment role. It calls `DescribeKey`/`GetPublicKey`, verifies usage/spec, inserts a new immutable `revk_` version, and activates it without giving `oxagen_app` key-registration authority. Rotation never rewrites an earlier manifest's key reference.
- [ ] Add `allowAccessFallback` and `allowOverwrite` to storage put options. Evidence always passes both as false, requests private, and independently checks `result.access === 'private'`.
- [ ] If a storage adapter reports a policy mismatch, best-effort delete the ciphertext, emit a security event, insert no blob row, and leave finalization retryable. Test the current Vercel private-to-public downgrade path.
- [ ] Add signing/encryption key ARN and active public key-version configuration to the worker workload registry. Production finalizer bootstrap fails if either uses a local fallback or if the configured KMS public key/fingerprint does not match the registered `revk_` row.
- [ ] Regenerate `.env.example`; do not edit it manually.
- [ ] Run `pnpm --filter @oxagen/crypto test:unit -- src/envelope.test.ts src/kms/aws.test.ts src/kms/attestation.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/storage test:unit -- src/vercel-blob.test.ts src/fs-driver.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/config test:unit -- src/env.test.ts src/registry.test.ts`; expect pass.
- [ ] Run `pnpm env:check`; expect pass.
- [ ] Commit: `feat(evidence): add encrypted blobs and KMS attestation`

## Task 3: Provision Dedicated Keys and Split Worker Workloads

**Files:**

- Create: `infra/modules/kms-signing/main.tf`
- Create: `infra/modules/kms-signing/variables.tf`
- Create: `infra/modules/kms-signing/outputs.tf`
- Create: `infra/modules/agent-worker/main.tf`
- Create: `infra/modules/agent-worker/variables.tf`
- Create: `infra/modules/agent-worker/outputs.tf`
- Create: `packages/agent-worker/Dockerfile`
- Modify: `infra/environments/production/main.tf`
- Modify: `infra/environments/production/outputs.tf`
- Modify: `packages/config/src/registry.ts`
- Modify: `packages/config/src/registry.test.ts`
- Modify: `tools/env-manager/README.md`

- [ ] Create an asymmetric `ECC_NIST_P256`, `SIGN_VERIFY` KMS key/alias for evidence attestation. Do not place it in the existing symmetric key module.
- [ ] Build one pinned `@oxagen/agent-worker` image with two explicit entry modes, but deploy separate `agent-executor` and `evidence-finalizer` workloads/task roles. The executor receives model/sandbox/provider authority and no signing action; the finalizer receives the evidence service principal, storage/encryption access, and only `kms:Sign`, `kms:GetPublicKey`, and `kms:DescribeKey` on the signing key. Neither receives key-administration actions.
- [ ] Provision a separate symmetric evidence encryption key with tenant encryption-context conditions and only data-key/decrypt actions needed by the evidence blob service.
- [ ] Output internal deployment values as sensitive where appropriate; application manifests still use `revk_` and public fingerprint, never Terraform/KMS identifiers.
- [ ] Add `WORKLOAD_NAMES = ["agent-executor", "evidence-finalizer"]` and `workloads` metadata alongside the existing Vercel-only `services` metadata in the environment registry. Add `requiredKeysForWorkload()` tests and tag every database, storage, KMS, feature-flag, GitHub/Modal, and later Stella variable to the exact consumer; do not pretend either worker is a Vercel project.
- [ ] Provision both long-running workloads with minimum replicas, bounded concurrency, health/drain behavior, immutable image digest, private secret injection, and separate task roles. Deploy 2A with desired count zero; PR 2B raises the finalizer only after schema/key registration, and PR 1B raises V2 executor claims only after finalizer health is proven.
- [ ] Run `tofu fmt -check -recursive infra`; expect pass.
- [ ] Run `tofu -chdir=infra/environments/production validate`; expect pass.
- [ ] Run `pnpm --filter @oxagen/config test:unit -- src/registry.test.ts`; expect pass, including workload secret-routing assertions.
- [ ] Attach a reviewed production plan showing only the new keys/policies before apply. Infrastructure apply is a separate explicitly approved operational action.
- [ ] Commit: `infra(evidence): provision keys and split workers`

## Task 4: Build the Ledger and Receipt Authority Resolver

**Files:**

- Create: `packages/run-evidence/src/event-stream.ts`
- Create: `packages/run-evidence/src/stage-coverage.ts`
- Create: `packages/run-evidence/src/receipt-authority.ts`
- Create: `packages/run-evidence/src/blob-store.ts`
- Modify: `packages/run-evidence/src/manifest.ts` from PR 0B; preserve its frozen schema exports
- Create: `packages/run-evidence/src/ledger.ts`
- Create: `packages/run-evidence/src/verify.ts`
- Create: `packages/run-evidence/src/export.ts`
- Create: `packages/run-evidence/src/event-stream.test.ts`
- Create: `packages/run-evidence/src/stage-coverage.test.ts`
- Create: `packages/run-evidence/src/receipt-authority.test.ts`
- Create: `packages/run-evidence/src/blob-store.test.ts`
- Create: `packages/run-evidence/src/manifest.test.ts`
- Create: `packages/run-evidence/src/ledger.test.ts`
- Create: `packages/run-evidence/src/verify.test.ts`
- Create: `packages/run-evidence/src/export.test.ts`
- Modify: `packages/run-evidence/src/index.ts`
- Modify: `packages/run-evidence/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] Write tests first from PR 0B's JCS, event-stream, envelope, and signature fixtures. Do not import `packages/replay/src/hash.ts`.
- [ ] Implement `digestEventStream` over ordered `(attempt_seq, event_schema_version, event_type, payload_digest)` tuples and verify every authoritative event/event digest before assembly.
- [ ] Implement `deriveStageCoverage` from trusted event stages, durable gaps, policy, and seal. Compare producer coverage exactly; missing evidence becomes a gap and lower grade, never inferred success.
- [ ] Implement a `ReceiptAuthorityResolver` for authorization decisions, approvals, metering, runner-captured provider-response receipts, and evidence blobs. Reject unknown, producer-minted, cross-tenant, cross-run/attempt, wrong-digest, or wrong-kind references. Reserve `rpo_` and `provider_observed` for PR 4's independent post-finalization provider re-fetch; a runner receipt cannot claim that authority.
- [ ] Implement content-addressed blob persistence: compute plaintext digest, atomically claim or reuse the stable write intent/`evb_`, encrypt with its AAD, disallow fallback/overwrite, verify effective access, and insert immutable metadata. Concurrent/retried writers either reuse the verified canonical blob or wait/reclaim the same fenced intent; they never mint a second canonical ID for the same content identity.
- [ ] Add an orphan sweep for expired write intents and post-upload/pre-row crashes. It verifies there is no immutable blob/ref before best-effort ciphertext deletion and records only digest-level errors; a referenced blob is never swept.
- [ ] Implement `assembleRunEvidenceEnvelope(attemptId)` from durable events/receipts. It must work after process death and must not use an in-memory terminal result.
- [ ] Implement server derivation of completeness and `structural|content_exact|environment_restore`. `content_exact` requires verified exact encrypted payloads for every reached applicable stage; environment restore requires the additional restorable sandbox/checkpoint/tool-version evidence.
- [ ] Build the unsigned manifest with server identities and `received_at`, digest its JCS bytes with attestation omitted, sign it, and verify it with exported public material.
- [ ] Test failed-before-model, denied-before-checkout, cancelled, verification-failed, abandoned zero-event, complete content-exact, incomplete retention, forged references, and tampered signature/blob.
- [ ] Run `pnpm --filter @oxagen/run-evidence test:unit -- src/event-stream.test.ts src/stage-coverage.test.ts src/receipt-authority.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/run-evidence test:unit -- src/blob-store.test.ts src/manifest.test.ts src/ledger.test.ts src/verify.test.ts src/export.test.ts`; expect pass.
- [ ] Commit: `feat(evidence): implement the run evidence ledger`

## Task 4A: Produce Durable Receipts at Every Hosted Runtime Port

**Files:**

- Create: `packages/run-evidence/src/receipt-events.ts`
- Create: `packages/run-evidence/src/receipt-events.test.ts`
- Create: `packages/run-evidence/src/receipt-sink.ts`
- Create: `packages/run-evidence/src/receipt-sink.test.ts`
- Create: `packages/run-evidence/src/path-locator.ts`
- Create: `packages/run-evidence/src/path-locator.test.ts`
- Create: `packages/agent/src/runtime/evidence-context-port.ts`
- Create: `packages/agent/src/runtime/evidence-context-port.test.ts`
- Create: `packages/agent/src/runtime/evidence-model-port.ts`
- Create: `packages/agent/src/runtime/evidence-model-port.test.ts`
- Create: `packages/agent/src/runtime/evidence-tool-port.ts`
- Create: `packages/agent/src/runtime/evidence-tool-port.test.ts`
- Create: `packages/agent/src/runtime/evidence-command-port.ts`
- Create: `packages/agent/src/runtime/evidence-command-port.test.ts`
- Create: `packages/agent/src/runtime/evidence-approval-port.ts`
- Create: `packages/agent/src/runtime/evidence-approval-port.test.ts`
- Create: `packages/ai/src/evidence-transport.ts`
- Create: `packages/ai/src/evidence-transport.test.ts`
- Modify: `packages/ai/src/stream.ts`
- Modify: `packages/ai/src/stream.test.ts`
- Modify: `packages/agent/src/adapters/platform-agent-ai.ts`
- Modify: `packages/agent/src/runtime/materialize-tools.ts`
- Modify: `packages/agent/src/runtime/materialize-tools.test.ts`
- Modify: `packages/agent/src/runtime/turn-driver.ts`
- Modify: `packages/agent/src/runtime/turn-driver.test.ts`
- Modify: `packages/agent/src/index.ts`
- Modify: `packages/agent/package.json`
- Modify: `packages/run-evidence/src/index.ts`
- Modify: `pnpm-lock.yaml`

- [ ] Define strict receipt-event payloads for context selection/compilation, model request/outcome/usage, kernel tool decision/approval/metering/result, sandbox command/verification, and runner-captured GitHub responses. They carry public refs and digests only; exact bytes go through the encrypted blob sink before the event references them.
- [ ] Implement `createRunPathLocator` with the active tenant HMAC key version and `rpl_` record. Normalize only repository-relative byte paths, prevent traversal/absolute input, prove no cross-tenant equality leakage, preserve old-version resolution after rotation, and store exact paths only through the encrypted blob sink when policy permits.
- [ ] Implement `EvidenceReceiptSink` over PR 1A's fenced `appendAttemptBatch`. It rejects a missing/fenced lease, wrong run/attempt, duplicate ref with a different digest, an unregistered receipt kind, or any attempt to stamp `provider_observed`. A successful append is durable before the wrapped port returns success to the engine.
- [ ] Wrap context authorization and compiler boundaries. Record ordered frame IDs/provenance, authorization-decision refs, query/manifest/template/tokenizer digests, and the digest of the exact rendered context used by the model. Do not infer a receipt later from presentation events.
- [ ] Instrument the low-level `@oxagen/ai` provider transport at the final serialized request bytes and raw response-body/error bytes, before SDK decoding. The agent wrapper records resolved provider/model/config, context-selection digest, those exact transport digests, usage/metering ref, and finish/error class for every paid call, including aborts and transport failures.
- [ ] Wrap `kernel.invoke()` tool execution. Persist the platform-created authorization-decision ref on allow, deny, pending approval, and evaluation error; bind approval and metering refs plus input/output/error digests. A caller or engine cannot supply any of those authority refs.
- [ ] Wrap sandbox commands and verification with environment, executable/argument, exit/timeout/cancel, stdout/stderr blob, and verdict digests. Credentials, absolute paths, and raw output never enter the receipt event.
- [ ] Treat GitHub branch/commit/tree/PR results captured by the governed publisher as `runner_provider_response` receipts under `runner_observed` manifest authority. Only PR 4 can create additive `rpo_` observations after an independent provider read.
- [ ] Persist a model-call intent and stable operation idempotency key before transmission. Assemble after process death using only the event log, immutable platform decision/approval/metering rows, and encrypted blobs. A crash after proven transmission but before a recoverable provider outcome emits the contract's explicit `indeterminate` receipt with request plus error/gap digests; it is never mislabeled success/failure and always lowers completeness.
- [ ] Run `pnpm --filter @oxagen/run-evidence test:unit -- src/receipt-events.test.ts src/receipt-sink.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/run-evidence test:unit -- src/path-locator.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/ai test:unit -- src/evidence-transport.test.ts src/stream.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/agent test:unit -- evidence-context-port.test.ts evidence-model-port.test.ts evidence-tool-port.test.ts evidence-command-port.test.ts evidence-approval-port.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/agent test:unit -- materialize-tools.test.ts turn-driver.test.ts`; expect pass.
- [ ] Commit: `feat(evidence): record durable hosted-port receipts`

## Task 5: Add the Internal Kernel Capability and Workload Identity

**Files:**

- Create: `packages/oxagen/src/contracts/ingest_run_evidence.ts`
- Create: `packages/oxagen/src/contracts/ingest_run_evidence.test.ts`
- Modify: `packages/oxagen/src/types.ts`
- Modify: `packages/oxagen/src/kernel.ts`
- Modify: `packages/oxagen/src/kernel.test.ts`
- Modify: `packages/oxagen/src/types.test.ts`
- Modify: `packages/oxagen/src/contracts/capability.registry.list.ts`
- Modify: `packages/handlers/src/capability.registry.list.ts`
- Modify: `packages/handlers/src/schema.setup.ts`
- Create: `packages/handlers/src/ingest_run_evidence.ts`
- Create: `packages/handlers/src/ingest_run_evidence.test.ts`
- Create: `packages/handlers/src/lib/run-evidence-service-role.ts`
- Create: `packages/handlers/src/lib/run-evidence-service-role.test.ts`
- Modify: `packages/handlers/src/register.ts`
- Modify: `packages/handlers/src/iam-provision.ts`
- Modify: `tools/scripts/seed-iam-defaults.ts`
- Create: `tools/scripts/provision-run-evidence-service-principals.ts`
- Modify: `packages/iam/src/fetch-authz.ts`
- Modify: `packages/iam/src/fetch-authz.test.ts`
- Modify: `packages/iam/src/check-iam.ts`
- Modify: `packages/iam/src/check-iam.test.ts`
- Modify: `packages/compliance/src/security-event-types.ts`
- Modify: `packages/compliance/src/security-event-types.test.ts`
- Create: `packages/database/atlas/migrations/20260806130500_run_evidence_security_events.sql`
- Modify: `packages/database/atlas/migrations/atlas.sum`

- [ ] Register `ingest_run_evidence` as sync, `surfaces: ["internal"]`, high sensitivity, default deny, always-IAM-enforced, non-billable lifecycle work, and no default human/agent role grants. Input is only the PR 0B envelope; output is accepted/duplicate plus `revm_` ID, digest, runner authority, grade, and receive time.
- [ ] Extend capability surfaces and completeness checks with `internal`, but omit internal capabilities from user/agent/MCP/CLI discovery and generated interactive docs.
- [ ] Resolve an explicit active service principal by ID and tenant. Reject combined human/API-key/service identities and remove the non-enterprise fast-path for `alwaysEnforceIam` capabilities.
- [ ] Deterministically provision one org service principal `Run Evidence Worker`, one `Run Evidence Finalizer` role, and the sole allow grant for exact-name `ingest_run_evidence`.
- [ ] Construct the checked service context only from the attested `evidence-finalizer` workload identity established at process bootstrap, then resolve that org's provisioned principal; no in-process handler/caller field may self-assert the principal ID. Run an audited idempotent backfill over every existing org and gate finalizer claims on zero missing/duplicate principals, roles, or exact-name grants.
- [ ] Require the matching one-shot finalization grant in addition to service-principal IAM. Lock it against tenant, attempt, seal, final event digest, stream digest, and capability.
- [ ] In ingestion: bound/parse; resolve authoritative bindings; recompute stream/envelope; derive coverage/grade; resolve refs; preflight both idempotency keys; sign; then lock/recheck and insert manifest, blob refs, grant use, and delivery rows in one tenant transaction.
- [ ] Same submission/attempt plus same digest returns the existing receipt. Reuse of either key with a different digest emits a security event and fails closed.
- [ ] Add named security events for storage access downgrade, blob/write-intent conflict, finalization idempotency-key conflict, forged receipt/binding, service-principal assertion, and grant misuse. Emit through an independent durable security sink so the event survives rollback of the rejected evidence transaction; store digests/IDs only.
- [ ] Test wrong service principal, tier bypass attempt, consumed/digest-mismatched/wrong-attempt grant, rejection of any caller-supplied expiry field, forged run identity, cross-tenant ref, concurrent finalizers, KMS failure, and duplicate/conflicting submission.
- [ ] Run `pnpm --filter @oxagen/oxagen test:unit -- src/contracts/ingest_run_evidence.test.ts src/kernel.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/handlers test:unit -- ingest_run_evidence.test.ts src/lib/run-evidence-service-role.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/iam test:unit -- src/fetch-authz.test.ts src/check-iam.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/compliance test:unit -- src/security-event-types.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/database atlas:validate`; expect pass with the additive event taxonomy migration.
- [ ] Run `pnpm check:manifest`; expect pass.
- [ ] Commit: `feat(evidence): add kernel-enforced internal ingestion`

## Task 6: Finalize Every Sealed Attempt From the Durable Obligation

**Files:**

- Create: `packages/agent-worker/src/evidence-finalizer.ts`
- Create: `packages/agent-worker/src/evidence-finalizer.test.ts`
- Modify: `packages/agent-worker/src/main.ts`
- Modify: `packages/agent-worker/src/bootstrap.ts`
- Modify: `packages/agent-worker/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] Claim only obligations lacking a grant-use/manifest row; transition the mutable claim with a random fence token and require that live token for backoff, operator-attention, release, or acknowledgement. The claim table only avoids duplicate expensive assembly/KMS work and never marks the immutable obligation complete.
- [ ] Rebuild the envelope from the sealed attempt, then call `kernel.invoke("ingest_run_evidence", …)` in-process with the dedicated service principal and matching one-shot grant. Do not add an HTTP route.
- [ ] Add the `evidence-finalizer` entry mode to the shared worker image and run it only in the separately deployed finalizer workload/task role from Task 3. Bootstrap validates service-principal binding, encryption/signing keys, and registered verification material before claiming any obligation; graceful drain releases or expires fenced claims without running executor work.
- [ ] Retry bounded transient KMS/storage/database errors with digest-only error state. Invalid optional producer receipts are omitted with an explicit gap when trusted run/attempt identity remains intact. A core chain-of-custody conflict moves the claim to `operator_attention`, emits a security event, and leaves the obligation pending for audited repair/resume; operator attention is an interim incident state, never successful finalization.
- [ ] Test crashes before assembly, after encrypted blob write, after KMS signing, before transaction commit, and after manifest commit but before acknowledgement, plus stale claim fences and operator repair/resume. Every recoverable path converges to one manifest; any outstanding operator-attention obligation remains a visible launch blocker rather than satisfying the exit criterion.
- [ ] Run `pnpm --filter @oxagen/agent-worker test:unit -- src/evidence-finalizer.test.ts`; expect pass.
- [ ] Commit: `feat(worker): finalize sealed attempts durably`

## Task 7: Add Separately Authorized Replay Read and Export

**Files:**

- Create: `packages/oxagen/src/contracts/read_run_evidence.ts`
- Create: `packages/oxagen/src/contracts/export_run_evidence.ts`
- Create: `packages/oxagen/src/contracts/get_run_evidence_export.ts`
- Create: `packages/oxagen/src/contracts/read_run_evidence_export_chunk.ts`
- Create: `packages/oxagen/src/contracts/read_run_evidence.test.ts`
- Create: `packages/oxagen/src/contracts/export_run_evidence.test.ts`
- Create: `packages/oxagen/src/contracts/get_run_evidence_export.test.ts`
- Create: `packages/oxagen/src/contracts/read_run_evidence_export_chunk.test.ts`
- Create: `packages/handlers/src/read_run_evidence.ts`
- Create: `packages/handlers/src/export_run_evidence.ts`
- Create: `packages/handlers/src/get_run_evidence_export.ts`
- Create: `packages/handlers/src/read_run_evidence_export_chunk.ts`
- Create: `packages/handlers/src/read_run_evidence.test.ts`
- Create: `packages/handlers/src/export_run_evidence.test.ts`
- Create: `packages/handlers/src/get_run_evidence_export.test.ts`
- Create: `packages/handlers/src/read_run_evidence_export_chunk.test.ts`
- Create: `apps/api/src/routes/v1/run-evidence.ts`
- Create: `apps/api/src/__tests__/routes.run-evidence.test.ts`
- Create: `packages/inngest-functions/src/functions/agent.run-evidence-export.ts`
- Create: `packages/inngest-functions/src/functions/agent.run-evidence-export.test.ts`
- Modify: `packages/inngest-functions/src/inngest.ts`
- Modify: `packages/inngest-functions/src/functions.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `packages/handlers/src/register.ts`

- [ ] Make all four capabilities API-only, high sensitivity, default deny, always-IAM-enforced, and separately granted from agent execution. Structural read initially grants org Owner/Admin/Compliance and workspace Owner; exact export/chunk grants only org Owner/Compliance.
- [ ] Return public IDs and RBAC-filtered structural metadata only. Never expose internal UUID, path HMAC, storage key, KMS locator, or ciphertext location.
- [ ] Make export asynchronous. `export_run_evidence` inserts one `rpex_` request with requester/mode/manifest, pending status, current authorization-decision ref, expiry, and an export-specific KMS-wrapped DEK, then emits a best-effort `evidence/run.export.requested` hint. The pending row plus scheduled sweep is durable truth if event sending is lost.
- [ ] Implement the exporter consumer with `FOR UPDATE SKIP LOCKED`, random fence token, expiry/backoff, and deterministic chunk ordinals/digests. Re-check the requester's current principal status and replay grant, persist a new decision, verify the manifest/signature/blob digests, then bundle the signed manifest/JCS body, public verification material, ordered event/receipt metadata, and—only for authorized `content_exact`—verified exact bytes.
- [ ] Encrypt every at-rest export chunk independently under the export DEK/AAD and cap the eventual base64 API response at 1 MiB. `read_run_evidence_export_chunk` reauthorizes, decrypts server-side, verifies the chunk digest, and returns bytes over the authenticated TLS response; clients never receive the KMS-wrapped DEK or a storage locator.
- [ ] Insert an immutable access receipt for each successful read/export/chunk with principal, mode, manifest/export, authorization-decision ref, and time. Denials remain in the authorization-decision ledger.
- [ ] Ensure viewer code verifies signature, event order, and every returned blob digest before display. It never replays external side effects.
- [ ] Test execute-agent without replay grant, workspace member, internal UUID input, cross-tenant access, revocation between request and processing, event-send loss plus scheduled repair, duplicate consumers, stale fence, crash between chunk writes and acknowledgement, retired key material, tampered chunk, request expiry, and structural-only retention.
- [ ] Run `pnpm --filter @oxagen/handlers test:unit -- read_run_evidence export_run_evidence`; expect pass.
- [ ] Run `pnpm --filter @oxagen/api test:unit -- routes.run-evidence.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/inngest-functions test:unit -- src/functions/agent.run-evidence-export.test.ts`; expect pass.
- [ ] Commit: `feat(evidence): add audited replay access`

## Task 7B: Enforce Retention and Append Erasure Receipts

**Files:**

- Create: `packages/oxagen/src/contracts/erase_run_evidence_content.ts`
- Create: `packages/oxagen/src/contracts/erase_run_evidence_content.test.ts`
- Create: `packages/handlers/src/erase_run_evidence_content.ts`
- Create: `packages/handlers/src/erase_run_evidence_content.test.ts`
- Create: `packages/inngest-functions/src/functions/agent.run-evidence-retention.ts`
- Create: `packages/inngest-functions/src/functions/agent.run-evidence-retention.test.ts`
- Modify: `packages/inngest-functions/src/inngest.ts`
- Modify: `packages/inngest-functions/src/functions.ts`
- Modify: `packages/handlers/src/register.ts`
- Modify: `packages/oxagen/capabilities.manifest.json`

- [ ] Register `erase_run_evidence_content` as API-only, destructive/high-sensitivity, default deny, always-IAM-enforced, approval-required, and granted initially only to org Owner/Compliance. Input selects a manifest/content class and reason, never a storage key or KMS locator.
- [ ] Implement one durable erasure request path shared by explicit approvals and the scheduled TTL sweep. It re-resolves the immutable retention policy, current authority, legal-hold state, and exact blob refs before claiming work with a fence token.
- [ ] Crypto-shred the per-blob/export wrapped DEK material and delete ciphertext through the storage adapter where policy requires. Append an immutable erasure receipt and key tombstone with public IDs/digests; never update the signed manifest, blob digest claim, or prior access receipt.
- [ ] Make replay return the structural manifest plus erasure receipts after content removal. It must report exact content unavailable and cannot downgrade a digest mismatch into an erasure.
- [ ] Test TTL expiry, legal hold, denied/manual approval, duplicate requests, stale fence, storage-delete failure after key tombstone, key tombstone before acknowledgement, partial content-class erasure, and replay after erasure.
- [ ] Run `pnpm --filter @oxagen/handlers test:unit -- erase_run_evidence_content.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/inngest-functions test:unit -- src/functions/agent.run-evidence-retention.test.ts`; expect pass.
- [ ] Run `pnpm check:manifest`; expect pass.
- [ ] Commit: `feat(evidence): enforce retention with erasure receipts`

## Task 8: Delete the External Legacy Execution Recorder

**Files:**

- Delete: `packages/oxagen/src/contracts/agent.execution.record.ts`
- Delete: `packages/oxagen/src/contracts/agent.execution.record.test.ts`
- Delete: `packages/handlers/src/agent.execution.record.ts`
- Delete: `apps/api/src/routes/v1/agent.execution.record.ts`
- Delete: `apps/mcp/src/tools/agent.execution.record.ts`
- Delete: `docs/capabilities/agent.execution.record.md`
- Delete: `docs/capabilities/schemas/agent.execution.record.json`
- Create: `packages/database/atlas/migrations/20260806131000_retire_record_execution.sql`
- Create: `packages/database/integration/retire-record-execution.test.ts`
- Modify: `packages/handlers/src/register.ts`
- Modify: `packages/handlers/vitest.config.ts`
- Modify: `packages/oxagen/src/contracts/index.ts`
- Modify: `packages/oxagen/src/contracts.generated.ts`
- Modify: `packages/oxagen/src/contracts.generated.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/__tests__/routes.agent-extended.test.ts`
- Modify: `packages/oxagen/capabilities.manifest.json`
- Modify: `packages/database/storage-manifest.json`
- Modify: `packages/database/atlas/migrations/atlas.sum`
- Modify: `docs/capabilities/_index.md`
- Modify: `docs/cli/eval-runbook.md`
- Modify: `tools/scripts/adr025-name-map.mjs`
- Modify: `tools/scripts/adr025-reland-custom-role-grant-remap.sql`
- Modify: `packages/handlers/src/chat.message.execution.ts`

- [ ] Delete the contract, handler, route/mount, MCP tool, registration, coverage exception, generated artifact, and active docs reference atomically. Delete its existing IAM role grants in the migration.
- [ ] Re-check and renumber the retirement migration after Task 1/PR 1A merges, then hash/validate Atlas with the ledger migrations.
- [ ] Preserve `agent_executions`, `agent_execution_steps`, `agent_tool_calls`, remaining internal legacy readers/writers, and list/read capabilities. Do not alias legacy rows to manifests.
- [ ] Correct the stale `chat.message.execution` comment; its direct legacy writes remain explicitly legacy until separately migrated.
- [ ] Add negative route/discovery tests: API 404, MCP absence, unknown capability, and no manifest-authoring compatibility shim.
- [ ] In the database integration test, seed system and custom role grants for `record_execution`, apply the retirement migration, and prove no durable grant remains while unrelated grants and historical execution rows are untouched.
- [ ] If `pnpm docs:schemas` generates unrelated stale schema-corpus churn, keep that work in a separate atomic schema-realignment PR. Do not obscure this security deletion with hundreds of generated renames.
- [ ] Run `rg -n 'record_execution|agent\.execution\.record' apps packages docs/capabilities`; allow only historical/spec references.
- [ ] Run `pnpm check:manifest`; expect pass.
- [ ] Run `pnpm --filter @oxagen/database test:integration -- integration/retire-record-execution.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/database atlas:validate`; expect pass.
- [ ] Run `pnpm check:ui-parity`; expect pass.
- [ ] Commit: `refactor(agent): retire external execution recording`

## PR 2 Exit Criteria

- [ ] Every sealed attempt—including abandoned and normal terminal seals—converges to exactly one immutable manifest. Pending/backoff/operator-attention rows are observable interim incident states and do not satisfy this exit criterion.
- [ ] Exported structural evidence verifies with public key material independently of the database row that transported it.
- [ ] Duplicate identical finalization is idempotent; any binding/digest conflict fails closed and emits a security event.
- [ ] Exact evidence is encrypted before storage, private/no-overwrite is enforced, and effective-access downgrade cannot create canonical metadata.
- [ ] Replay access is separately granted and audited; executing an agent confers no evidence-read permission.
- [ ] `record_execution` cannot be discovered or invoked, while its historical storage remains honestly legacy.
