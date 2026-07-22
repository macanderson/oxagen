# Governed Run Evidence Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one governed, sandbox-backed `edit_repo_file` run whose identity, authorization, ordered execution, retained evidence, provider receipts, and coarse workspace lineage are independently verifiable.

**Architecture:** PostgreSQL is the chain-of-custody authority; exact retained bytes are envelope-encrypted before blob storage; ClickHouse and Neo4j are asynchronous, rebuildable consumers. The TypeScript engine and Stella produce the same host-owned receipts. Stella retains checkout-local code detail, CGP retains portable context types, and Oxagen retains enterprise identity, policy, ordering, retention, and lineage.

**Tech Stack:** TypeScript 6, Zod 3, PostgreSQL/Drizzle/Atlas, `@oxagen/crypto`, `@oxagen/storage`, AWS KMS, Inngest, ClickHouse, Neo4j, GitHub App APIs, Rust 2024, Stella `stella-serve`, Context Graph Protocol Rust crates.

## Global Constraints

- Every hosted capability invocation, including evidence finalization, goes through `kernel.invoke()`.
- The initiating human and deployed agent are an intersection, not alternative authorities.
- A run pins a grant ceiling. Later grants cannot widen it; live deny-generation changes can narrow it before the next context/model/tool operation.
- The worker creates a distinct immutable attempt before any model or tool work. Lease reclaim never reuses an attempt.
- Event append and checkpoint advancement are one fenced transaction. Same sequence plus a different digest is an integrity error.
- PostgreSQL manifests and receipts are immutable. Mutable retry state lives in separate delivery rows.
- Every attempt seal atomically mints one capability-limited finalization grant and immutable obligation; this includes completed, failed, cancelled, and abandoned attempts.
- No raw source, prompt, tool payload, diff, absolute path, embedding, file node, symbol node, or branch-local code graph enters ClickHouse or Neo4j.
- GitHub is the authority for repository, commit, tree, pull-request, check, and merge observations. Caller strings are not repository identity.
- The first `edit_repo_file` slice is agent-only, sandbox-only, and asynchronous. It returns a durable run handle; it does not block a parent worker waiting for a child worker.
- The standalone Stella upload contract and a main-branch topology projector are not part of the hosted evidence PR.
- Run only package-scoped tests named in the detailed plans. Never run the repository-wide test suite.

---

## PR Dependency Map

| Order | Pull request | Repository | Detailed plan | Merge gate |
|---|---|---|---|---|
| 0A | Current-CGP conformance fixtures | `context-graph-protocol` | `01-contract-fixtures-plan.md` | Frame/query normalization and digest vectors are versioned and green |
| 0B | Run-evidence contract package | `oxagen-platform` | `01-contract-fixtures-plan.md` | JSON Schema, limits, valid/invalid fixtures, and RFC 8785 vectors are green |
| 0C | Stella CGP dependency correction | `stella` | `01-contract-fixtures-plan.md` | No `ocp-types`/`ocp-host` dependency remains and vendored fixtures match 0A |
| 1A | Run/attempt/IAM expand and dual compatibility | `oxagen-platform` | `02-run-attempt-foundation-plan.md` Tasks 1–5 + Task 6 compatibility | Expand-only schema, fenced attempts, immutable admission, dual readers/claims, and live-deny tests are green; V2 claims remain off |
| 2A | Evidence crypto, storage, and KMS | `oxagen-platform` | `03-evidence-ledger-plan.md` Tasks 2–3 | AAD encryption, strict private storage, public verification material, and production key validation are green |
| 2B | Immutable evidence ledger, receipt ports, and finalizer | `oxagen-platform` | `03-evidence-ledger-plan.md` Tasks 1, 4–6, 8 | Finalization, durable receipt production, signature, idempotency, service-principal, and abandoned-attempt tests are green; legacy recorder is absent |
| 1B | V1 code-mode drain and contract cutover | `oxagen-platform` | `02-run-attempt-foundation-plan.md` Task 6 | Zero nonterminal V1 code-mode rows is proven before the contract guard; historical/unrelated V1 compatibility remains honest |
| 2C | Audited replay and retention lifecycle | `oxagen-platform` | `03-evidence-ledger-plan.md` Tasks 7 and 7B | Structural/content export authorization, access receipts, chunk integrity, erasure receipts, and negative permission tests are green |
| 3 | Governed repository-edit surface | `oxagen-platform` | `04-governed-repo-edit-plan.md` | Agent-only durable sandbox run produces provider receipts; bypasses are deleted |
| 4 | Projection and provider reconciliation | `oxagen-platform` | `05-projection-reconciliation-plan.md` | Finalized-only projection and default-ref corroboration tests are green |
| 5A | Stella evidence-producing sidecar | `stella` | `06-stella-parity-plan.md` | Full code-mode port set emits the agreed versioned event stream |
| 5B | Stella client and shadow parity | `oxagen-platform` | `06-stella-parity-plan.md` | Shadow evidence conformance passes before any production engine flag is allowed |

PR 3 must not contain PR 4's canonical default-ref projector. PR 4 must not add standalone client ingress. PR 5 must not change the evidence manifest schema merely to accommodate Stella.

## Merge and Rollout Order

- [ ] Merge 0A, record the exact CGP commit in both downstream fixture manifests, then merge 0B and 0C.
- [ ] Merge PR 1A expand-only with dual V1/V2 readers and claims. Turn off new V1 code-mode POST admission, keep queued V1 claims running, and leave V2 execution claims off.
- [ ] Merge PR 2A after PR 0B. Merge PR 2B only after both PR 1A and PR 2A; `ingest_run_evidence` remains default-deny and unreachable from user surfaces, and projection deliveries remain pending until PR 4.
- [ ] Drain or audited-cancel every nonterminal V1 code-mode row, record the zero count, then merge PR 1B's assertion-backed contract migration and enable V2 claims. Retain historical reads and unrelated explicitly non-evidence V1 compatibility.
- [ ] Merge PR 2C before any preview or production enablement. It may proceed in parallel with PR 3/PR 4 after PR 2B, but execute-agent permission alone must never grant replay access.
- [ ] Merge PR 3 behind `RUN_EVIDENCE_REPO_EDIT_ENABLED=false`; remove the legacy transports in the same PR so there is no dual-authority period.
- [ ] Merge PR 4 with projector/reconciler consumers idempotent, independently switchable, and still off by default.
- [ ] Enable PR 3 plus selected PR 4 consumers in preview for one governed GitHub connection; verify structural replay for completed, denied, failed, cancelled, and abandoned attempts before any broader rollout.
- [ ] Merge PR 5 in shadow-only mode. Production stays on `ENGINE=ts` until the recorded parity corpus passes.
- [ ] Remove `RunSpecV1` parsing and the TypeScript engine only in later cleanup PRs after stored-run compatibility and Stella production gates are satisfied.

## Cross-PR Contract Locks

- [ ] Pin `run-evidence-envelope/v1`, `run-evidence-manifest/v1`, `contextgraph/1.0-draft`, and the Stella event-schema version in fixture manifests.
- [ ] Reserve public prefixes `arat_` for attempts, `revm_` for evidence manifests, `rpb_` for repository-binding versions, `ras_` for authorization snapshots, `azd_` for authorization decisions, `afg_` for one-shot finalization grants, `evb_` for retained evidence blobs, `rpl_` for opaque tenant path locators, `revk_` for verification-key versions, and `rpo_` for provider observations.
- [ ] Use `sha256:<64 lowercase hex>` everywhere a digest crosses a package or repository boundary.
- [ ] Use RFC 8785 JCS bytes for object digests and exact UTF-8 bytes for rendered prompt content, model transport bodies, command output, and file content.
- [ ] Keep internal UUIDs out of public contracts; resolve and stamp public IDs server-side.
- [ ] Treat provider and runner observations as additive receipts. Never upgrade authority by mutating an existing row.

## Plan-Set Verification

- [ ] Confirm all seven plan files exist: `plan.md` plus `01` through `06`.
- [ ] Run `rg -n 'TBD|TODO|FIXME|add appropriate|similar to Task' docs/specs/run-evidence-ingress/0[1-6]-*plan.md`; expect no matches.
- [ ] Run `rg -n 'pnpm test|turbo run test|pnpm gate' docs/specs/run-evidence-ingress/0[1-6]-*plan.md`; inspect every match and retain only explicit prohibitions.
- [ ] Run `git diff --check`; expect no whitespace errors.
- [ ] Review every path against the target repository immediately before starting its PR; if main moved, update the plan path in the implementation PR rather than silently substituting a different seam.

## Acceptance-Criteria Coverage

| Spec criterion | Primary automated evidence |
|---|---|
| 1. Human + deployed agent + exact version | PR 3 Tasks 3–4 handler/driver tests |
| 2. Provider repository + base commit/tree pin | PR 3 Tasks 1 and 4 snapshot/sandbox tests |
| 3. Distinct fenced attempt per claim | PR 1A Tasks 2–4 store/worker integration tests |
| 4. Ordered stream + checkpoint provenance | PR 1A Task 3 append/restore tests |
| 5. Complete frame-use receipt | PR 0B Task 2 fixtures and PR 2 Task 4 authority tests |
| 6. Outcome-complete model receipt | PR 0B Task 2 fixtures and PR 2 Task 4 replay tests |
| 7. Tool IAM/approval/metering links | PR 1A Task 5 kernel tests and PR 2 Task 4A receipt-port tests |
| 8. Change digests + encrypted patch | PR 3 Task 4 change-set tests and PR 2 Tasks 2/4 blob tests |
| 9. Manifest for every terminal outcome | PR 1A Task 4 and PR 2 Task 6 crash/finalizer tests |
| 10. Finalization idempotency/conflict | PR 2 Tasks 5–6 concurrency/integrity tests |
| 11. Signature and replay verification | PR 2 Tasks 2, 4, and 7 verification/export tests |
| 12. Coarse Neo4j + metadata-only ClickHouse | PR 4 Tasks 2, 4, and 7 boundary/rebuild tests |
| 13. Feature branch cannot advance canonical | PR 4 Tasks 5–7 reconciliation tests |
| 14. TS/Stella evidence parity | PR 5 Tasks 5–6 conformance/parity fixtures |
| 15. Current CGP compatibility | PR 0A and PR 0C golden-fixture tests |
| 16. Agent-only repository edit | PR 3 Tasks 3 and 5 contract/discovery tests |
| 17. Internal exact-name evidence ingress | PR 2 Tasks 5 and 8 kernel/negative-route tests |
| 18. One-shot abandoned finalization | PR 1A Tasks 3–4 and PR 2 Task 6 grant-use tests |
| 19. Non-expanding grants + live denies | PR 1A Task 5 snapshot/generation tests |
| 20. Append-only DB + conflict detection | PR 1A Tasks 2–3 privilege/integrity tests |
| 21. Encrypt before private storage | PR 2 Tasks 2 and 4 downgrade/AAD tests |

## Definition of Done

- [ ] All 21 acceptance criteria in `spec.md` have at least one named automated test or deployment verification in a detailed plan.
- [ ] A replay verifier can validate a manifest after export using the included public key metadata and without trusting the database row that carried it.
- [ ] An agent suspension or deny-generation increment prevents the next governed operation while preserving the earlier decision receipts.
- [ ] A feature-branch run can show provisional `Domain`/`CodeScope` impact but cannot advance the canonical repository snapshot.
- [ ] A GitHub merge/push webhook plus scheduled reconciliation can advance only the configured default ref to an immutable commit/tree observation.
- [ ] The production engine selector cannot choose Stella until the same envelope/receipt fixtures pass for the TS and Stella producers.
