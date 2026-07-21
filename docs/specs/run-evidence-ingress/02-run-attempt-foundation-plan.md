# Run, Attempt, and Authorization Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every governed run a trusted immutable admission record, every worker claim a fenced attempt identity, every event an unambiguous order, and every operation a persisted authorization decision constrained by the admission-time grant ceiling and current denies.

**Architecture:** `RunSpecV2` is built only by trusted server code and duplicated into typed security columns. PostgreSQL claims create immutable attempts plus mutable fenced leases. Events and checkpoints append atomically with run-global and attempt-local sequences. Admission pins the human ∩ agent grant ceiling; indexed deny generations and live status checks can only narrow it. Every attempt seal atomically creates a capability-limited one-shot finalization grant and immutable outbox obligation.

**Tech Stack:** TypeScript 6, Zod 3, PostgreSQL/Drizzle/Atlas, Vitest, durable worker, Inngest, Oxagen IAM and capability kernel.

## Global Constraints

- Request bodies never contain serialized `RunSpecV2` or trusted actor, repository, authorization, retention, or engine fields.
- A run row stores typed identity columns in addition to JSON; admission, worker hydration, and finalization compare them and fail on disagreement.
- Internal UUIDs remain internal. Public contracts use `arun_`, `arat_`, `rpb_`, `ras_`, `azd_`, and `afg_` identifiers.
- Every claim creates a new attempt before model/tool work. An expired, fenced, or sealed attempt can never append, checkpoint, renew, or terminate.
- `run_seq` is PostgreSQL-assigned and monotonic across attempts. `attempt_seq` is producer-assigned and resets to 1 for a new attempt.
- Append events, insert the matching immutable checkpoint, and advance lease/run pointers in one transaction.
- Identical sequence plus digest is idempotent. Same sequence plus a different digest is a security event and hard error.
- Evidence tables grant the application role `SELECT, INSERT`, never `UPDATE, DELETE`. Operational lease state is the exception and still denies delete.
- A finalization grant encodes authority only for `ingest_run_evidence`, one sealed attempt, and its committed digests. Mint it for every seal, including normal terminal outcomes. It has no operational expiry; PR 2 enforces one successful consumption with the grant-use row.
- Existing V1 history is never backfilled with invented principals or repository authority. Drain already-enqueued V1 code-mode work, reject new V1 admission on governed code-mode surfaces, and preserve explicitly labeled legacy non-evidence V1 rows/reads until later migration or retention cleanup.
- V2 execution claims remain disabled until PR 2B deploys finalization consumption, the evidence ledger, and the obligation worker. Expansion alone cannot create obligations that no deployed worker can satisfy.
- Re-check the latest Atlas migration immediately before implementation and renumber the migration filenames if main advanced.

---

## Reviewable PR Decomposition

| PR | Tasks | Dependency | Merge result |
|---|---|---|---|
| 1A | Tasks 1–5 plus Task 6 compatibility work, excluding the contract migration | PR 0B for shared digest/contract primitives | Expand-only schema, dual V1/V2 readers and workers, fenced attempts, immutable grant issuance, authorization snapshots, and live denies exist while V1 work can still drain |
| 1B | Task 6 drain assertion, code-mode cutover, and contract migration | PR 1A + PR 2B | Zero nonterminal V1 code-mode rows is proven, new V1 code-mode admission is impossible, and V2 claims may be enabled without stranding finalization |

PR 1A must deploy before any drain. PR 1B is deliberately post-PR 2B: it cannot enable V2 execution until finalization consumption exists. Unrelated explicitly non-evidence V1 surfaces retain their centralized legacy parser and claim path until a later compatibility cleanup.

---

## Task 1: Define Strict Trusted Admission Contracts

**Files:**

- Create: `packages/agent-runner/src/run-spec-v2.ts`
- Create: `packages/agent-runner/src/run-spec-v2.test.ts`
- Create: `packages/agent-runner/src/run-errors.ts`
- Modify: `packages/agent-runner/src/index.ts`
- Modify: `packages/agent-runner/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] Write parser tests first for every unknown field, malformed digest, internal/public ID confusion, unpinned repository field, non-sandbox workspace, invalid engine version, and caller-provided trusted binding.
- [ ] Define strict Zod schemas for `RunSpecV2` with trusted `run_kind: "general" | "repo_edit"` and the exact sections in `spec.md`: `engine_policy`, `actor_binding`, `authorization_snapshot_ref`, `repository_binding`, `workspace_policy`, `context_policy`, `tool_policy`, and `output_policy`.
- [ ] Export branded `Sha256Digest`, decimal generation, repository-binding, and authorization-snapshot reference types. Validate `sha256:<64 lowercase hex>` at every boundary.
- [ ] Implement `parseRunSpecV2(raw)` for persisted trusted data and `buildTrustedRunSpecV2(input)` for server-resolved inputs. Keep goal/preferences in a separate caller-influence object so they cannot be spread into trusted fields.
- [ ] Require `workspace_policy.sandbox_required === true`, an immutable `repository_binding_public_id` plus base commit/tree, exact agent version checksum, trusted `engine_policy.max_attempts`, immutable retention-policy public ID plus digest, and an admission deny-generation vector.
- [ ] Test canonical spec digest generation and row/spec identity comparison helpers.
- [ ] Run `pnpm --filter @oxagen/agent-runner test:unit -- src/run-spec-v2.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/agent-runner typecheck`; expect pass.
- [ ] Commit: `feat(runner): define trusted run spec v2`

## Task 2: Expand the PostgreSQL Run and IAM Model

**Files:**

- Create: `packages/database/atlas/migrations/20260806100000_run_attempt_foundation_expand.sql`
- Create: `packages/database/atlas/migrations/20260806110000_agent_run_authorization_foundation.sql`
- Create: `packages/database/integration/run-attempt-foundation.test.ts`
- Create: `packages/database/integration/authorization-foundation.test.ts`
- Create: `packages/database/src/schema/run-evidence-foundation.ts`
- Modify: `packages/database/src/schema/_schemas.ts`
- Modify: `packages/database/src/schema/agent.ts`
- Modify: `packages/database/src/schema/iam.ts`
- Modify: `packages/database/src/schema/ingestion.ts`
- Modify: `packages/database/src/schema/index.ts`
- Modify: `packages/database/src/relations.ts`
- Modify: `packages/database/src/types.ts`
- Modify: `packages/database/src/tenant.ts`
- Modify: `packages/database/src/tenant.test.ts`
- Modify: `packages/database/src/tenant-policy.manifest.ts`
- Modify: `packages/database/src/tenant-policy.manifest.test.ts`
- Modify: `packages/database/src/__tests__/schema-append-only.test.ts`
- Modify: `packages/database/src/__tests__/schema-smoke.test.ts`
- Modify: `packages/database/storage-manifest.json`
- Modify: `packages/database/atlas/migrations/atlas.sum`

- [ ] Write integration tests first for tenant isolation, composite scope foreign keys, immutability grants, fence enforcement, partial V1/V2 constraints, and same-transaction seal/grant/obligation creation.
- [ ] Expand `agent.agent_runs` with `spec_version`, trusted `run_kind`, spec digest, initiating/agent principals, agent/version/checksum, authorization snapshot, parent run, immutable repository-binding ID plus provider/repository/connection/ref/commit/tree copies, immutable retention-policy ID/digest, trusted maximum attempts, active attempt, latest checkpoint, attempt count, and next run sequence. For preserved V1 rows, use a conditional constraint; every V2 row requires the complete typed set.
- [ ] Add a `BEFORE UPDATE` trigger for V2 rows that rejects changes to tenant scope, spec/spec digest, actor/version/snapshot/repository/retention bindings, parent, and engine/attempt policy. Allow only operational status/result/error/cancellation, active-attempt/latest-checkpoint pointers, counters, and lifecycle timestamps.
- [ ] Create immutable, versioned `ingestion.repository_bindings` with `rpb_` public ID, tenant scope, source connection, provider, immutable provider repository ID, provider-observed owner/name/full name, exact configured default ref, observation time, version, and optional superseded-binding reference. A rename/default-ref reconfiguration inserts a new version; it never edits an admitted binding.
- [ ] Create mutable `ingestion.repository_binding_heads` keyed by connection/provider repository ID and `ingestion.governed_repository_selections` with exactly one current primary binding per governed connection. Security admission follows the explicit primary pointer and never reads identity from `deliveryConfig`; multiple repositories with no primary selection fail closed.
- [ ] Create immutable `agent.agent_run_attempts`: `arat_` public ID, scoped run, attempt number, worker, claim time, resolved engine name/version/build-or-image digest, optional complete restore tuple, and unique `(run_id, attempt_number)`.
- [ ] Create mutable `agent.agent_run_attempt_leases`: attempt, opaque token, epoch, worker, expiry/renewal/fence, last sequences, final event digest, and stream digest. Enforce one lease per attempt and unique `(run_id, lease_epoch)`.
- [ ] Add `event_record_version smallint`, backfill existing rows to `1`, and make legacy `seq/type/payload` columns nullable only as required for the V2 shape. The conditional CHECK is explicit: V1 rows require legacy `seq/type/payload` and all V2-only fields null; V2 rows require attempt, `run_seq`, `attempt_seq`, schema/type/stage, payload/event digests, exactly one of inline payload or encrypted reference, and observed/recorded times, with legacy `seq` null. Use partial unique indexes for V1 `(run_id, seq)`, V2 `(run_id, run_seq)`, and V2 `(attempt_id, attempt_seq)` so a V2 row can never be interpreted as legacy.
- [ ] Create immutable `agent.agent_run_checkpoints` bound to the final event in the same append: attempt/run sequence, engine-state schema, checkpoint/stream digests, encrypted reference.
- [ ] Create immutable `agent.agent_run_attempt_seals`: terminal status, reason, final sequences/digests, sealer kind/worker, time, unique attempt.
- [ ] Create immutable `agent.agent_run_finalization_grants` and `agent.agent_run_finalization_obligations`. The `afg_` grant public ID is copied as the obligation's stable `submission_id`; it has no operational expiry. Obligation pending state is derived by anti-joining PR 2's grant-use/manifest row, never by mutating `processed_at`.
- [ ] Create immutable `evidence.retention_policy_versions` with public ID, tenant scope, monotonically increasing version, `digest_only|content_exact|environment_restore` mode, retained content-class allowlist, TTL, environment-restoration rule, canonical policy digest, and creation time. Admission pins one exact public ID/digest; policy edits insert a new version.
- [ ] Create immutable `iam.authorization_snapshots` with `ras_` public ID, both principals, a canonical ceiling that preserves assignment IDs, role IDs, conditions, resource scopes, and each assignment/grant expiry, ceiling/snapshot digests, org/workspace deny-generation vector, next validity boundary, and resolution time.
- [ ] Create typed mutable `iam.emergency_denies` for active org/workspace capability or resource-scope denies and mutable `iam.authorization_deny_generations` for org/workspace scopes. Fixed-search-path, security-definer triggers increment the generation in the same transaction as principal status/deletion, PRA, role grant/role, or emergency-deny mutation; revoke public execution. `oxagen_app` receives `SELECT` only on generations and cannot decrement/reset them directly.
- [ ] Create immutable `iam.authorization_decisions` with `azd_` public ID, capability/request/actor/scope, optional complete run bindings, generation vector, outcome/reason/approval, input/trace/decision digests, and decision time.
- [ ] Revoke `UPDATE, DELETE` from attempts, V2 events, checkpoints, seals, finalization grants/obligations, authorization snapshots, and decisions. Grant only the narrowly required lease and generation updates. Add tests that inspect actual database privileges.
- [ ] Add a repeatable-read tenant transaction helper used only for admission snapshot construction so grant rows and generation values share one MVCC snapshot.
- [ ] Keep V1 columns, parser compatibility, and conditional legacy reads/claims while queued V1 runs drain. This task is expand-only: it does not apply the post-drain contract migration, revoke authority needed by queued work, or fabricate V2 columns for historical rows.
- [ ] Run `pnpm --filter @oxagen/database test:unit -- src/__tests__/schema-append-only.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/database test:integration -- integration/run-attempt-foundation.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/database test:integration -- integration/authorization-foundation.test.ts`; expect pass.
- [ ] Run `pnpm schema:manifest`; regenerate `packages/database/storage-manifest.json` from the canonical schema/capability registry.
- [ ] Run `pnpm schema:manifest:check`; expect pass.
- [ ] Run `pnpm --filter @oxagen/database atlas:validate`; expect pass.
- [ ] Commit: `feat(database): add fenced run attempt foundation`

## Task 3: Make the Run Store Attempt-Aware and Transactional

**Files:**

- Create: `packages/agent-runner/src/finalization-grant.ts`
- Create: `packages/agent-runner/src/event-payload-registry.ts`
- Create: `packages/agent-runner/src/event-payload-registry.test.ts`
- Modify: `packages/agent-runner/src/run-store.ts`
- Modify: `packages/agent-runner/src/run-store.test.ts`
- Modify: `packages/agent-runner/src/index.ts`
- Modify: `packages/agent-worker/src/types.ts`
- Modify: `packages/agent-worker/src/seq.ts`
- Create: `packages/agent-worker/src/seq.test.ts`

- [ ] Replace the run-only lease type with `RunLeaseRef { runId, attemptId, attemptPublicId, leaseToken, leaseEpoch }` and return it from `claimNextRun`.
- [ ] Implement `enqueueRunV2` as a transaction that verifies every typed column against the parsed spec and inserts the pending `agent_runs` row. That row is the durable queue truth; do not invent an undefined scheduling outbox and do not expose trusted fields to request bodies.
- [ ] Split claims explicitly into `claimNextRunV2()` and retained `claimLegacyV1()`. The V2 path locks one eligible run, resolves and pins engine name/version/build digest, creates a distinct attempt, increments attempt/lease epoch, inserts the lease, selects a valid prior checkpoint if policy permits, and returns the complete restore reference. The compatibility dispatcher keeps already-enqueued/unrelated V1 work claimable until its later retirement.
- [ ] Implement `appendAttemptBatch({ lease, events, checkpoint? })`. Lock and validate the active lease, require contiguous attempt sequences, allocate run sequences, insert events, insert the checkpoint, and advance pointers/digests in one transaction.
- [ ] Define an exact event-type → strict payload schema/data-classification registry. V2 inline payloads are allow-listed receipt metadata only, capped at 32 KiB after JCS, and reject recursive raw `path`, `uri`, `source`, `content`, `prompt`, `diff`, `stdout`, `stderr`, model/tool body, credential, or embedding fields; those values must be encrypted blobs referenced by public ID. Unknown event types fail before SQL.
- [ ] Compute `event_digest` over canonical attempt sequence, schema, type, stage, payload digest, and observed time. Compute `event_stream_digest` over the spec-defined ordered tuple only.
- [ ] On an existing attempt sequence, compare digest: return the prior row/run sequence if identical; throw `RunEventIntegrityError` and append `agent_run.event_sequence_conflict` through the security-event sink if different. Remove `ON CONFLICT DO NOTHING`.
- [ ] Make renew, append, checkpoint, cancel check, and seal require matching attempt/token/epoch, unexpired lease, no fence, and no seal.
- [ ] Implement `sealAttempt` for worker-observed terminal paths to append/validate the terminal event, fence the lease, insert the immutable seal, non-expiring one-shot finalization grant, and finalization obligation atomically. Copy the grant's `afg_` public ID into the obligation as the stable `submission_id`; return the sealed attempt handle.
- [ ] Implement a distinct reclaimer-only zero-event seal path. When no event was accepted it records `event_count = 0`, nullable final-event digest, and the canonical empty stream digest without synthesizing a terminal event. `reclaimExpiredAttempts` uses that or the last accepted event as applicable, creates a successor only when `attempt_count < max_attempts`, and otherwise marks the run failed after sealing the final attempt. Never reuse an old attempt or retry without a pinned bound.
- [ ] Test the V1/V2 discriminant and readers, zero-event abandoned attempts using a canonical empty-event sentinel, stable submission ID, non-expiring grant issuance, resolved engine/build identity, retry-cap exhaustion, normal-terminal crash recovery, restored checkpoint provenance, concurrent claims, renewal at expiry, rollback on checkpoint failure, and decimal-string SSE sequences.
- [ ] Run `pnpm --filter @oxagen/agent-runner test:unit -- src/run-store.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/agent-runner test:unit -- src/event-payload-registry.test.ts`; expect pass with forbidden-content sentinels.
- [ ] Run `pnpm --filter @oxagen/agent-worker test:unit -- src/seq.test.ts`; expect pass.
- [ ] Commit: `feat(runner): fence events to immutable attempts`

## Task 4: Adopt Attempts in the Worker and Lease Sweeper

**Files:**

- Modify: `packages/agent-worker/src/worker.ts`
- Modify: `packages/agent-worker/src/worker.test.ts`
- Modify: `packages/agent-worker/src/main.ts`
- Modify: `packages/inngest-functions/src/functions/agent.lease-sweep.ts`
- Modify: `packages/inngest-functions/src/functions/agent.lease-sweep.test.ts`
- Modify: `packages/inngest-functions/src/functions.ts`

- [ ] Change worker IO to buffer a contiguous attempt batch and optional checkpoint, then call `appendAttemptBatch` once. Remove separate event-flush and checkpoint-save operations.
- [ ] Stamp every emitted event with one of the nine evidence stages and a precomputed payload digest. Large/sensitive payloads arrive as encrypted references, not unbounded JSON.
- [ ] Stop execution immediately when lease renewal, append, or live cancellation reports a fence. The old attempt may perform no cleanup mutation beyond local process shutdown.
- [ ] Seal every completed, denied, failed, and cancelled attempt through `sealAttempt`; do not invoke evidence finalization directly from an unfenced worker path.
- [ ] Replace lease-sweeper SQL with `reclaimExpiredAttempts`. Verify it seals and enqueues finalization before a successor can claim the run.
- [ ] Make finalization obligations independently schedulable/retryable so a worker crash after any seal cannot strand evidence.
- [ ] Test event/checkpoint rollback, lost lease during model/tool, cancellation before the next operation, abandoned attempt followed by restored successor, and duplicate sweeps.
- [ ] Run `pnpm --filter @oxagen/agent-worker test:unit -- src/worker.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/inngest-functions test:unit -- src/functions/agent.lease-sweep.test.ts`; expect pass.
- [ ] Commit: `feat(worker): execute through fenced attempt io`

## Task 5: Pin the Grant Ceiling and Refresh Live Denies

**Files:**

- Create: `packages/iam/src/authorization-snapshot.ts`
- Create: `packages/iam/src/authorization-snapshot.test.ts`
- Create: `packages/iam/src/live-agent-run-authorization.ts`
- Create: `packages/iam/src/live-agent-run-authorization.test.ts`
- Modify: `packages/iam/src/fetch-agent-authz.ts`
- Modify: `packages/iam/src/fetch-agent-authz.test.ts`
- Modify: `packages/iam/src/check-iam.ts`
- Modify: `packages/iam/src/check-iam.agent.test.ts`
- Modify: `packages/iam/src/agent-run-context.ts`
- Modify: `packages/iam/src/agent-run-context.test.ts`
- Modify: `packages/iam/src/index.ts`
- Modify: `packages/oxagen/src/iam/agent-run.ts`
- Modify: `packages/oxagen/src/iam/agent-run.test.ts`
- Modify: `packages/oxagen/src/types.ts`
- Modify: `packages/oxagen/src/kernel.ts`
- Modify: `packages/oxagen/src/kernel.test.ts`
- Modify: `packages/oxagen/src/kernel.tenant-scope.test.ts`
- Modify: `packages/compliance/src/security-event-types.ts`
- Modify: `packages/compliance/src/security-event-types.test.ts`
- Create: `packages/database/atlas/migrations/20260806115000_agent_run_authorization_security_events.sql`
- Modify: `packages/database/atlas/migrations/atlas.sum`

- [ ] Write snapshot tests first. Bind the authenticated initiating principal, not `agent.parentUserId`, and canonicalize the exact human ∩ agent ceiling plus assignment/role IDs, resource scopes, conditions, and per-binding expiries.
- [ ] Define a kernel-created `DeployedAgentInvocationContext` for pre-run agent surfaces. It binds an authenticated initiating human to a server-resolved active deployed agent/version/checksum but carries no caller-supplied run ID. Ordinary human/API/MCP contexts cannot construct it.
- [ ] Implement `createAgentRunAuthorizationSnapshot` in a repeatable-read tenant transaction. Preserve the original ceiling inputs and compute the next per-capability validity boundary; never flatten them into an allowlist that can be refreshed from later grants.
- [ ] Implement `createChildRunAuthorizationSnapshot(parentSnapshotId, narrowingPolicy, liveState)` as `still-valid parent ceiling ∩ current live authority ∩ child narrowing`. It never snapshots current grants afresh and cannot outlive or widen the parent.
- [ ] Replace `AgentRunIAMContext.resolution` with immutable actor/snapshot/ceiling bindings plus a live cache keyed by generation vector, capability, resource-scope digest, client IP, and the exact next validity boundary.
- [ ] On every context/model/tool/kernel boundary, read live principal/agent status, emergency-deny state, and generation values. Re-evaluate the pinned side against its original assignment conditions/expiries, then intersect it with freshly resolved live authority. A later or replacement grant can never revive an expired member of the pinned ceiling.
- [ ] Apply deny-wins semantics. A suspension, revocation, pinned expiry, or emergency deny narrows before the next operation. Any refresh failure denies.
- [ ] Persist one immutable `authorization_decision` for allow, deny, approval-pending, and evaluation error. Successful checks attach its platform-created reference only to checked context; deny/pending/error return the reference on the typed kernel result or `CapabilityError`, and the worker persists it in the denial/terminal event.
- [ ] Never accept a decision reference from caller `CapabilityContext`. Agent-run execution fails closed if the authoritative decision row cannot be inserted. PR 1 issues finalization grants but does not create their kernel authentication/consumption context; that lands with `ingest_run_evidence` in PR 2.
- [ ] Extend security-event taxonomy with event-sequence conflict, forged decision reference, stale deny generation, and finalization-grant misuse.
- [ ] Run `pnpm --filter @oxagen/iam test:unit -- src/authorization-snapshot.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/iam test:unit -- src/live-agent-run-authorization.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/iam test:unit -- src/check-iam.agent.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/oxagen test:unit -- src/iam/agent-run.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/database atlas:validate`; expect pass with the additive security-event migration; do not edit a migration already validated by Task 2.
- [ ] Commit: `feat(iam): enforce pinned ceilings with live denies`

## Task 6: Cut Over Trusted Workers Without Fabricating V1 Authority

**Files:**

- Create: `packages/agent-runner/src/run-spec-v1-legacy.ts`
- Create: `packages/agent-runner/src/run-spec-v1-legacy.test.ts`
- Modify: `packages/agent/src/types.ts`
- Modify: `packages/agent/src/runtime/turn-driver.ts`
- Modify: `packages/agent/src/runtime/turn-driver.test.ts`
- Modify: `apps/api/src/routes/v1/agent.run.ts`
- Modify: `apps/api/src/__tests__/routes.agent-run.test.ts`
- Modify: `packages/config/src/env.ts`
- Modify: `packages/config/src/env.test.ts`
- Modify: `packages/config/src/registry.ts`
- Modify: `packages/config/src/registry.test.ts`
- Modify: `.env.example` via `pnpm env:check --write`
- Create: `packages/database/atlas/migrations/20260806120000_run_attempt_foundation_contract.sql`
- Modify: `packages/database/src/__tests__/schema-smoke.test.ts`
- Modify: `packages/database/atlas/migrations/atlas.sum`
- Modify: `packages/database/storage-manifest.json`

- [ ] Hydrate worker `CapabilityContext.agentRun` from typed run/attempt/snapshot columns and assert it matches the parsed V2 spec before any engine materialization.
- [ ] Centralize the retained parser as `run-spec-v1-legacy.ts`; remove only duplicate definitions from the turn driver/API. Keep `claimLegacyV1()` and legacy execution for already-enqueued and explicitly non-evidence V1 work until the later all-V1 compatibility retirement.
- [ ] Split admission from reads: keep `OXAGEN_DURABLE_RUNS` as the GET/status/SSE/cancel mount gate, add a method-level `OXAGEN_V1_RUN_ADMISSION_ENABLED` gate for legacy POST admission, and add an off-by-default `OXAGEN_RUN_V2_CLAIMS_ENABLED` worker gate. Disabling new V1 writes must never remove historical reads or make queued rows unclaimable.
- [ ] In PR 1A, deploy the dual reader/worker and set the V1 code-mode POST gate off while leaving V1 claims on. Query and record pending/running V1 `run_kind = repo_edit` or legacy `surface = repo-edit` rows, then drain or administratively cancel them through the existing audited path; do not convert them to V2.
- [ ] In PR 1B, make the contract migration begin with a `DO` assertion that zero nonterminal V1 code-mode/repository-edit rows remain. Only then install the database guard rejecting new V1 governed code-mode inserts. Preserve unrelated V1 inserts/claims and all historical rows; do not revoke privileges they still need or fabricate V2 authority.
- [ ] Enable `OXAGEN_RUN_V2_CLAIMS_ENABLED` only after PR 2B's append-only privilege tests, grant-use transaction, evidence ledger, and finalization-obligation worker are deployed and healthy.
- [ ] Test row/spec mismatch, missing initiating principal, missing agent version, wrong tenant, V1 code-mode method-gate rejection, reads while admission is off, queued V1 claim/drain, contract migration refusal with one nonterminal code-mode row, explicitly legacy non-evidence V1 behavior, V1 historical SSE using `seq`, V2 SSE using decimal `run_seq`, and V2 agent-run context hydration.
- [ ] Run `pnpm --filter @oxagen/agent test:unit -- src/runtime/turn-driver.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/api test:unit -- routes.agent-run.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/agent-runner test:unit -- src/run-spec-v1-legacy.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/database test:unit -- src/__tests__/schema-smoke.test.ts`; expect pass.
- [ ] Run `pnpm schema:manifest && pnpm schema:manifest:check`; expect pass.
- [ ] Run `pnpm --filter @oxagen/database atlas:validate`; expect pass only after the zero-row contract precondition fixture succeeds.
- [ ] Commit: `refactor(runner): admit only trusted run spec v2`

## PR 1 Exit Criteria

- [ ] Every V2 claim has a distinct immutable attempt and active fenced lease.
- [ ] Event order is unambiguous across retries, and an event/checkpoint transaction cannot tear.
- [ ] Every attempt seal creates one immutable finalization grant and obligation in the seal transaction.
- [ ] The application database role cannot update or delete evidence-bearing foundation rows.
- [ ] Every governed operation persists an authorization decision and checks the pinned ceiling plus current status/deny generation.
- [ ] New V1 governed code-mode admission is impossible after PR 1B; queued V1 work was drained before the contract guard, any retained unrelated V1 surface is explicitly non-evidence, and historical V1 rows remain honestly labeled/readable.
