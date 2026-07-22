# Deterministic Lifecycle Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute typed, kernel-governed lifecycle capabilities outside model discretion with bounded prompt patches, principal-correct authorization, finalization guarantees, and durable receipts.

**Architecture:** RunSpec V2 carries an origin principal reference that is re-resolved at execution. Agent activation compiles lifecycle TOML against capability opt-in metadata. A dispatcher emits only model-loop lifecycle events, invokes through the kernel with recursion guards and stable idempotency context, buffers contracted output, runs blocking `before_finalize`, atomically commits terminal state plus `after_turn` outbox obligations, and records canonical receipts.

**Tech Stack:** TypeScript, Zod, `@oxagen/agent-artifacts`, capability kernel, agent runner/worker, Drizzle/Postgres, Inngest, Vitest.

## Global Constraints

- IAM uses current grants and delegation intersections, never a copied grant snapshot.
- Lifecycle eligibility is orthogonal to public capability surfaces.
- Every lifecycle handler runs through `invoke()`.
- Prompt patches cannot broaden tools, identity, permissions, or lifecycle configuration.
- Model-selected tool events never recurse for lifecycle/nested kernel calls.
- `before_finalize` blocks delivery; `after_turn` is durable post-commit observation.
- Run only narrow tests.

---

### Task 1: Add lifecycle schemas to canonical agent artifacts

**Files:**
- Create: `packages/agent-artifacts/src/lifecycle.ts`
- Test: `packages/agent-artifacts/src/lifecycle.test.ts`
- Modify: `packages/agent-artifacts/src/schemas.ts`
- Modify: `packages/agent-artifacts/src/index.ts`

**Interfaces:** `LifecycleEvent`, `LifecycleInvocation`, `PromptPatch`, `LifecycleEventEnvelope`, `LifecycleInvocationReceipt`.

- [ ] Write failing tests for every event, input pointer/literal exclusivity, legal `when`, retry/idempotency combinations, prompt-patch event restrictions, and strict unknown-field rejection.
- [ ] Implement schemas exactly as the design, including `before_finalize` and post-commit `after_turn` semantics.
- [ ] Run `pnpm --filter @oxagen/agent-artifacts test:unit -- lifecycle.test.ts`; expect PASS.
- [ ] Commit with `git commit -m "feat(agent-artifacts): define lifecycle contracts"`.

### Task 2: Add capability lifecycle eligibility and kernel execution context

**Files:**
- Modify: `packages/oxagen/src/types.ts`
- Modify: `packages/oxagen/src/registry.ts`
- Modify: `packages/oxagen/src/kernel.ts`
- Modify: `packages/oxagen/package.json`
- Modify: `packages/oxagen/src/kernel.test.ts`
- Modify: `packages/oxagen/src/registry.test.ts`

**Interfaces:**
- `CapabilityDeclaration.lifecycle?: CapabilityLifecycleMetadata`
- `CheckedContext.idempotencyKey?: string`
- `InvokeOptions.execution?: { kind: "lifecycle"; event: LifecycleEvent; invocationId: string; depth: number; idempotencyKey: string }`

- [ ] Write kernel tests proving ineligible/event-mismatched capabilities fail before handler load, runner audit attribution remains `runner`, strict input does not receive the idempotency key, mutating retry metadata is visible, and depth/cycle violations fail closed.
- [ ] Implement registry validation and kernel enforcement without adding `runner` to public `CapabilitySurface`.
- [ ] Run the two focused tests and `pnpm --filter @oxagen/oxagen typecheck`; expect PASS.
- [ ] Commit with `git commit -m "feat(kernel): enforce lifecycle capability eligibility"`.

### Task 3: Introduce RunSpec V2 with principal re-resolution

**Files:**
- Modify: `packages/agent/src/runtime/turn-driver.ts`
- Modify: `packages/agent/src/runtime/turn-driver.test.ts`
- Create: `packages/iam/src/run-principal-resolver.ts`
- Create: `packages/iam/src/run-principal-resolver.test.ts`
- Modify: `packages/iam/src/bootstrap.ts`
- Modify: `apps/api/src/routes/v1/agent.run.ts`
- Modify: `apps/api/src/__tests__/routes.agent-run.test.ts`
- Modify: `packages/agent-runner/src/{execute-turn,run-store}.ts`
- Modify their co-located tests.

**Interfaces:** `RunSpecV2 { version: 2; agentArtifact; input; principalRef; delegationRef?; ... }`; injected `RunPrincipalResolver` reuses the IAM spine without adding a direct agent-to-IAM dependency cycle.

- [ ] Write tests proving enqueue captures user/API-key/service/agent references, grants are not copied, claim re-resolves current authority, revoked/expired/deleted identities fail before tools/model, and v1 receives an explicit unsupported-version error after cutover.
- [ ] Implement V2 parsing and principal resolution through the existing IAM spine; carry the resolved principal into every lifecycle `CapabilityContext`.
- [ ] Run focused agent, route, and runner tests; expect PASS.
- [ ] Commit with `git commit -m "feat(agent-runner): carry principals in RunSpec V2"`.

### Task 4: Compile lifecycle configuration at agent activation

**Files:**
- Create: `packages/agent/src/runtime/lifecycle/compile.ts`
- Test: `packages/agent/src/runtime/lifecycle/compile.test.ts`
- Modify: `packages/agent/src/handlers/agent.definition.publish.ts`
- Modify: `packages/agent/src/handlers/agent.definition.publish.test.ts`

- [ ] Write tests for unknown capability, absent metadata, illegal event/output kind, unsafe mutation retry, missing schema, unresolved tools, and a valid ordered compiled plan.
- [ ] Implement `compileLifecyclePlan(agent, registry, artifactDir)` returning immutable resolved invocations and compiled JSON Schemas.
- [ ] Persist the artifact hash and compiled-plan hash with the published version; do not persist handler objects.
- [ ] Run focused tests; expect PASS.
- [ ] Commit with `git commit -m "feat(agent): compile lifecycle plans on publish"`.

### Task 5: Implement event dispatch, input mapping, prompt patches, and receipts

**Files:**
- Create under `packages/agent/src/runtime/lifecycle/`: `dispatcher.ts`, `input-map.ts`, `prompt-patch.ts`, `receipts.ts`
- Create co-located tests for each.
- Modify: `packages/agent/src/runtime/turn-driver.ts`
- Modify: `packages/agent-engine/src/engine.ts` and its focused tests to expose normalized model/tool event seams.

- [ ] Write tests for declaration order, JSON Pointer/literal mapping, required missing inputs, kernel-only dispatch, timeout/abort, optional continue, stable idempotency keys, prompt patch bounds/order/hashes, model-tool-only events, and cycle rejection.
- [ ] Implement one dispatcher around normalized engine callbacks. `before_tool_call` can deny/narrow/request approval but cannot widen the already-resolved tool policy.
- [ ] Hash structured values through `hashCanonicalJson`; store hashes and safe metadata only.
- [ ] Run the new lifecycle tests plus the touched engine test; expect PASS.
- [ ] Commit with `git commit -m "feat(agent): dispatch deterministic lifecycle events"`.

### Task 6: Add finalization state and durable after-turn outbox

**Files:**
- Modify: `packages/database/src/schema/agent.ts`
- Create migration: `packages/database/atlas/migrations/20260721190000_agent_lifecycle_outbox.sql`
- Modify: `packages/agent-runner/src/run-store.ts`
- Modify: `packages/agent-worker/src/{types,terminal,worker}.ts`
- Create: `packages/inngest-functions/src/functions/agent.lifecycle-after-turn.ts`
- Create corresponding focused tests.

**Interfaces:** transactional `finalizeRun(runId, terminal, receipts, obligations)` and leased outbox claim/complete/dead-letter operations.

- [ ] Write database/store tests proving `running -> finalizing -> terminal`, terminal+outbox atomicity, no output before commit, at-least-once leasing, stable idempotency, bounded retry, and dead-letter without terminal rewrite.
- [ ] Add schema/migration using UUID/public_id conventions, tenant scope, attempt/lease fields, unique `(run_id, invocation_id)`, and append-only receipt payloads.
- [ ] Implement worker finalization and Inngest delivery through `invoke()` with re-resolved principal.
- [ ] Regenerate Atlas hash and run `pnpm db:lint-migrations` plus only agent-runner/worker/Inngest focused tests.
- [ ] Commit with `git commit -m "feat(agent-runner): finalize runs with lifecycle outbox"`.

### Task 7: Verify end-to-end guarantees and document lifecycle contracts

**Files:**
- Create: `packages/agent/src/runtime/lifecycle/lifecycle.integration.test.ts`
- Create: `docs/guides/agent-lifecycle-invocations.md`
- Update agent/capability reference docs and relevant capability metadata examples.

- [ ] Add an integration test covering input schema -> pre-intelligence patch -> model -> selected tool authorization -> output schema -> before-finalize -> terminal+outbox -> after-turn receipt.
- [ ] Add negative paths for revoked principal, invalid patch, non-idempotent retry, lifecycle recursion, MCP timeout, cancellation, and dead-letter.
- [ ] Document events, envelope fields, capability opt-in metadata, failure policy, finalization, buffered delivery, hashes, and operational recovery.
- [ ] Run only lifecycle integration/unit tests, kernel tests, and affected runner/worker files; expect PASS.
- [ ] Run `pnpm check:contracts`, `pnpm check:manifest`, and `pnpm db:lint-migrations`; expect PASS.
- [ ] Commit with `git commit -m "docs: document deterministic agent lifecycle contracts"`.
