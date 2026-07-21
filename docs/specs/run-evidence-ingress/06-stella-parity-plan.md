# Stella Engine Evidence-Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Stella's full judged coding pipeline behind Oxagen-owned context, model, tool, approval, sandbox, and evidence ports, then prove that its hosted output conforms to the same evidence contract as the TypeScript engine before Stella can be selected for production runs.

**Architecture:** `stella-serve` is a transport-isolated engine process with no ambient model, credential, repository mount, shell, or publication authority. Its versioned HTTP/SSE protocol drives `stella-pipeline`, Stella's context compiler, and checkout-local graph-generation semantics through bounded reverse-RPC workspace/context ports. Oxagen authorizes and services every byte/read/operation, records authoritative receipts at the host boundary, and appends Stella events to the same fenced attempt log. Shadow evaluation always uses a second non-publishing sandbox checkout.

**Tech Stack:** Rust 2024, Tokio, Serde, HTTP/SSE, TypeScript 6, Zod 3, Vitest, `@oxagen/run-evidence`, `@oxagen/agent-worker`, `@oxagen/ai`, `kernel.invoke()`, Modal/container deployment.

## Global Constraints

- Stella owns loop and stage semantics. Oxagen owns run identity, tenant scope, IAM, receipts, sequence assignment, evidence retention, and platform attestation.
- The sidecar never receives Oxagen signing keys, blob credentials, tenant KMS data keys, raw authorization snapshots, internal UUIDs, or reusable GitHub credentials.
- Every model request, context retrieval, bounded workspace read/list/search, local-graph source read, command, tool call, approval, workspace operation, commit, and publication crosses a typed host port. There is no ambient repository or local-tool mode in hosted deployments; Stella still owns selection, compilation, extractor semantics, and graph-generation identity over the authorized bytes it receives.
- A reverse-RPC result carries host data, not host authority claims. Oxagen creates authorization, approval, metering, and evidence references outside the Stella wire object.
- An admitted attempt never changes engine or engine version. Sidecar loss is a terminal attempt failure; it is not a silent TypeScript fallback.
- Shadow execution never shares a mutable checkout, branch, tool idempotency key, or provider-publication target with the primary run.
- Do not remove the TypeScript engine in PR 5A or 5B. Do not enable a production Stella selector in either PR.
- Do not add a standalone Stella evidence-upload endpoint. Hosted receipts are observed at the Oxagen port boundary.

---

## Task 1: Freeze the Stella Host Protocol (PR 5A, `stella`)

**Files:**

- Create: `stella-serve/src/protocol.rs`
- Create: `stella-serve/tests/fixtures/host-protocol-v1.jsonl`
- Create: `stella-serve/tests/protocol_fixtures.rs`
- Modify: `stella-serve/src/frame.rs`
- Modify: `stella-serve/src/lib.rs`
- Modify: `stella-serve/Cargo.toml`
- Modify: `stella-protocol/src/event.rs`
- Modify: `stella-protocol/src/lib.rs`

- [ ] Write `protocol_fixtures.rs` first. It must reject an unknown protocol version, duplicate request ID, response kind that does not match its request, response after terminal, and an event after terminal.
- [ ] Define `STELLA_HOST_PROTOCOL_VERSION = "stella-host/v1"` and `STELLA_EVENT_SCHEMA_VERSION = "stella-agent-event/v1"`. Start every stream with a metadata frame containing protocol version, event-schema version, Stella build revision, and declared pipeline feature set.
- [ ] Replace unversioned session input with `HostedPipelineSpecV1`: goal, bounded conversation, model-role policy, tool schemas, pipeline configuration, spend/step bounds, and opaque host correlation token. It must contain no Oxagen tenant, principal, authorization, receipt, or signing fields.
- [ ] Define one tagged `HostRequestV1` enum for `model`, `tool`, `context_query`, `workspace_list`, `workspace_read`, `workspace_search`, `local_graph_source`, `repo_structure`, `repo_status`, `command`, `approval`, `candidate_create`, `candidate_adopt`, and `candidate_remove`. Candidate-rooted requests carry only an opaque workspace handle minted by the host; read responses are bounded, content-digested, and never confer host authority.
- [ ] Define the corresponding tagged `HostResponseV1` outcomes, including typed denial, unavailable, timeout, cancellation, and malformed-response errors. A response is accepted exactly once for the same session and request ID.
- [ ] Retain `ServerFrame::Event`, but wrap it with the event-schema version and a Stella-local monotonically increasing `engine_seq`. Oxagen later assigns authoritative attempt sequence numbers.
- [ ] Add a terminal frame that reports pipeline status, Stella's final verdict, reached stages, and the last `engine_seq`; it must not claim an Oxagen replay grade or evidence authority.
- [ ] Keep `AgentEvent::ContextRecall` compact and presentation-safe, but make the hosted model request declare the ordered compiled frame IDs/digests and local graph generation ID it used so the host can validate them against bytes it served. Do not add Oxagen IAM or retained-content references to `stella-protocol`.
- [ ] Serialize the complete golden transcript to `host-protocol-v1.jsonl` and assert byte-stable tagged shapes plus round trips.
- [ ] Run `cargo test -p stella-serve --test protocol_fixtures`; expect pass.
- [ ] Run `cargo test -p stella-protocol`; expect pass.
- [ ] Commit: `feat(serve): version the hosted pipeline protocol`

## Task 2: Drive the Full Judged Pipeline in `stella-serve` (PR 5A, `stella`)

**Files:**

- Create: `stella-serve/src/host_ports.rs`
- Create: `stella-serve/src/pipeline_session.rs`
- Create: `stella-serve/tests/pipeline_bridge.rs`
- Modify: `stella-serve/src/remote.rs`
- Modify: `stella-serve/src/pending.rs`
- Modify: `stella-serve/src/session.rs`
- Modify: `stella-serve/src/server.rs`
- Modify: `stella-serve/src/http.rs`
- Modify: `stella-serve/src/main.rs`
- Modify: `stella-serve/Cargo.toml`

- [ ] Write `pipeline_bridge.rs` first with a scripted host. Assert the observed stage order includes evaluate, context recall, enhance, route, plan, scope review when required, execute, deterministic verification, judge, and terminal.
- [ ] Implement remote adapters for every `stella-pipeline::ports` trait plus the compiler/graph source interfaces: `ProviderResolver`, authorized frame query, bounded workspace list/read/search, checkout-local graph source/query, `RepoStructurePort`, `RepoStatusPort`, `CommandRunner`, `ApprovalGate`, and `CandidateWorkspacePort`. Stella performs selection/compilation and stamps extractor/schema/generation identity; candidate workspace lifecycle is host-owned and fail-closed with no shared-tree fallback.
- [ ] Route `stella_core::ToolExecutor` through the same typed host request mechanism. Build no ambient shell, filesystem mount, network, model, or GitHub implementation into `stella-serve` hosted mode; all workspace bytes arrive through bounded authenticated host responses.
- [ ] Replace `Session::run_turn`'s bare `stella_core::Engine` call with one `stella_pipeline::Pipeline` execution over the remote port set. Preserve the dedicated current-thread runtime required by Stella's `!Send` future.
- [ ] Bound outstanding reverse requests, request/response body size, SSE frame size, and per-request timeout. On disconnect or timeout, clear all pending requests and emit one terminal aborted frame if the stream is still writable.
- [ ] Add explicit cancellation and make cancellation observable before the next remote operation. A late response to a cancelled request must be rejected.
- [ ] Require bearer authentication on session creation, stream, response, cancellation, health, and metadata endpoints. Compare tokens in constant time and never log them.
- [ ] Report `/healthz` process health separately from `/v1/meta` build/protocol compatibility. A healthy but incompatible sidecar must be rejected at Oxagen admission.
- [ ] Assert a malicious host response cannot inject an `AgentEvent`, choose a different request ID, or make the sidecar execute a local command.
- [ ] Run `cargo test -p stella-serve --test pipeline_bridge`; expect pass.
- [ ] Run `cargo test -p stella-serve --test bridge`; expect pass.
- [ ] Run `cargo test -p stella-serve --test http`; expect pass.
- [ ] Commit: `feat(serve): expose the full judged pipeline`

## Task 3: Package a Remote-Only Sidecar (PR 5A, `stella`)

**Files:**

- Modify: `packaging/docker/Dockerfile.serve`
- Modify: `docs/design/serve-surface.md`
- Modify: `docs/design/serve-surface.fleet.toml`
- Create: `packaging/docker/serve-entrypoint.sh`
- Create: `scripts/check-serve-image.sh`

- [ ] Make hosted mode remote-only at compile/configuration time; startup must fail if any local tool or provider mode is requested.
- [ ] Run the container as a non-root user with a read-only root filesystem, no mounted Docker socket, no cloud credential environment variables, and an explicit writable temporary directory only.
- [ ] Expose the binary revision and both protocol versions through `/v1/meta`; pin the image by digest in Oxagen deployment configuration.
- [ ] Add a container smoke check that starts the image, validates authentication, compares `/v1/meta`, executes the golden scripted session, and proves the container has no repository mount or local tool surface.
- [ ] Run `scripts/check-serve-image.sh`; expect pass.
- [ ] Commit: `build(serve): harden the remote-only sidecar image`

## Task 4: Create the Oxagen Stella Client (PR 5B, `oxagen-platform`)

**Files:**

- Create: `packages/stella-engine-client/package.json`
- Create: `packages/stella-engine-client/tsconfig.json`
- Create: `packages/stella-engine-client/vitest.config.ts`
- Create: `packages/stella-engine-client/src/protocol.ts`
- Create: `packages/stella-engine-client/src/sse.ts`
- Create: `packages/stella-engine-client/src/client.ts`
- Create: `packages/stella-engine-client/src/host.ts`
- Create: `packages/stella-engine-client/src/index.ts`
- Create: `packages/stella-engine-client/src/protocol.test.ts`
- Create: `packages/stella-engine-client/src/client.test.ts`
- Create: `packages/stella-engine-client/fixtures/host-protocol-v1.jsonl`
- Create: `packages/stella-engine-client/fixtures/manifest.json`
- Modify: `pnpm-lock.yaml`

- [ ] Vendor the merged PR 5A golden transcript and record its Stella commit, protocol/event versions, feature set, and per-file digest in the fixture manifest. Write `protocol.test.ts` first and deep-compare every Zod-decoded frame with the Rust fixture.
- [ ] Implement strict pinned decoders for `stella-host/v1` and `stella-agent-event/v1`; reject unknown fields, unsupported features, duplicate/gapped `engine_seq`, duplicate request IDs, and frames after terminal.
- [ ] Implement an SSE client with bounded frames, idle timeout, cancellation, retry disabled after session creation, and redacted error logging. Never retry a reverse request under a new request ID.
- [ ] Define `StellaHostPorts` as host-owned callbacks for context, model, tool, command, approval, repository status/structure, and candidate workspace lifecycle. The client contains no direct database, KMS, GitHub, or sandbox implementation.
- [ ] Require `/v1/meta` protocol, event-schema, feature-set, and pinned build checks before creating a session. Return a typed unavailable/incompatible error; do not fall back to another engine inside the client.
- [ ] Test disconnect before model, disconnect after a tool result, duplicate terminal, mismatched response, cancellation, and oversized frames.
- [ ] Run `pnpm --filter @oxagen/stella-engine-client test:unit`; expect pass.
- [ ] Run `pnpm --filter @oxagen/stella-engine-client typecheck`; expect pass.
- [ ] Commit: `feat(agent): add a strict Stella sidecar client`

## Task 5: Adapt Governed Oxagen Ports and Evidence (PR 5B, `oxagen-platform`)

**Files:**

- Create: `packages/agent/src/runtime/engine-adapter.ts`
- Create: `packages/agent/src/runtime/stella-host.ts`
- Create: `packages/agent/src/runtime/stella-host.test.ts`
- Create: `packages/agent/src/runtime/evidence-conformance.test.ts`
- Modify: `packages/agent/src/runtime/turn-driver.ts`
- Modify: `packages/agent/src/runtime/turn-driver.test.ts`
- Modify: `packages/agent/src/index.ts`
- Modify: `packages/agent/package.json`
- Modify: `packages/agent-worker/src/main.ts`
- Modify: `packages/config/src/registry.ts`
- Modify: `packages/config/src/registry.test.ts`
- Modify: `packages/config/src/env.ts`
- Modify: `packages/config/src/env.test.ts`
- Modify: `.env.example` via `pnpm env:check --write`

- [ ] Write an `EngineAdapter` interface whose input is the validated claimed `RunSpecV2`, attempt, fenced IO, sandbox workspace, and receipt sink. Its output is a terminal engine result, never a manifest.
- [ ] Wrap the existing TypeScript path in `TypeScriptEngineAdapter` without changing behavior. Implement `StellaEngineAdapter` with `@oxagen/stella-engine-client` at the same seam.
- [ ] Implement `stella-host.ts` so authorized CGP candidate frames and bounded workspace bytes cross host ports, while Stella selects/compiles them and owns local graph extractor/generation semantics. Validate Stella's ordered compiled frame/generation claims against bytes the host served, preserve exact citation conformance without title repair, and record `FrameUseReceiptV1` plus rendered-content digests at the model boundary.
- [ ] Route every Stella model request through the existing model gateway and record exact raw transport request/response/error, resolved configuration, usage, and ordered context-selection/compiled-content digests before replying.
- [ ] Materialize every Stella tool and command against the attempt's sandbox. Tool calls invoke the canonical capability through `kernel.invoke()` with the existing `AgentRunIAMContext`; command and verification results record environment/output digests and explicit unavailable outcomes.
- [ ] Create/wait for approvals through the existing approval subsystem and record only host-minted approval/authorization references. Stella cannot submit those identifiers.
- [ ] Bind candidate workspace handles to the attempt and sandbox parent; expire them on terminal/cancellation and ensure adopt is atomic. Publication remains a separate governed host operation after verification.
- [ ] Append each Stella event through fenced attempt IO, preserving `engine_seq` in payload while assigning authoritative `run_seq` and `attempt_seq`. A gap or schema mismatch terminates the attempt and remains visible in stage coverage.
- [ ] Build the envelope from host receipts plus the authoritative event log. Do not infer exact evidence from presentation-oriented `AgentEvent` fields.
- [ ] Add worker-only configuration for sidecar URL, bearer token, pinned protocol/event versions, allowed feature set, build revision, and image digest. Tag it to the `agent-executor` workload registry; bootstrap must reject missing, local-fallback, or incompatible values before a Stella/shadow attempt is admitted.
- [ ] Run the same valid/invalid envelope fixture corpus through `TypeScriptEngineAdapter` and `StellaEngineAdapter` test producers; normalize nondeterministic timestamps and IDs only at fixture setup, never in production hashing.
- [ ] Run `pnpm --filter @oxagen/agent test:unit -- stella-host.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/agent test:unit -- evidence-conformance.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/agent test:unit -- turn-driver.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/config test:unit -- src/env.test.ts src/registry.test.ts`; expect pass.
- [ ] Run `pnpm env:check`; expect pass.
- [ ] Commit: `feat(agent): adapt Stella to governed host ports`

## Task 6: Add Non-Publishing Shadow Parity (PR 5B, `oxagen-platform`)

**Files:**

- Create: `packages/agent/src/runtime/shadow-engine.ts`
- Create: `packages/agent/src/runtime/shadow-engine.test.ts`
- Create: `packages/agent/src/runtime/parity.ts`
- Create: `packages/agent/src/runtime/parity.test.ts`
- Create: `packages/agent-worker/src/shadow-parity-worker.ts`
- Create: `packages/agent-worker/src/shadow-parity-worker.test.ts`
- Create: `packages/database/src/schema/engine-parity.ts`
- Create: `packages/database/atlas/migrations/20260806150000_engine_shadow_parity.sql`
- Create: `packages/database/integration/engine-shadow-parity.test.ts`
- Modify: `packages/database/src/schema/index.ts`
- Modify: `packages/database/src/relations.ts`
- Modify: `packages/database/src/types.ts`
- Modify: `packages/database/atlas/migrations/atlas.sum`
- Modify: `packages/database/storage-manifest.json`
- Create: `packages/agent/fixtures/engine-parity/manifest.json`
- Create: `packages/agent/fixtures/engine-parity/completed.json`
- Create: `packages/agent/fixtures/engine-parity/denied.json`
- Create: `packages/agent/fixtures/engine-parity/failed-verification.json`
- Modify: `packages/agent/src/runtime/turn-driver.ts`
- Modify: `packages/config/src/registry.ts`
- Modify: `packages/config/src/registry.test.ts`
- Modify: `packages/config/src/env.ts`
- Modify: `packages/config/src/env.test.ts`
- Modify: `.env.example` via `pnpm env:check --write`

- [ ] Define `ENGINE_SHADOW_MODE=off|stella` and a Stella image/build allowlist. Do not expose an `ENGINE=stella` production choice in this PR.
- [ ] Create the shadow sandbox under the same org/workspace tenant scope and immutable base commit/tree, but with a distinct sandbox/parity public ID, branch namespace, event namespace, tool idempotency namespace, and retention label. Never invent a different Oxagen workspace ID merely for isolation.
- [ ] Replace all mutating/publication ports in shadow mode with isolated equivalents. GitHub branch/commit/PR creation, external writes, notifications, and non-idempotent third-party tools are hard denied; they are not mocked as successful provider receipts.
- [ ] Create immutable `evidence.engine_parity_obligations` and fenced mutable claim state plus immutable parity artifact rows. The primary finalization transaction inserts the off-by-default obligation; the `agent-executor` shadow worker claims it asynchronously after the primary terminal result, so it cannot extend the primary lease or alter its manifest. Store shadow evidence as a separate non-authoritative parity artifact linked to fixture/source run/manifest, never as a second primary attempt.
- [ ] Compare schema validity, reached-stage shape, tool intent classes, change digests in the isolated checkout, verification verdicts, terminal class, missing-evidence gaps, and usage/cost envelopes. Do not require byte-identical model prose.
- [ ] Cover completed, denied-before-model, cancelled, tool-denied, provider-error, failed-verification, and sidecar-disconnect fixtures. Fail the parity gate on any missing receipt category or unclassified divergence.
- [ ] Regenerate `.env.example` from the registry; do not edit it manually.
- [ ] Run `pnpm --filter @oxagen/agent test:unit -- shadow-engine.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/agent test:unit -- parity.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/agent-worker test:unit -- src/shadow-parity-worker.test.ts`; expect pass with event-loss/duplicate/crash recovery.
- [ ] Run `pnpm --filter @oxagen/database test:integration -- integration/engine-shadow-parity.test.ts`; expect pass.
- [ ] Run `pnpm schema:manifest && pnpm schema:manifest:check`; expect pass.
- [ ] Run `pnpm --filter @oxagen/config test:unit -- src/env.test.ts src/registry.test.ts`; expect pass.
- [ ] Run `pnpm env:check`; expect pass.
- [ ] Commit: `test(agent): gate Stella on isolated shadow parity`

## Task 7: Deploy Preview-Only and Record the Production Gate (PR 5B, `oxagen-platform`)

**Files:**

- Create: `ops/stella-engine/README.md`
- Create: `ops/stella-engine/modal_app.py`
- Create: `ops/stella-engine/requirements.txt`
- Modify: `docker-compose.dev.yml`
- Modify: `tools/scripts/dev.ts`
- Modify: `infra/modules/agent-worker/main.tf`
- Modify: `infra/modules/agent-worker/variables.tf`
- Modify: `docs/specs/agent-engine-v2/stella-sidecar-service.md`
- Modify: `docs/specs/run-evidence-ingress/plan.md`

- [ ] Add an opt-in local `stella` Compose profile pinned to a PR 5A image digest. Default development remains TypeScript-only.
- [ ] Add preview deployment, token rotation, private networking, health/build compatibility, rollback, and incident steps to the runbook. Route the sidecar endpoint/token/build pins only to the `agent-executor` workload through the Task 3 workload registry and infrastructure module; never put the bearer token in image layers or logs.
- [ ] Run the recorded parity corpus against the deployed preview and attach the manifest digest, Stella build revision, Oxagen revision, fixture version, and exact package-scoped command output to PR 5B.
- [ ] Record—but do not enable—the later production gate: all fixture cases pass, no unexplained receipt gaps, cost/latency bounds approved, cancellation and denial tests green, image pinned, on-call/rollback exercised, and an explicit follow-up approval changes the engine admission allowlist.
- [ ] Update the older sidecar companion anywhere it suggests silent fallback or direct surface integration. The durable `RunSpecV2` admission decision is the only engine selector for governed runs.
- [ ] Run `pnpm --filter @oxagen/stella-engine-client test:unit`; expect pass against the preview mock/contract suite.
- [ ] Commit: `docs(agent): define the Stella production admission gate`

## PR 5 Exit Criteria

- [ ] The Stella image drives `stella-pipeline`, not only `stella-core::Engine::run_turn`.
- [ ] Hosted Stella has no ambient tools, repository, provider, publication, IAM, KMS, or evidence-signing authority.
- [ ] TS and Stella producers pass the same run-evidence contract fixtures.
- [ ] A sidecar disconnect creates a finalized failed attempt with explicit coverage gaps; it never resumes under the TypeScript engine.
- [ ] Shadow Stella can mutate only its isolated non-publishing checkout.
- [ ] Production admission still allows only the TypeScript engine until a separately approved rollout changes the allowlist.
