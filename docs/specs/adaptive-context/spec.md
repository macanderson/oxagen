# Oxagen Context Exchange Provider (adaptive context, platform side)

> **Normative home: Context Graph Protocol (CGP).** This is Oxagen's *provider*
> spec. The wire contract — record/frame semantics, capabilities, temporal and
> provenance semantics, and the operation/error vocabulary — is owned normatively
> by the Context Graph Protocol (`macanderson/context-graph-protocol`), not by
> this directory. Oxagen implements the open provider contract; nothing
> Oxagen-specific leaks into wire semantics (§2). See CGP
> `docs/adr/0007-protocol-product-boundary.md` and
> `docs/adaptive-context-reconciliation.md`
> ([context-graph-protocol#27](https://github.com/macanderson/context-graph-protocol/issues/27)).
> The protocol is **Context Graph Protocol (CGP)** / `contextgraph/*`; the "CGEP"
> / `cgep/*` naming once proposed here is rejected (CGP ADR 0007 §5).

Status: implementation draft
Target: oxagen-platform (this repository)
Fleet plan: `docs/specs/adaptive-context/fleet.toml`

## 1. Sources and reading order

This directory holds the canonical adaptive-context bundle (2026-07-20 Codex
outputs) plus this platform-side spec. Authority order for the platform work:

1. **Normative for wire semantics**: `context-graph-protocol-build-prompt.md`
   — the CGP operations, record envelope, receipt/idempotency/retention
   semantics, capability advertisement, and the typed error vocabulary the
   provider must serve.
2. **Normative for record meaning**: `stella-adaptive-context-lifecycle.md` —
   the ContextRecord taxonomy, scope vs sharing, temporal semantics,
   provenance/attestation (§7.7), workspace publication (§13.4), and the
   Stella↔protocol↔Oxagen deployment model (§5.3).
3. **Context only (other repos' work)**: `adaptive-context-implementation-plan.md`
   and `stella-adaptive-context-build-prompt.md` target `macanderson/stella`;
   the protocol build prompt targets `macanderson/context-graph-protocol`.
   Nothing in this platform plan edits those repos.
4. **Superseded early drafts (informative)**: `context-frame-spec.md` and
   `directive-schema.md`. Where they conflict with the lifecycle spec (e.g.
   `memory`/`fact` as directive kinds, a portable `project_id`), the lifecycle
   spec wins.

## 2. Position in the deployment model

Per lifecycle spec §5.3: Stella is a complete local/BYOK learning system;
CGP is the neutral exchange protocol; Oxagen is **one optional commercial
provider and control plane** implementing the same open provider contract —
durable workspace identity and membership, RBAC, organization policy
inheritance, audit, retention, and enterprise integrations.

Binding consequences:

- Nothing Oxagen-specific may leak into wire semantics; a non-Oxagen provider
  must remain implementable from the same documents.
- Provider ACLs narrow what a principal may see or do; they never grant a
  record greater semantic or instruction authority (membership alone is not
  authority).
- The provider receives already-created canonical records. It never computes
  Stella's promotion, confidence, mining, or governance policy.
- No portable "sync" claims: v1 is export (append) and provider retrieval
  (get/query/resolve) only. Cursors, ordered change feeds, tombstones, and
  offline replay are explicitly out of scope until CGP defines them.

## 3. v1 scope

**In**: the four CGP operations as kernel capabilities + an HTTP wire
surface; the multi-tenant canonical record store; the ingestion and
idempotency ledgers with receipt replay; retention negotiation and
enforcement; workspace publication with RBAC approval, attestation, audit,
and revocation; ContextExportManifest acceptance; ed25519 receipt/publication
attestations; a wire-level conformance test suite.

**Out (deferred, with owners)**: semantic `context/query` depth beyond
filtered/temporal listing (engram bridge follow-up; see §9); running the Rust
`contextgraph-conformance` suite against the HTTP endpoint (gated on the
protocol repo shipping the lifecycle capability); Neo4j provenance graph
projection; encrypted multi-device sync (product-specific, outside CGP);
any Stella-side work (its own fleet plan, stella PR #257).

## 4. Architecture mapping

| Concern | Where it lives |
| --- | --- |
| Domain logic (validation, hashing, append/receipt semantics, retention, attestation) | new package `packages/context-exchange` |
| Canonical record + ledger tables | `packages/database/src/schema/context-exchange.ts` (new `context_exchange` pgSchema) + one Atlas migration |
| Capabilities (IAM/audit/tenancy for free) | contracts in `packages/oxagen/src/contracts/`, handlers registered via `packages/handlers/src/register.ts`, all invocation through `kernel.invoke()` |
| HTTP wire surface | `apps/api/src/routes/contextgraph/` modeled on the A2A bridge (`apps/api/src/routes/a2a/`), incl. well-known discovery + capability document |
| Retention/expiry enforcement | scheduled function in `packages/inngest-functions` |
| Audit | automatic ClickHouse audit event per capability invocation via the kernel; contract `audit` fields set on every capability |
| Config/flags | `packages/config/src/registry.ts` (e.g. `CONTEXT_EXCHANGE_ENABLED`, default off) |

Four-store placement: transactional/canonical state (records, ledgers,
receipts, approvals, keys) in Postgres with RLS; append-only audit in
ClickHouse via the kernel; Neo4j and Blob unused in v1.

## 5. Data model (Postgres, `context_exchange` schema)

All tenant-scoped tables carry `org_id`/`workspace_id` (nullable per the
`workspace_nullable` RLS class where a record is org- or user-audience) and
the standard RLS block. One Atlas migration owns ALL v1 DDL (atlas.sum makes
concurrent migration authoring a conflict):

- `context_records` — record_id PK, lineage_id, schema_version, record_kind,
  record_status, scope_json (+ indexed projections: user_id, repository_id,
  workspace_id, organization_id, task_id), sharing_scope, sensitivity,
  observed_at, valid_from, valid_until, confidence, supersedes_record_id,
  record_hash, canonical_json (single authoritative bytes), origin
  provenance columns. Immutable: revisions insert new rows; no UPDATE of
  canonical_json ever.
- `context_record_links`, `context_evidence_links` — typed relations
  (supports/contradicts/validates/invalidates/source) as validated
  projections of canonical_json.
- `context_ingestions` — record_id, origin_provider_id, client_id,
  authenticated_authority_id (IAM principal id), received_at,
  authenticated_channel_ref, attestation_json. Feeds provider-side
  `known_at` reconstruction.
- `context_idempotency_receipts` — UNIQUE(authority_id, client_id, operation,
  idempotency_key); command_hash, receipt_json (exact replay bytes),
  replay_until, status. Same key + same command_hash ⇒ replay receipt as
  `duplicate`; same key + different hash ⇒ `idempotency_conflict`; expired ⇒
  `idempotency_expired` (never silent re-execution). Existing record_id +
  different hash ⇒ `record_identity_conflict`.
- `context_retention_commitments` — accepted_retention per record (class,
  until, on_expiry), written only from an accepted append; provider must
  reject (`retention_rejected`) before persistence when it cannot honor a
  request — never silently shorten or lengthen.
- `context_publication_approvals` — workspace publication queue: proposal
  ref, requested sharing, approver principal, reason, policy_version,
  status, resulting record_id, promotion_event record_id.
- `context_provider_keys` — ed25519 attestation keys (key_id, public key,
  active window); private material via the platform's secret handling, never
  a plaintext column.

## 6. Wire contract (summary; the CGP build prompt is normative)

Operations: `context/query`, `context/records/append`, `context/records/get`,
`context/resolve`. Append is batched; each item carries `idempotency_key` and
optional `requested_retention` (command metadata, excluded from record_hash);
the provider computes/verifies `record_hash` (RFC 8785 JCS, `record_hash`
omitted from its own preimage) and `command_hash` (JCS over record_hash +
requested_retention + behavior-changing options, key/command_hash omitted);
receipts carry status accepted|duplicate|rejected, record identity,
accepted_at, accepted_retention, and idempotency_replay_until. `accepted`
means durable and immediately readable via exact get by the same principal.
Resolve verifies canonical content hash before returning content. The
capability document advertises representations, lifecycle kinds, ops, batch
limits/atomicity, retention classes and bounds, receipt-retention minimum,
consent class, and unknown-field behavior — under the current protocol
namespace with `contextgraph/lifecycle/1.0-draft` documented as the target
identifier. The full typed error vocabulary (24 codes, from
`unsupported_capability` through `partial_failure`) is required; errors carry
safe diagnostics only.

## 7. Identity, authorization, and audit

- `authenticated_authority_id` is the platform IAM principal resolved by API
  auth middleware — request-supplied labels never substitute.
- Sharing-scope authorization matrix, enforced in handlers before
  persistence and on every read: `user` ⇒ record scope.user_id must map to
  the authenticated principal; `repository` ⇒ accepted only as part of an
  explicit export destined to a registered repository binding; `workspace` ⇒
  scope.workspace_id required + membership + IAM allow; `organization` ⇒ org
  authority required. Capability support never implies consent
  (`consent_required` is a live error path, policy-driven per workspace).
- Every operation is a capability through `kernel.invoke()`:
  `context_exchange.records.append|get|query|resolve`,
  `context_exchange.capabilities.describe`,
  `context_exchange.publication.propose|approve|revoke|list`,
  `context_exchange.exports.accept`. Contracts declare `defaultRoles`,
  `defaultEffect`, and `audit.targetKind/targetIdField` so IAM checks and
  ClickHouse audit events are automatic.

## 8. Workspace publication and attestation (lifecycle spec §13.4 + §7.7)

Flow: proposed workspace record → RBAC approval (approver must hold the
publication permission via the IAM resolver; proposer≠approver supported for
regulated tenants) → immutable published revision scoped to workspace_id +
PromotionEvent record linking source and result → receipt + detached ed25519
attestation (`signed_record_hash`, algorithm, key_id, attester_id, signature,
issued_at — ingestion-ledger metadata, never inside record_hash) + audit
event → served to members as read-only records. Revocation publishes a
retracted superseding revision. A workspace record's blocking effect requires
authenticated workspace policy + the consumer's local opt-in + a real
enforcer — membership alone grants nothing (the provider only stores and
attests; enforcement is host-side).

## 9. Engram bridge (deliberately minimal in v1)

`packages/engram` remains the platform's retrieval/compilation engine
(ADR-033 names it as the ContextRecallPort provider). v1 `context/query`
serves filtered + temporal listing over canonical records (kind, status,
sharing, scope, known_at/valid_at/observed/valid_overlaps). Semantic fusion
retrieval over context records routes through engram in a follow-up once the
record volume justifies indexing; the two-axis-memory spec is adjacent and
must not be duplicated.
Provider-relative `known_at` uses `context_ingestions.received_at` and the
capability document advertises the earliest reconstructable time.

## 10. Cross-repo consistency

- Golden JCS/hash vectors live in `docs/specs/adaptive-context/fixtures/`
  (created by the fleet's first task) so the Stella and protocol repos can
  copy identical vectors; when stella PR #257's fleet lands its vectors,
  reconcile to byte-identical fixtures.
- `recorded_at`/`valid_to` are accepted as input aliases only; canonical
  output emits `observed_at`/`valid_until`.
- Origin/derivation validation matrix (lifecycle §7.7) is enforced at append;
  ordinary receipt preserves origin provenance and adds ingestion metadata —
  it never relabels a record `imported`.

## 11. Open decisions for implementers (resolve in-task, record in commit)

1. JCS: the `canonicalize` npm package (reference RFC 8785 impl, no
   transitive deps) vs a hand-rolled subset — either way, golden vectors and
   an integers-preferred number policy documented.
2. Private key handling for attestation keys: platform secret conventions
   (config registry + env) vs a managed KMS binding; v1 may ship env-based
   with rotation via key_id windows.
3. Consent policy source: extend `workspaceMemoryPolicy` vs a dedicated
   `context_exchange` policy table (lean: dedicated column family on the
   approvals/policy path).
4. Whether `context/records/get` batch limits mirror append batch limits
   (recommended) — advertise whichever is chosen.
