# Run Evidence Projection and Provider Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn finalized run evidence and independently fetched GitHub observations into a rebuildable coarse workspace lineage graph and metadata-only audit stream without making Neo4j, ClickHouse, webhook payloads, or branch-local code graphs authoritative.

**Architecture:** Immutable Postgres manifests and provider observations feed separate idempotent delivery workers. The Neo4j projector creates only run/context/artifact/commit/PR/verification/repository-snapshot/domain-level lineage. GitHub webhooks are authenticated wake-up hints; a reconciler re-fetches the configured repository/default ref through the exact connection before recording provider truth or advancing the canonical snapshot. ClickHouse receives bounded audit/telemetry metadata only.

**Tech Stack:** TypeScript 6, PostgreSQL/Drizzle/Atlas, Inngest, Neo4j 5, ClickHouse, GitHub App API, Vitest.

## Global Constraints

- Project finalized, platform-attested manifests only. Pending envelopes, attempt events, client assertions, and mutable delivery rows are not graph inputs.
- PostgreSQL remains the chain-of-custody authority. Neo4j and ClickHouse must be disposable and rebuildable from immutable Postgres rows.
- The workspace graph stores no raw source, path, prompt, frame content, tool payload, model payload, diff, log, embedding, file, symbol, chunk, or branch-local code graph.
- `ContextManifest` is a digest/count projection, not a copy of CGP frames or Stella's compiled context object.
- Feature-branch runs may project provisional `AFFECTS` edges to existing `CodeScope`/`Domain` nodes, but can never advance the canonical repository snapshot.
- Only an authenticated provider read of the configured default ref can advance canonical commit/tree state. A webhook payload alone is never sufficient.
- Repository identity is provider plus immutable provider repository ID. Full name, branch, URL, and PR title are annotations, not identity or authority.
- Provider observations are additive and immutable. They corroborate runner receipts; they never rewrite runner authority or a manifest.
- Domain/scope classification must preserve authority, method, input digest, confidence, and `manifest_id`. `unresolved` produces no false node/edge.
- Do not add a generic graph-write capability, a source-code ingestion worker, a main-branch file graph, or standalone client ingress in this PR.

---

## Task 1: Add Immutable Provider Observations and Reconciliation State

**Files:**

- Create: `packages/database/atlas/migrations/20260806140000_run_evidence_provider_reconciliation.sql`
- Create: `packages/database/integration/run-evidence-reconciliation.test.ts`
- Create: `packages/run-evidence/src/projection.ts`
- Create: `packages/run-evidence/src/projection.test.ts`
- Create: `packages/run-evidence/src/delivery-store.ts`
- Create: `packages/run-evidence/src/delivery-store.test.ts`
- Modify: `packages/database/src/schema/run-evidence.ts`
- Modify: `packages/database/src/schema/ingestion.ts`
- Modify: `packages/database/src/relations.ts`
- Modify: `packages/database/src/types.ts`
- Modify: `packages/database/src/tenant-policy.manifest.ts`
- Modify: `packages/database/src/tenant-policy.manifest.test.ts`
- Modify: `packages/database/src/__tests__/run-evidence-schema.test.ts`
- Modify: `packages/database/atlas/migrations/atlas.sum`
- Modify: `packages/database/storage-manifest.json`
- Modify: `packages/run-evidence/src/index.ts`

- [ ] Write schema tests first for non-authoritative webhook hints, immutable provider observations, provider-observation delivery deduplication/fencing, tenant isolation, and mutable cursors that cannot alter evidence.
- [ ] Create immutable `evidence.github_webhook_hints`: signed delivery ID, tenant/exact connection/versioned binding, bounded normalized event fields/digest, and received time. It is a wake-up receipt with no evidence-authority field and can never satisfy a provider-observation reference.
- [ ] Create `evidence.run_evidence_provider_observations`: `rpo_` public ID, tenant/exact connection/versioned repository binding, provider repository ID, observation kind, immutable ref/commit/tree/PR/check/merge identifiers applicable to the kind, optional source webhook-hint ID, stable observation key/digest, observed/fetched times, and normalized provider-read digest.
- [ ] Constrain authority to `provider_observed`; require commit/tree identities to be exactly 40 or exactly 64 lowercase hex and forbid raw provider payload JSON, tokens, URLs, titles, branch-local file lists, or source content.
- [ ] Enforce a partial unique key on `(connection_id, provider_delivery_id)` only for webhook hints that have a delivery ID. Provider observations, including scheduled/missed-webhook reads, deduplicate by their stable binding/kind/provider-object/ref/commit/tree observation key; same key/same digest is duplicate and same key/different digest is an integrity event.
- [ ] Create immutable `evidence.run_evidence_provider_manifest_links` with observation, finalized manifest, typed relation `corroborates_pr|corroborates_commit|corroborates_verification|observes_default_ref`, and link time. Never update manifest JSON/authority.
- [ ] Create immutable `ingestion.repository_default_ref_observations` with versioned repository binding, exact configured full ref, provider-observed commit/tree, source observation, digest, and observation time.
- [ ] Create mutable `ingestion.repository_default_ref_heads` as a CAS-updated pointer to the newest confirmed observation. It is current-state coordination, not evidence; an out-of-order observation cannot regress it.
- [ ] Create mutable fenced `evidence.run_evidence_provider_deliveries` keyed by `(provider_observation_id, destination)` for `neo4j_canonical|manifest_link_repair`. It carries status, random claim token/expiry, retry schedule, error digest, and delivered time. Default-ref head CAS atomically inserts/retains the canonical projection delivery, so a committed head can never strand its Neo4j update.
- [ ] Implement `claimEvidenceDelivery()` using `FOR UPDATE SKIP LOCKED`, a random fence token, expiry, and bounded exponential backoff. Do not hold a database transaction across Neo4j, ClickHouse, or GitHub calls; stale workers cannot acknowledge.
- [ ] Implement `loadFinalizedProjection(manifestId)` returning a strict allow-listed `FinalizedRunEvidenceProjectionV1`, never raw manifest/envelope JSON. Include only tenant scope, public lineage IDs, status/authority/grade/completeness, digests/counts/times, coarse receipts, classifications, and repository snapshot identities; omit locators and every blob/raw field.
- [ ] Reuse PR 2's independent manifest destination rows for finalized-manifest Neo4j/ClickHouse/reconciliation delivery, and use the new observation-keyed rows for unmatched/default-ref provider projection. Do not add `projected_at` to manifests or observations.
- [ ] Grant `SELECT, INSERT` and explicitly revoke update/delete on observations. Grant narrowly scoped update on reconciliation state.
- [ ] Run `pnpm --filter @oxagen/database test:unit -- src/__tests__/run-evidence-schema.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/run-evidence test:unit -- src/projection.test.ts src/delivery-store.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/database test:integration -- integration/run-evidence-reconciliation.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/database atlas:validate`; expect pass.
- [ ] Commit: `feat(database): add immutable provider observations`

## Task 2: Define the Coarse Workspace Lineage Schema

**Files:**

- Modify: `packages/ontology/src/types.ts`
- Modify: `packages/ontology/src/schema.cypher`
- Create: `packages/ontology/src/run-evidence-projection.ts`
- Create: `packages/ontology/src/run-evidence-projection.test.ts`
- Modify: `packages/ontology/src/types.test.ts`
- Modify: `packages/ontology/src/migrate.test.ts`
- Modify: `packages/ontology/src/index.ts`

- [ ] Add fixed system labels `Run`, `Attempt`, `ContextManifest`, `Artifact`, `Commit`, `PullRequest`, `Verification`, `RepositorySnapshot`, `CodeScope`, and `Domain`; reuse the existing `AgentVersion` label.
- [ ] Add edge constants `HAS_ATTEMPT`, `USED_CONTEXT`, `VERIFIED_BY`, `AFFECTS`, and `BASED_ON`; reuse `EXECUTED` and `PRODUCED`.
- [ ] Add uniqueness/tenant lookup indexes for public IDs and deterministic evidence keys. A commit key includes provider repository ID plus commit SHA; a repository snapshot key includes provider repository ID plus ref/commit/tree.
- [ ] Consume only the `FinalizedRunEvidenceProjectionV1` sanitized DTO from Task 1; destination code has no API that accepts producer envelopes or arbitrary manifest-shaped objects.
- [ ] Implement `projectFinalizedRunEvidence(scopedSession, projection)` as one parameterized Cypher statement so all nodes/edges commit atomically and retry idempotently. Every node has `orgId`, `workspaceId`, `is_system=true`, and `GraphNode`; every derived edge carries `authority`, `manifestId`, and classification input digest where applicable.
- [ ] Project exactly:
  - `AgentVersion -[:EXECUTED]-> Run`
  - `Run -[:HAS_ATTEMPT]-> Attempt`
  - `Attempt -[:USED_CONTEXT]-> ContextManifest`
  - `Attempt -[:PRODUCED]-> Artifact|Commit|PullRequest`
  - `Attempt -[:VERIFIED_BY]-> Verification`
  - `Artifact|Commit -[:AFFECTS]-> CodeScope|Domain`
  - `Run -[:BASED_ON]-> RepositorySnapshot`
- [ ] Store on `ContextManifest` only compiled-manifest/query/template/tokenizer digests plus frame count/citation-conformance counts. Never create a frame node or copy a citation/content string.
- [ ] Implement `projectCanonicalDefaultRef(verifiedProjection)` separately over a branded, strict `VerifiedCanonicalDefaultRefProjectionV1` created by the reconciler only after it verifies provider authority, exact configured ref, and the current Postgres head/fence. `@oxagen/ontology` performs no Postgres read and accepts no raw observation-shaped object.
- [ ] Refuse unknown labels/edge types, unresolved domain/scope IDs, non-final manifests, missing attestation, and any projection property named path/content/prompt/payload/diff/embedding/source code.
- [ ] Test repeated projection, out-of-order delivery, tenant collision, missing scopes, feature-branch provisional impact, and deletion/rebuild from the same projection corpus. Assert exact label/edge/property allowlists.
- [ ] Run `pnpm --filter @oxagen/ontology test:unit -- src/run-evidence-projection.test.ts src/types.test.ts src/migrate.test.ts`; expect pass.
- [ ] Commit: `feat(ontology): add coarse run evidence lineage`

## Task 3: Deliver Finalized Manifests Independently

**Files:**

- Create: `packages/inngest-functions/src/functions/agent.run-evidence-delivery.ts`
- Create: `packages/inngest-functions/src/functions/agent.run-evidence-delivery.test.ts`
- Modify: `packages/inngest-functions/src/inngest.ts`
- Modify: `packages/inngest-functions/src/functions.ts`
- Modify: `packages/inngest-functions/package.json`
- Modify: `packages/run-evidence/src/ledger.ts`
- Modify: `packages/run-evidence/src/ledger.test.ts`
- Modify: `packages/config/src/env.ts`
- Modify: `packages/config/src/env.test.ts`
- Modify: `packages/config/src/registry.ts`
- Modify: `packages/config/src/registry.test.ts`
- Modify: `.env.example` via `pnpm env:check --write`
- Modify: `pnpm-lock.yaml`

- [ ] Register `evidence/run.manifest.finalized` with only org/workspace and manifest public ID as a latency hint. After the PR 2 manifest transaction commits, the ledger sends it best-effort; sending can never roll back acceptance. Add a scheduled repair trigger; pending delivery rows remain durable truth if event sending is lost.
- [ ] Add independent off-by-default flags `RUN_EVIDENCE_NEO4J_PROJECTION_ENABLED`, `RUN_EVIDENCE_CLICKHOUSE_MIRROR_ENABLED`, and `RUN_EVIDENCE_GITHUB_RECONCILIATION_ENABLED`. A disabled destination stays pending; it is never marked skipped/delivered.
- [ ] In this task, implement the consumer and Neo4j destination adapter. Claim each enabled destination only when its adapter is registered, with its own fence token, load/verify the immutable finalized row through tenant scope, and derive the strict sanitized projection object. ClickHouse rows stay pending until Task 4 registers that adapter.
- [ ] Require `evidence_authority = runner_observed` and a finalized attempt seal. Ignore/reject a mutable or unsigned row rather than attempting best-effort projection.
- [ ] Use `scopedSession()` and the dedicated ontology function. Do not call the generic memory `recordExecution()` helper or expose a graph mutation capability.
- [ ] Mark only the matching delivery row success/failure with the live fence token. One destination's failure cannot block another; exhausted rows remain visible while the last complete graph stays active.
- [ ] Test event/cron convergence, disabled flags, tampered attestation, missing manifest, wrong tenant/destination, duplicate event, destination write followed by acknowledgement crash, stale claim token, and replay after graph deletion.
- [ ] Run `pnpm --filter @oxagen/inngest-functions test:unit -- src/functions/agent.run-evidence-delivery.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/run-evidence test:unit -- src/ledger.test.ts`; expect pass, including post-commit event-send loss.
- [ ] Run `pnpm --filter @oxagen/config test:unit -- src/env.test.ts src/registry.test.ts`; expect pass.
- [ ] Run `pnpm env:check`; expect pass.
- [ ] Commit: `feat(evidence): project finalized lineage asynchronously`

## Task 4: Mirror Metadata-Only Audit Events to ClickHouse

**Files:**

- Create: `packages/telemetry/src/migrations/0026_run_evidence_manifests.sql`
- Create: `packages/telemetry/src/run-evidence.ts`
- Create: `packages/telemetry/src/run-evidence.test.ts`
- Modify: `packages/telemetry/src/schema.sql`
- Modify: `packages/telemetry/src/index.ts`
- Modify: `packages/telemetry/src/barrel.test.ts`
- Modify: `packages/telemetry/src/migrate.test.ts`
- Modify: `packages/telemetry/src/migrate-runner.test.ts`
- Modify: `packages/inngest-functions/src/functions/agent.run-evidence-delivery.ts`
- Modify: `packages/inngest-functions/src/functions/agent.run-evidence-delivery.test.ts`

- [ ] Create append-only `run_evidence_manifests` with tenant scope, public manifest/run/attempt/parent/agent-version IDs, provider repository ID, base commit/tree, terminal state, authority/grade/completeness, manifest/envelope/signature digests, public verification-key ID, bounded receipt/event counts, and finalized/mirrored/retention-expiry times.
- [ ] Implement `mirrorFinalizedRunEvidence(dto)` accepting only `FinalizedRunEvidenceProjectionV1`. Use `ReplacingMergeTree(mirrored_at)` keyed by tenant plus manifest ID; readers use `argMax`/`FINAL` where exact deduped counts matter, and TTL derives from pinned retention expiry.
- [ ] Register the ClickHouse destination adapter in `agent.run-evidence-delivery`; pending rows created before this task become claimable when its flag is enabled. Keep destination claiming/acknowledgement behind the same fence-token interface as Neo4j.
- [ ] The writer type and a runtime forbidden-key scan accept no free-form JSON/envelope, path, content, prompt, tool/model payload, diff, log, blob/storage key, URL, or internal UUID.
- [ ] ClickHouse failure changes only its fenced delivery row and never rejects an accepted manifest. Test exact DDL/row allowlists, sensitive sentinel exclusion, replacement key stability, retention TTL, and outage after Postgres commit.
- [ ] Run `pnpm --filter @oxagen/telemetry test:unit -- src/run-evidence.test.ts src/barrel.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/inngest-functions test:unit -- src/functions/agent.run-evidence-delivery.test.ts`; expect pass.
- [ ] Commit: `feat(telemetry): mirror run evidence metadata`

## Task 5: Make GitHub Webhooks Wake Verified Reconciliation

**Files:**

- Modify: `packages/github/src/types.ts`
- Modify: `packages/github/src/fetch-client.ts`
- Create: `packages/github/src/webhook-observation.ts`
- Create: `packages/github/src/webhook-observation.test.ts`
- Modify: `packages/github/src/index.ts`
- Modify: `packages/github/src/__tests__/fetch-client-read.test.ts`
- Modify: `packages/github/src/__tests__/fetch-client.test.ts`
- Modify: `apps/api/src/routes/v1/github-webhook.ts`
- Modify: `apps/api/src/__tests__/github-webhook.test.ts`
- Modify: `packages/inngest-functions/src/inngest.ts`

- [ ] Write a strict pure normalizer for signed `pull_request`, `push`, `check_run|check_suite`, and `status` events. Return only bounded typed delivery/event/action/installation/repository-ID/ref/SHA/PR/check/status/timestamp fields and a normalized digest; never return the raw body.
- [ ] Extend the GitHub client with provider reads for repository snapshot by provider ID, ref → commit/tree, pull request by provider ID/number, merge state, and check conclusions. Each result includes provider repository ID and fetch time.
- [ ] After HMAC verification and JSON parsing, resolve webhook targets by `installation.id` plus payload `repository.id` against normalized repository bindings. Stop routing evidence reconciliation by mutable full name in `deliveryConfig`.
- [ ] After signature verification and binding resolution, insert the immutable non-authoritative webhook hint and register `evidence/github.reconciliation.requested` carrying only tenant/binding and hint public IDs. Require `x-github-delivery`; missing delivery is acknowledged/logged but inserts no hint and creates no provider authority.
- [ ] Emit the reconciliation wake-up independently from existing connector ingestion extraction. A webhook with no ingestable entity records can still require provider reconciliation.
- [ ] Deduplicate GitHub delivery IDs in the hint table. A redelivery wakes the same reconciliation but cannot create or conflict with provider truth; only the later authenticated API read can mint `rpo_`.
- [ ] Test invalid signature, missing delivery ID, repository rename, installation/repository mismatch, multiple repositories per connection, PR merged event, default-ref push, feature-branch push, and no-ingestable-record event.
- [ ] Run `pnpm --filter @oxagen/github test:unit -- src/webhook-observation.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/github test:unit -- src/__tests__/fetch-client-read.test.ts src/__tests__/fetch-client.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/api test:unit -- github-webhook.test.ts`; expect pass.
- [ ] Commit: `feat(github): trigger evidence reconciliation by repository id`

## Task 6: Reconcile Provider Truth and Advance Only the Default Ref

**Files:**

- Create: `packages/inngest-functions/src/functions/agent.run-evidence-reconcile-github.ts`
- Create: `packages/inngest-functions/src/functions/agent.run-evidence-reconcile-github.test.ts`
- Modify: `packages/inngest-functions/src/functions.ts`

- [ ] Validate the tenant/binding and optional webhook hint, resolve the exact versioned repository binding and exact connection token, then re-fetch the applicable repository/ref/PR/check state from GitHub by provider repository ID. No first-connection or PAT fallback is permitted, and no `rpo_` exists before this read succeeds.
- [ ] Canonicalize the authenticated provider-read result, compute its stable observation key/digest, and insert or idempotently reuse the immutable `rpo_`. Link finalized manifests by exact provider repository ID plus provider PR identity or immutable commit SHA; unmatched observations remain available for scheduled repair.
- [ ] Insert immutable default-ref commit/tree observations, CAS `repository_default_ref_heads`, and insert/retain the matching provider-observation delivery in one transaction; never mutate the versioned repository binding or manifest. The delivery worker creates a branded canonical projection only while this observation is still the current head and acknowledges with its live fence.
- [ ] For feature-branch push or open/unmerged PR, record corroborating observations and provisional lineage only. Never update the canonical repository snapshot or infer merge from branch names.
- [ ] On a merged PR, fetch and insert/link the exact PR/merge observation to the run immediately. Independently resolve the configured default ref; advance/project the canonical snapshot only after that read observes the merge result at the default ref. Until then retain a pending canonical-advancement gap without withholding the merge link.
- [ ] Add a scheduled repair branch over webhook hints, unmatched observations, manifest reconciliation rows, and provider-observation deliveries, covering webhook-before-manifest, manifest-before-webhook, missed webhooks, duplicates, projection-after-CAS failure, and eventual-consistency races.
- [ ] Preserve the prior complete canonical snapshot on token outage, rate limit, deleted repository, force-push ambiguity, or incomplete checks; record typed retry/quarantine state.
- [ ] Test default branch renamed away from `main`, squash/rebase merge, merge webhook before ref visibility, force push, deleted branch, installation revocation, duplicate event, missed webhook sweep, and feature branch that shares a commit with default ref but was not provider-resolved there.
- [ ] Run `pnpm --filter @oxagen/inngest-functions test:unit -- src/functions/agent.run-evidence-reconcile-github.test.ts`; expect pass.
- [ ] Commit: `feat(evidence): reconcile GitHub provider truth`

## Task 7: Prove Store Boundaries and Rebuildability

**Files:**

- Create: `packages/inngest-functions/src/functions/run-evidence-boundary.integration.test.ts`
- Modify: `docs/specs/workspace-graph-boundary/spec.md`
- Modify: `docs/specs/run-evidence-ingress/plan.md`

- [ ] Seed completed default-ref, completed feature-branch, denied, failed, abandoned, and merged-PR manifests plus provider observations; project them into empty Neo4j/ClickHouse test stores.
- [ ] Snapshot the exact Neo4j labels, properties, and relationships and ClickHouse columns/values. Assert forbidden raw/source/path/content fields are absent.
- [ ] Delete only derived Neo4j/ClickHouse test data, replay immutable Postgres inputs, and deep-compare the rebuilt projections.
- [ ] Prove a feature branch cannot move canonical `RepositorySnapshot`; prove a provider-observed default-ref commit/tree can.
- [ ] Prove projector or reconciliation failure leaves the manifest, provider observation, and previously active canonical snapshot intact.
- [ ] Update the boundary spec to name this coarse projection as the launch graph. Explicitly retain checkout-local file/symbol code graphs in Stella and leave a future default-ref topology extractor outside this PR.
- [ ] Run `pnpm --filter @oxagen/inngest-functions test:unit -- src/functions/run-evidence-boundary.integration.test.ts`; expect pass against the test-store harness.
- [ ] Commit: `test(evidence): prove projection store boundaries`

## PR 4 Exit Criteria

- [ ] Neo4j contains only the approved coarse lineage nodes/edges and can be rebuilt from immutable Postgres evidence.
- [ ] ClickHouse contains bounded metadata/audit fields only and is never a replay authority.
- [ ] Webhooks are authenticated wake-up hints; provider truth comes from an exact-connection GitHub read.
- [ ] Feature branches can show provisional domain impact but cannot advance canonical state.
- [ ] The configured default ref advances only to a provider-observed commit/tree, including after a separately verified PR merge.
- [ ] No file/symbol/chunk/main-branch source graph or generic graph mutation surface is introduced.
