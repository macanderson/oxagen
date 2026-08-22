# Run Evidence Contract Fixtures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the cross-language evidence and current-CGP normalization contract before any durable storage or engine integration is implemented.

**Architecture:** Context Graph Protocol owns the canonical frame/query fixture source. Oxagen vendors a digest-locked copy and owns the evidence envelope/manifest schemas plus RFC 8785 hashing. Stella consumes current `contextgraph-*` crates and the same fixture bytes; it does not define a parallel protocol shape.

**Tech Stack:** Rust 2024/Serde, TypeScript 6, Zod 3, `canonicalize` 1.0.8, `zod-to-json-schema` 3.25.2, SHA-256, Vitest, Cargo test.

## Global Constraints

- Do not add Oxagen IAM, run, retention, or evidence-authority fields to `ContextFrame` or `ContextQuery`.
- Normalize protocol defaults before JCS hashing: absent `provenance`, `relations`, `kinds`, and `anchors` become empty arrays; optional scalar fields remain absent; array order is preserved.
- Reject unknown fields for the pinned `contextgraph/1.0-draft` digest profile. A future additive protocol field requires a new fixture profile before it affects evidence hashes.
- A missing or blank `citation_label` is invalid for evidence labeled current CGP. Legacy adapters record `legacy_adapter`; they never synthesize protocol evidence from `title`.
- Fixture copies carry an upstream commit plus per-file SHA-256 values. Downstream tests fail on drift.

---

## Task 1: Publish Current-CGP Golden Fixtures (PR 0A, `context-graph-protocol`)

**Files:**

- Create: `contextgraph-conformance/fixtures/contextgraph-1.0-draft/manifest.json`
- Create: `contextgraph-conformance/fixtures/contextgraph-1.0-draft/context-frame.valid.json`
- Create: `contextgraph-conformance/fixtures/contextgraph-1.0-draft/context-frame.missing-citation.invalid.json`
- Create: `contextgraph-conformance/fixtures/contextgraph-1.0-draft/context-query.valid.json`
- Create: `contextgraph-conformance/fixtures/contextgraph-1.0-draft/normalization-vectors.json`
- Create: `contextgraph-conformance/tests/golden_fixtures.rs`
- Modify: `contextgraph-conformance/Cargo.toml`
- Modify: `contextgraph-conformance/README.md`

- [ ] Write `golden_fixtures.rs` first. It must fail because the fixture directory does not exist.
- [ ] Define one fully populated frame, one minimal frame with omitted default arrays, one query with omitted default arrays, Unicode/escaping/number normalization vectors, and one blank-citation rejection.
- [ ] Put the expected normalized JSON object, exact JCS UTF-8 text, and `sha256:<hex>` digest in each vector. The manifest records `protocol_version`, fixture-profile version, generation command, and SHA-256 of every fixture file.
- [ ] Make the test deserialize valid fixtures into `ContextFrame`/`ContextQuery`, reject the invalid fixture through `check_frames`, and assert Rust serialization semantics against the normalized object without treating ordinary `serde_json::to_string` as JCS.
- [ ] Document that JCS digest values are interoperability vectors, not a new CGP field.
- [ ] Run `cargo test -p contextgraph-conformance --test golden_fixtures`; expect pass.
- [ ] Commit: `test(protocol): publish context graph golden fixtures`

## Task 2: Create the Oxagen Run-Evidence Contract Package (PR 0B, `oxagen-platform`)

**Files:**

- Create: `packages/run-evidence/package.json`
- Create: `packages/run-evidence/tsconfig.json`
- Create: `packages/run-evidence/vitest.config.ts`
- Create: `packages/run-evidence/src/limits.ts`
- Create: `packages/run-evidence/src/digest.ts`
- Create: `packages/run-evidence/src/contextgraph.ts`
- Create: `packages/run-evidence/src/envelope.ts`
- Create: `packages/run-evidence/src/manifest.ts`
- Create: `packages/run-evidence/src/index.ts`
- Create: `packages/run-evidence/src/digest.test.ts`
- Create: `packages/run-evidence/src/contextgraph.test.ts`
- Create: `packages/run-evidence/src/envelope.test.ts`
- Create: `packages/run-evidence/fixtures/contextgraph/manifest.json`
- Create: `packages/run-evidence/fixtures/contextgraph/context-frame.valid.json`
- Create: `packages/run-evidence/fixtures/contextgraph/context-frame.missing-citation.invalid.json`
- Create: `packages/run-evidence/fixtures/contextgraph/context-query.valid.json`
- Create: `packages/run-evidence/fixtures/contextgraph/normalization-vectors.json`
- Create: `packages/run-evidence/fixtures/envelopes/valid-completed.json`
- Create: `packages/run-evidence/fixtures/envelopes/valid-failed-before-model.json`
- Create: `packages/run-evidence/fixtures/envelopes/valid-denied-before-checkout.json`
- Create: `packages/run-evidence/fixtures/envelopes/valid-abandoned-before-first-event.json`
- Create: `packages/run-evidence/fixtures/envelopes/valid-model-indeterminate.json`
- Create: `packages/run-evidence/fixtures/envelopes/invalid-producer-authority.json`
- Create: `packages/run-evidence/fixtures/envelopes/invalid-stage-coverage.json`
- Create: `packages/run-evidence/fixtures/envelopes/invalid-model-outcome.json`
- Create: `packages/run-evidence/fixtures/envelopes/invalid-digest.json`
- Create: `packages/run-evidence/schema/run-evidence-envelope-v1.schema.json`
- Create: `packages/run-evidence/schema/run-evidence-manifest-v1.schema.json`
- Modify: `pnpm-lock.yaml`

- [ ] Add package scripts matching other workspace libraries and explicit dependencies on `canonicalize@1.0.8`, `zod@3.25.76`, and `zod-to-json-schema@3.25.2`.
- [ ] Write `digest.test.ts` from the upstream JCS vectors first. Expect failures until `jcsBytes`, `sha256Digest`, `assertDigest`, and `digestJcs` exist.
- [ ] Implement algorithm-qualified lowercase SHA-256 only. Do not export `packages/replay/src/hash.ts` as security hashing because its sorted-key serializer is not RFC 8785.
- [ ] Write `contextgraph.test.ts` first. Assert default-array materialization, array-order preservation, blank-citation rejection, unknown-field rejection, and a byte-for-byte match with every upstream normalized vector.
- [ ] Implement `normalizeContextFrameV1` and `normalizeContextQueryV1` as explicit pinned adapters. Do not mutate the caller's object.
- [ ] Write the envelope/manifest schemas with the receipt shapes in `spec.md`. Envelope parsing must strip nothing: producer-supplied tenant, principal, authorization snapshot, authority, replay grade, manifest ID, or attestation fields are hard validation errors.
- [ ] Centralize these launch ceilings in `limits.ts`: 1 MiB encoded envelope; 256 frames; 512 model calls; 5,000 changes; 2,000 tool calls; 256 approvals; 512 verifications; 1,000 commits; 64 pull requests; 1,000 artifacts; 4 KiB ordinary strings; 16 KiB terminal summaries. `stage_coverage` must contain exactly the nine distinct stages.
- [ ] Encode outcome-dependent validation: transmission requires request digest; completed model calls require raw-response digest; failed model calls require error digest; indeterminate calls require a transmitted-request digest plus error/gap digest and lower completeness; local graph `used` requires all generation/freshness fields; an observed clean checkout still requires dirty/untracked empty digests.
- [ ] Make stage-owned sections conditional on coverage: `checkout` and the context summary are required for `complete|partial`, absent for `not_reached`, and policy-specific for `not_applicable`. Receipt arrays remain present as empty arrays, but never imply stage success. Freeze denied-before-checkout and zero-event-abandoned fixtures so engines cannot invent checkout/context evidence merely to satisfy shape.
- [ ] Generate checked-in Draft 2020-12 JSON Schema with stable `$id` values. Add a test that regenerates in memory and deep-compares with the checked-in files so schema drift fails locally.
- [ ] Run `pnpm --filter @oxagen/run-evidence test:unit -- digest.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/run-evidence test:unit -- contextgraph.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/run-evidence test:unit -- envelope.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/run-evidence typecheck`; expect pass.
- [ ] Commit: `feat(run-evidence): freeze envelope and digest contracts`

## Task 3: Add Fixture Drift Verification (PR 0B, `oxagen-platform`)

**Files:**

- Create: `packages/run-evidence/src/fixtures.test.ts`
- Create: `tools/scripts/check-contextgraph-fixtures.ts`
- Modify: `package.json`

- [ ] Write a test that verifies every vendored fixture against `packages/run-evidence/fixtures/contextgraph/manifest.json` and the manifest's pinned upstream commit.
- [ ] Add `check:contextgraph-fixtures` to the root scripts. With `CONTEXT_GRAPH_PROTOCOL_DIR` set, compare the vendored files to that checkout byte-for-byte; without it, verify only the committed manifest digests so CI has no network dependency.
- [ ] Do not add this check to the repository-wide test command in this PR; add it as a named CI step only after the fixture PRs have merged in all three repositories.
- [ ] Run `pnpm --filter @oxagen/run-evidence test:unit -- fixtures.test.ts`; expect pass.
- [ ] Run `CONTEXT_GRAPH_PROTOCOL_DIR=/Users/macanderson/Projects/context-graph-protocol pnpm check:contextgraph-fixtures`; expect pass against the PR 0A checkout.
- [ ] Commit: `test(run-evidence): detect context graph fixture drift`

## Task 4: Replace Stella's Legacy Protocol Dependency (PR 0C, `stella`)

**Files:**

- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `stella-context/Cargo.toml`
- Modify: `stella-graph/Cargo.toml`
- Modify: `stella-cli/Cargo.toml`
- Modify: `stella-protocol/Cargo.toml`
- Rename: `stella-cli/src/ocp.rs` to `stella-cli/src/contextgraph.rs`
- Modify: `stella-cli/src/main.rs`
- Modify: `stella-cli/src/memory.rs`
- Modify: `stella-cli/src/command_deck.rs`
- Modify: `stella-cli/src/command_deck/tests.rs`
- Modify: `stella-context/src/lib.rs`
- Modify: `stella-context/src/provider.rs`
- Modify: `stella-context/src/retrieval.rs`
- Modify: `stella-context/src/store.rs`
- Modify: `stella-graph/src/frames.rs`
- Modify: `stella-graph/src/graph.rs`
- Modify: `stella-graph/src/lib.rs`
- Create: `stella-protocol/tests/contextgraph_fixtures.rs`
- Create: `tests/fixtures/contextgraph/manifest.json`
- Create: `tests/fixtures/contextgraph/context-frame.valid.json`
- Create: `tests/fixtures/contextgraph/context-frame.missing-citation.invalid.json`
- Create: `tests/fixtures/contextgraph/context-query.valid.json`
- Create: `tests/fixtures/contextgraph/normalization-vectors.json`

- [ ] Pin `contextgraph-types` and `contextgraph-host` to the exact merged PR 0A revision at the workspace dependency level, then consume them with `workspace = true` from the three production crates. Add the minimum `contextgraph-types`/host dev-dependency to `stella-protocol` for its conformance test rather than introducing a production dependency it does not use.
- [ ] Write the fixture test first and verify the vendored manifest/digests, deserialization of the valid frame/query, and rejection of the missing/blank-citation fixture through the same current-CGP conformance path.
- [ ] Replace `ocp_types`/`ocp_host` imports with `contextgraph_types`/`contextgraph_host`; update comments/user-visible terminology to Context Graph Protocol.
- [ ] Preserve Stella's local storage, retrieval, code graph, and compiler behavior. This PR changes interchange types and naming, not the engine loop or database.
- [ ] Where the current Stella adapter drops a frame with no citation label, retain the drop but emit/return an explicit adapter diagnostic so later evidence can label it `legacy_adapter` until upstream conformance is guaranteed.
- [ ] Run `cargo test -p stella-protocol --test contextgraph_fixtures`; expect pass.
- [ ] Run `cargo test -p stella-context`; expect pass.
- [ ] Run `cargo test -p stella-graph`; expect pass.
- [ ] Run `cargo test -p stella-cli`; expect pass.
- [ ] Run `rg -n 'ocp-types|ocp-host|ocp_types|ocp_host|crate::ocp' Cargo.toml Cargo.lock stella-* --glob '*.rs' --glob 'Cargo.toml'`; expect no matches.
- [ ] Commit: `refactor(context): consume current context graph protocol`

## Task 5: Record the Cross-Repository Lock

**Files:**

- Modify: `packages/run-evidence/fixtures/contextgraph/manifest.json` in `oxagen-platform`
- Modify: `tests/fixtures/contextgraph/manifest.json` in `stella`
- Modify: `docs/specs/run-evidence-ingress/spec.md` in `oxagen-platform`

- [ ] Record the merged CGP commit and fixture-profile digest in both downstream manifests.
- [ ] Update the spec's inspected-reference section only if implementation found a real contract mismatch; do not rewrite approved boundaries to match convenience code.
- [ ] Re-run the three fixture gates and attach their exact outputs to PR 0B/0C descriptions.
- [ ] Commit downstream lockfile updates with the PR that consumes them; do not create floating `main` references.
