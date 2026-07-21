# Enterprise Agent IAM Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Oxagen's human-centric, capability-only IAM path with one fail-closed identity and policy foundation for human, agent, and service principals, explicit node-label/relationship/tool grants, versioned roles, exact approvals, and transactionally durable audit evidence.

**Architecture:** `@oxagen/oxagen` owns dependency-free authorization types and the pure deny-biased resolver. `@oxagen/iam` owns tenant-scoped persistence, policy mutation transactions, runtime loading, exact approval claims, simulation, and read models. PostgreSQL remains authoritative for identities and policy, including an immutable event commitment plus mutable delivery outbox; ClickHouse remains the query/evidence projection. Every grant is an exact structured tuple, roles are stable identities with immutable published versions, authority unions only within one principal and intersects across a principal chain, and the kernel receives a durable decision before releasing a result or starting a side effect.

**Tech Stack:** TypeScript 6, Zod 3, Drizzle ORM 0.45, PostgreSQL 16 with RLS, Atlas migrations, Hono, xmcp, Inngest, ClickHouse 24.8, Vitest, pnpm workspaces.

## Global Constraints

- The canonical contract is `docs/specs/agent-rbac/spec.md`; its security invariants win over legacy tests, comments, seed behavior, and compatibility assumptions.
- This is a hard pre-launch IAM cutover. Do not add `Agent Legacy`, dual reads, creator-inherited API-key authority, permissive backfills, synthetic principals, zero-UUID scope sentinels, or a plan-tier authorization bypass.
- `iam.principals` is the only identity spine: human subjects bind to `auth.users.id`, agents bind to `agent.agents.id`, and services bind to `iam.service_accounts.id`. Do not add `agents.principal_id` or derive agent authority from ownership.
- Phase 1 stores and resolves node-label and relationship-type grants but does not claim graph retrieval enforcement; the authorized context broker and pre-ranking enforcement ship in Phase 3.
- Property-level IAM remains explicitly out of scope. Do not add property grant rows or post-retrieval field stripping. Context-safe projections continue to exclude operational values for every principal.
- Phase 1 implements exact-execution and temporary-access approval state. Phase 2 owns persisted delegations, authorization snapshots, `RunSpecV2`, and durable run admission. Phase 5 owns access-review persistence and cryptographically signed permission exports.
- Graph labels, relationship types, MCP tools, skills, and agent dispatch are workspace-only resources. Capability contracts explicitly declare whether they are grantable at org scope, workspace scope, or both.
- Management capabilities are `noBillingGate: true`, `sensitivity: "high"`, default deny, exposed on API and MCP only, and seeded with explicit Owner/Admin management grants. Read/simulate/export operations also seed Compliance access. They are never exposed on the agent surface.
- PostgreSQL policy writes use `withTenantDb` and accept the caller's existing transaction. `withSystemDb` is limited to named cross-tenant projector/sweeper jobs, credential-to-principal lookup constrained by credential hash/id, and one authenticated `bootstrapOrganizationIamTx` boundary used before a tenant exists. Ordinary tenant handlers cannot call the bypass. Raw `db()` is prohibited.
- A policy mutation, its org policy-version increment, immutable audit event, and outbox delivery row commit together. ClickHouse failure cannot roll back policy and cannot erase the delivery obligation.
- Policy mutations and runtime admission contend on the same org policy-version row. Runtime authority reads, resolution, and durable allow/deny/approval recording share one transaction; a version-changing mutation cannot commit between resolution and admission evidence.
- Runtime allow, deny, and approval outcomes are durably recorded before an agent-visible result or side effect. Exact approval claims and final execution decisions are never cached.
- Phase 1 runtime admission resolves exactly one server-authenticated acting principal. Capability input can never supply that acting identity or its authority chain. IAM management input may name a target principal by public ID, but target identity never populates caller authority. Ordered multi-principal input exists only in the pure resolver and privileged simulator until Phase 2 introduces persisted delegations and `RunSpecV2`.
- Authorization-binding hashes cover the complete canonical normalized input/plan and persist only the digest. Redacted audit payloads/diffs are separate values with separate hashes; redaction never defines approval equivalence.
- Unknown and denied resources are indistinguishable to non-admin callers. Logs and audit payloads contain identifiers/hashes and metadata, never credentials, prompts, retrieved context, graph property values, or inferred forbidden names.
- All clocks, UUID generation, canonical hashing, and current policy versions are injectable in tests. The pure resolver never calls `new Date()` or performs I/O.
- Published role versions and their grants are immutable. Draft edits use compare-and-swap on `draftRevision`; publish uses both `expectedDraftRevision` and `baseActiveVersionId`. Last-write-wins is prohibited.
- Run only the narrow tests named by each task. Never run `pnpm gate` or the full test fleet mid-task, never reduce coverage thresholds, and use concurrency 1 if final affected-package tests contend for memory.
- Preserve unrelated worktree changes. In particular, do not adopt any creator-owned principal witness that expects `parentUserId` or `agents.principalId`; tests must assert the canonical `subject_id` binding instead.

## Frozen Phase 1 Interfaces

The first task freezes these names for downstream Phase 2-5 work:

```ts
type AuthorizationScope =
  | { kind: "org"; orgId: string }
  | { kind: "workspace"; orgId: string; workspaceId: string };

type IamResourceRef =
  | { kind: "graph_node_label"; resourceId: string; action: "read" | "extend" }
  | { kind: "graph_relationship_type"; resourceId: string; action: "traverse" | "extend" }
  | { kind: "capability"; resourceId: string; action: "invoke" }
  | { kind: "mcp_tool"; resourceId: string; action: "call" }
  | { kind: "skill"; resourceId: string; action: "load" }
  | { kind: "agent"; resourceId: string; action: "dispatch" };

type AuthorizationDecision = {
  decisionId: string;
  outcome: "allow" | "deny" | "require_approval";
  policyVersion: string;
  effectiveScopeHash: string;
  validUntil: string;
  reasonCode: IamReasonCode;
  trace: DecisionTrace;
};
```

Resource IDs are stable public IDs or canonical registered names. Composite aliases such as `agent:<id>:dispatch` are never persisted.

---

### Task 1: Freeze the authorization model and stable IAM errors

**Files:**
- Create: `packages/oxagen/src/iam/model.ts`
- Create: `packages/oxagen/src/iam/model.test.ts`
- Create: `packages/oxagen/src/iam/canonical.ts`
- Create: `packages/oxagen/src/iam/canonical.test.ts`
- Create: `packages/oxagen/src/iam/errors.ts`
- Create: `packages/oxagen/src/iam/errors.test.ts`
- Modify: `packages/oxagen/src/iam/index.ts`
- Modify: `packages/oxagen/src/kernel.ts`
- Modify: `apps/api/src/middleware/error.ts`
- Modify: `apps/api/src/__tests__/error.test.ts`

**Interfaces:**
- Produces: `AuthorizationScope`, `PrincipalRef`, `PrincipalAuthority`, `IamResourceKind`, `IamResourceRef`, `IamEffect`, `IamOutcome`, `IamReasonCode`, `DecisionTrace`, `AuthorizationDecision`, `IamErrorCode`, `IamError`, `canonicalizeIamValue`, `canonicalIamJson`, and `hashIamValue`.
- Freezes: the discriminated authorization scope consumed when Task 5 performs the repository-wide `CapabilityContext` cutover. Task 1 does not make that field required prematurely, so this commit remains independently type-correct.
- Public runtime codes include the §11.1 codes relevant to Phase 1: authorization/approval/policy unavailable, role not found/version/draft/archive/system-role, scope/resource mismatch, principal inactive, last owner, tier packaging denial, catalog unavailable, approval replay, and input changed.

- [ ] **Step 1: Write failing model and error tests**

Test exhaustive resource/action pairing, org/workspace scope parsing, decimal policy versions, deterministic trace serialization, no zero UUIDs, no composite aliases, and API status mapping. Canonicalization tests cover recursively sorted keys, preserved array order, stable SHA-256, and rejection of `undefined`, functions, cycles, non-finite numbers, and nondeterministic values. Assert an unknown resource and denied resource map to the same public `403 iam_authorization_denied` response for a non-admin caller.

- [ ] **Step 2: Run the tests and confirm failure**

Run: `pnpm --filter @oxagen/oxagen test:unit -- src/iam/model.test.ts src/iam/canonical.test.ts src/iam/errors.test.ts`

Run: `pnpm --filter @oxagen/api test:unit -- src/__tests__/error.test.ts`

Expected: FAIL because the model, codes, and discriminated authorization scope do not exist.

- [ ] **Step 3: Implement strict model types and Zod schemas**

Use discriminated unions for both scope and resources. Reject an org scope carrying `workspaceId`, a workspace scope without one, empty IDs, all-zero UUIDs where UUIDs are required, and actions invalid for a resource kind. Keep `PrincipalRef` limited to `{ id, kind, subjectId, status, orgId, workspaceId? }`; ownership and display metadata are not authority.

Represent `policyVersion` as a base-10 string at package boundaries and `bigint` only inside persistence. `validUntil` is the earliest authority expiry; when none exists, use `9999-12-31T23:59:59.999Z` and let the cache apply its shorter local TTL.

- [ ] **Step 4: Implement typed errors and API mapping**

Add a stable `code` field and structured safe details. Map authentication to 401, opaque denial to 403, approval required to 409, role/draft conflicts to 409 with current server revisions, unavailable policy/catalog to 503, and invalid admin-authored scope to 422. Never return resolver traces to non-admin runtime callers.

- [ ] **Step 5: Run focused tests and types**

Run: `pnpm --filter @oxagen/oxagen test:unit -- src/iam/model.test.ts src/iam/canonical.test.ts src/iam/errors.test.ts`

Run: `pnpm --filter @oxagen/api test:unit -- src/__tests__/error.test.ts`

Run: `pnpm --filter @oxagen/oxagen typecheck && pnpm --filter @oxagen/api typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/oxagen/src/iam packages/oxagen/src/kernel.ts apps/api/src/middleware/error.ts apps/api/src/__tests__/error.test.ts
git commit -m "feat(iam): freeze enterprise authorization model"
```

### Task 2: Replace the resolver with deny-biased chain intersection

**Files:**
- Rewrite: `packages/oxagen/src/iam/resolve.ts`
- Rewrite: `packages/oxagen/src/iam/resolve.test.ts`
- Remove: `packages/oxagen/src/iam/conditions.ts`
- Remove: `packages/oxagen/src/iam/conditions.test.ts`
- Modify: `packages/oxagen/src/iam/index.ts`

**Interfaces:**
- Produces: `resolveAuthorization(input: ResolveAuthorizationInput): AuthorizationDecision`.
- Input contains `now`, `decisionId`, `policyVersion`, exact `scope`, exact `resource`, ordered `principalAuthorities`, and optional requested ceilings. It contains no database handles, contract `defaultEffect`, subscription tier, ambient clock, or synthetic Owner flag.

- [ ] **Step 1: Replace legacy tests with the canonical resolution matrix**

Cover at minimum: deny over approval/allow across multiple roles; approval over allow; implicit deny; exact resource/action matching; org plus exact-workspace assignment aggregation; invalid resource scope; inactive/cross-org/cross-workspace principal; agent/human/service kinds; non-delegable grants removed at an act-as boundary; chain intersection in both directions; requested ceilings only narrowing; assignment expiry at the injected clock; earliest `validUntil`; stable effective-scope hashing; and identical output when input order differs semantically.

Add regression tests proving Owner has no synthetic authority, `defaultEffect: "allow"` cannot enter the resolver, direct grants and role inheritance are absent, and a new label/tool not present in a published role is denied.

- [ ] **Step 2: Run the resolver tests and confirm legacy failures**

Run: `pnpm --filter @oxagen/oxagen test:unit -- src/iam/resolve.test.ts`

Expected: FAIL because current resolution allows before deny, uses `new Date()`, synthesizes Owner, and lacks chain intersection/decision metadata.

- [ ] **Step 3: Implement per-principal union followed by chain intersection**

For each principal: validate identity/scope/status; collect active matching grants; resolve `deny > require_approval > allow > implicit deny`; calculate that principal's expiry; then intersect outcomes and requested ceilings. Build an administrator-safe trace from role/version/grant IDs and reason codes only. Hash the canonical effective tuple with sorted IDs and canonical JSON.

- [ ] **Step 4: Remove undeclared condition-language and fallback paths**

Delete the condition evaluator after `rg` confirms no non-IAM consumer. Time bounds come only from assignment, credential, approval, and later delegation/snapshot expiry. Remove direct-grant, policy-language, contract-default, tier, and synthetic-principal branches from the resolver API.

- [ ] **Step 5: Verify determinism and types**

Run: `pnpm --filter @oxagen/oxagen test:unit -- src/iam/resolve.test.ts`

Run: `pnpm --filter @oxagen/oxagen typecheck`

Expected: PASS with no test reading the wall clock.

- [ ] **Step 6: Commit**

```bash
git add packages/oxagen/src/iam
git commit -m "feat(iam): enforce deny-biased authority intersection"
```

### Task 3: Make capability scope an explicit registry contract

**Files:**
- Modify: `packages/oxagen/src/types.ts`
- Modify: `packages/oxagen/src/registry.ts`
- Modify: `packages/oxagen/src/registry.test.ts`
- Modify: `packages/oxagen/src/contracts/*.ts` for every production `registerCapability` declaration
- Modify: every `CapabilityDeclaration`/`registerCapability` test fixture found by `rg -l 'registerCapability\(|CapabilityDeclaration' packages/oxagen/src -g '*.test.ts'`
- Modify: `packages/oxagen/src/contracts/capability.registry.list.ts`
- Modify: `packages/oxagen/src/contracts/capability.registry.list.test.ts`
- Modify: `tools/scripts/check-contracts.mjs`
- Modify: `tools/scripts/check_manifest.mjs`
- Modify: `tools/scripts/check_manifest.test.ts`
- Regenerate: `packages/oxagen/src/contracts.generated.ts`
- Regenerate: `packages/oxagen/capabilities.manifest.json`

**Interfaces:**

```ts
type CapabilityAuthorizationMetadata =
  | { grantable: true; scopeKinds: readonly ["org"] | readonly ["workspace"] | readonly ["org", "workspace"] }
  | { grantable: false; scopeKinds: readonly [] };
```

Add required `authorization` metadata to `CapabilityDeclaration` and `CapabilityManifestEntry`. A grantable capability is represented by `{ kind: "capability", resourceId: capability.name, action: "invoke" }`.

- [ ] **Step 1: Write failing registry and manifest assertions**

Assert every registered production contract explicitly classifies itself, scope lists are unique/canonical, `grantable:false` has no scope, seeded org grants require org scope, seeded workspace grants require workspace scope, and no app/API/MCP manifest can omit the classification.

- [ ] **Step 2: Run the checks and confirm failure**

Run: `pnpm --filter @oxagen/oxagen test:unit -- src/registry.test.ts src/contracts/capability.registry.list.test.ts`

Run: `pnpm check:contracts`

Expected: FAIL for every unclassified contract.

- [ ] **Step 3: Classify every capability deliberately**

Use existing org/workspace default-role entries only to generate a review report, not as a runtime fallback. Manually resolve contracts with empty or mixed defaults. Pre-tenant authentication/bootstrap capabilities are `grantable:false`; tenant data/control capabilities are grantable at the narrowest valid scope. Add a review assertion that `graph_*`, MCP, skill-load, agent-execution, sandbox, and workspace data capabilities cannot be org-scoped accidentally.

- [ ] **Step 4: Expose metadata through the registry read model**

Return grantability and valid scope kinds from `list_capability_registry` so the Phase 1 resource catalog and Phase 4 editor consume the same declaration. Do not infer scope in the client.

- [ ] **Step 5: Run registry, manifest, and naming gates**

Run: `pnpm --filter @oxagen/oxagen test:unit -- src/registry.test.ts src/contracts/capability.registry.list.test.ts`

Run: `pnpm check:contracts && pnpm check:manifest --json`

Run: `pnpm --filter @oxagen/oxagen typecheck`

Expected: PASS with zero unclassified or scope-inconsistent contracts.

- [ ] **Step 6: Commit**

```bash
git add packages/oxagen/src packages/oxagen/capabilities.manifest.json tools/scripts/check-contracts.mjs tools/scripts/check_manifest.mjs tools/scripts/check_manifest.test.ts
git commit -m "feat(capabilities): declare IAM resource scopes"
```

### Task 4: Expand the IAM schema for the replacement model

**Files:**
- Modify: `packages/database/src/schema/iam.ts`
- Modify: `packages/database/src/schema/auth.ts`
- Modify: `packages/database/src/schema/index.ts`
- Modify: `packages/database/src/relations.ts`
- Modify: `packages/database/src/relations.test.ts`
- Rewrite: `packages/database/src/__tests__/iam-schema.test.ts`
- Modify: `packages/database/src/__tests__/schema-smoke.test.ts`
- Modify: `packages/database/src/tenant-policy.manifest.ts`
- Modify: `packages/database/src/tenant-policy.manifest.test.ts`
- Create: `packages/database/atlas/migrations/20260804110000_enterprise_iam_expand.sql`
- Modify: `packages/database/atlas/migrations/atlas.sum`
- Create: `packages/database/integration/iam-rls.test.ts`
- Create: `tools/scripts/assert-local-db-target.ts`
- Create: `tools/scripts/assert-local-db-target.test.ts`

**Schema contract:**

- `iam.principals`: canonical `subject_id`, `kind`, `status`, nullable workspace, external identity/display projections, unconditional unique `(org_id, kind, subject_id)` across every lifecycle state; `subject_id` is nullable only during the staged branch migration and becomes required in Task 15. Restore/reactivate the same row rather than inserting a replacement identity.
- `iam.service_accounts`: stable identity, exact org/workspace scope, status, display name/description, creator principal, suspension metadata, soft deletion.
- `iam.roles`: stable identity, immutable scope, status/system flag, unique live name in exact scope, nullable `active_version_id`.
- `iam.role_versions`: role/scope, `draft|published`, version number, one active draft, `base_active_version_id`, `draft_revision`, eligible principal kinds, delegable flag, graph-budget ceiling, reason, author principal, manifest hash, timestamps.
- `iam.resource_grants`: role version plus denormalized exact scope, structured resource kind/id/action/effect, one live exact tuple; published-version rows cannot mutate.
- `iam.principal_role_assignments`: principal/stable role/exact scope, validity, reason, acting-principal attribution, soft revocation, active-only uniqueness.
- `iam.policy_versions`: one monotonic `bigint` counter per org.
- `iam.access_requests`: exact/temporary kind, ordered principal-chain hash, resource/action/scope, canonical input or graph-plan hash, request/run/step/decision IDs, requested role/TTL, policy version, reason, status, requester/approver principals, expiry/revocation.
- `iam.approval_authorizations`: exact-request/decision binding, chain/scope/resource/input/run/step/policy bindings, approver, expiry, revoked/consumed timestamps, unique single-use claim.
- `iam.authorization_obligations`: decision/resource/input binding and `admitted|completed|failed` state so an incomplete audit obligation is visible and retryable.
- `iam.audit_events`: immutable canonical event payload, actor/target principals, scope/resource/action, decision/policy IDs, hashes, redacted diff, outcome/reason, request/run/trace IDs, occurrence time, unique idempotency key.
- `iam.audit_outbox`: one mutable delivery row per event with available/lease/attempt/published/dead-letter fields; unique event ID.
- `iam.mutation_receipts`: request hash, idempotency key, safe result reference, resulting policy version/event ID, and completion status so mutation retries return the original outcome without repeating authority changes.
- `auth.api_keys`: canonical explicit `principal_id`, credential status/revocation, and no creator-based authorization semantics; the column is nullable only until Task 15 validates the cutover.

- [ ] **Step 1: Write failing schema and relation tests**

Assert all canonical columns, FKs that are valid during expansion, unconditional subject uniqueness, lifecycle-appropriate partial unique indexes, enum/check constraints, public-ID prefixes, same-org/workspace keys, one live draft, active-only assignment uniqueness, approval single-use fields, audit immutability, mutation receipts, and API-key principal binding. Explicitly enumerate the legacy fields/tables temporarily retained only to keep the branch buildable while Tasks 7-10 cut every reader/writer over; canonical services must not import them.

- [ ] **Step 2: Write failing RLS coverage tests**

Classify identity/policy tables with the established nullable-workspace policy and outbox/event rows with explicit tenant columns. Assert tenant reads cannot cross orgs or workspaces; org-scoped roles are visible only inside the same org; a worker using tenant scope cannot claim another tenant's outbox; only the named system projector can scan cross-tenant deliveries.

- [ ] **Step 3: Run focused database tests and confirm failure**

Run: `pnpm --filter @oxagen/database test:unit -- src/__tests__/iam-schema.test.ts src/relations.test.ts src/tenant-policy.manifest.test.ts`

Expected: FAIL because the replacement tables and constraints do not exist.

- [ ] **Step 4: Implement additive Drizzle schema and the expand migration**

Add the canonical columns/tables without activating a dual-read runtime. Existing legacy columns/tables remain physically present and exported only until all production readers/writers have moved; no new code may write them. Task 15 performs the approved reset, validation, `NOT NULL`/composite enforcement, and physical removal in one guarded cutover. Do not invent agent/service principals or use a zero UUID during expansion.

Install constraints that are safe before data cutover. Defer constraints requiring populated subject/credential bindings to Task 15. Use PostgreSQL triggers only for invariants impossible to express with Drizzle checks: immutable published role versions/grants and append-only audit events; enable subject source-kind and active-version ownership enforcement in the Task 15 contract migration.

- [ ] **Step 5: Regenerate the Atlas checksum and validate migrations**

Run: `(cd packages/database && atlas migrate hash --dir "file://atlas/migrations")`

Run: `pnpm db:lint-migrations && pnpm db:atlas-validate`

Expected: PASS; `atlas.sum` contains the ordered expand migration and no edited historical checksum.

Run: `pnpm exec vitest run tools/scripts/assert-local-db-target.test.ts`

Run: `pnpm exec tsx tools/scripts/assert-local-db-target.ts --atlas-env local && pnpm --filter @oxagen/database exec atlas migrate apply --env local --to-version 20260804110000`

Expected: the assertion reads the actual `env "local"` URL from `packages/database/atlas.hcl`, accepts only the exact local host/port/database allowlist, prints `postgres://***@localhost:5433/oxagen`, and the additive migration applies there. It never prints credentials.

- [ ] **Step 6: Run unit and real-Postgres RLS tests**

Run: `pnpm --filter @oxagen/database test:unit -- src/__tests__/iam-schema.test.ts src/__tests__/schema-smoke.test.ts src/relations.test.ts src/tenant-policy.manifest.test.ts`

Run:

```bash
env -u DATABASE_URL \
  DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
  TENANT_RLS_ENFORCEMENT_ENABLED=true \
  pnpm --filter @oxagen/database test:integration -- integration/iam-rls.test.ts integration/manifest-coverage.test.ts integration/rls.test.ts
```

Expected: PASS against the explicitly named local database.

- [ ] **Step 7: Commit**

```bash
git add packages/database/src packages/database/integration/iam-rls.test.ts packages/database/atlas/migrations tools/scripts/assert-local-db-target.ts tools/scripts/assert-local-db-target.test.ts
git commit -m "feat(database): add versioned enterprise IAM schema"
```

### Task 5: Thread discriminated org/workspace scope through tenancy and the kernel

**Files:**
- Modify: `packages/tenancy/src/scope.ts`
- Modify: `packages/tenancy/src/scope.test.ts`
- Modify: `packages/database/src/tenant.ts`
- Modify: `packages/database/src/tenant.test.ts`
- Modify: `packages/oxagen/src/kernel.ts`
- Modify: `packages/oxagen/src/kernel.tenant-scope.test.ts`
- Modify: `packages/oxagen/src/types.ts`
- Modify: `packages/oxagen/src/types.test.ts`
- Modify: `packages/agent/src/types.ts`
- Modify: every `CapabilityContext` literal/factory returned by `rg -l 'CapabilityContext|makeCTX|makeContext' apps packages -g '*.{ts,tsx}'`
- Modify: `apps/api/src/lib/context.ts`
- Modify: `apps/api/src/__tests__/context.test.ts`
- Modify: `apps/mcp/src/context.ts`
- Modify: `apps/mcp/src/context.test.ts`
- Rewrite: `apps/app/src/app/[orgSlug]/governance/_lib/invoke-org.ts`
- Create: `apps/app/src/app/[orgSlug]/governance/_lib/invoke-org.test.ts`
- Modify: `packages/iam/src/bootstrap.ts`
- Modify: `tools/scripts/gen-rls-migration.ts`
- Create: `packages/database/atlas/migrations/20260804120000_hierarchical_org_scope_rls.sql`
- Modify: `packages/database/atlas/migrations/atlas.sum`

**Interfaces:**
- `TenantScope` becomes the same discriminated org/workspace union as `AuthorizationScope`.
- `runInTenantScope(scope, fn)` and `withTenantDb(fn)` set org GUCs for both variants and a workspace GUC only for workspace scope.
- `CapabilityContext.authorizationScope` becomes required in this task and is the sole source used by IAM, audit, and kernel scope checks. `ctx.workspaceId` may remain for legacy workspace handlers but is never used to infer authorization scope.
- `CapabilityContext` continues to carry only surface-authenticated credential material (`userId` or `apiKeyId`) in Phase 1. It gains no caller-writable acting-principal or authority-chain field; Task 10 resolves one canonical actor server-side. Separately validated target-principal public IDs remain ordinary inputs for IAM management operations.

- [ ] **Step 1: Write failing scope regression tests**

Prove an org scope contains no workspace ID, workspace scope requires one, zero/empty sentinels are rejected, and a nested scope may only narrow from an org to a workspace in the same org. Under explicit org scope, hierarchical RLS may read same-org rows across workspaces but never another org; under workspace scope, `standard` rows are exact-workspace and `workspace_nullable` rows are exact-workspace plus org-wide. Add kernel tests proving a workspace-only capability is rejected before its handler when invoked with org scope, and that authentication through a workspace-bound credential does not silently change the requested authorization scope.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `pnpm --filter @oxagen/tenancy test:unit -- src/scope.test.ts`

Run: `pnpm --filter @oxagen/database test:unit -- src/tenant.test.ts`

Run: `pnpm --filter @oxagen/oxagen test:unit -- src/kernel.tenant-scope.test.ts`

Run: `pnpm --filter @oxagen/api test:unit -- src/__tests__/context.test.ts`

Expected: FAIL because the current context requires a workspace and the app helper uses the zero UUID.

- [ ] **Step 3: Implement discriminated tenant scope without a sentinel**

Use a nullable/cleared workspace GUC for org scope and explicit hierarchical RLS predicates generated consistently for every policy class. Org scope is an intentional same-org administrative elevation, so the capability registry must authorize that scope before the kernel opens the transaction. `standard` and `workspace_nullable` rows remain constrained by `org_id`; `workspace_only` tables have no org key and therefore return no rows under org scope rather than becoming cross-workspace visible. Preserve existing global/builtin read asymmetry. Permit only monotonic nested narrowing from org to one workspace in the same org; reject workspace-to-org, workspace-to-other-workspace, and cross-org nesting. Preserve workspace handler compatibility through a guarded `requireWorkspaceScope(ctx)` helper that throws `iam_scope_mismatch`; never substitute an empty string or zero UUID.

Update API/MCP context builders to accept an explicit validated authorization scope and reject ambiguous/multiple authentication subjects. An API key's credential-bound workspace may authenticate the caller but cannot silently change an org-scoped IAM target into a workspace decision. Do not deserialize an acting-principal or authority-chain field from request input or headers; target principal IDs are parsed only by the owning management contract.

- [ ] **Step 4: Replace the app org helper and correct stale comments**

Construct `{ kind: "org", orgId }` directly in `invoke-org.ts`. Keep the existing single app bootstrap in `apps/app/instrumentation.ts`; only remove comments that incorrectly claim IAM is not bootstrapped.

- [ ] **Step 5: Run focused tests and types**

Run: `pnpm --filter @oxagen/tenancy test:unit -- src/scope.test.ts && pnpm --filter @oxagen/database test:unit -- src/tenant.test.ts`

Run: `pnpm --filter @oxagen/oxagen test:unit -- src/kernel.tenant-scope.test.ts`

Run: `pnpm --filter @oxagen/api test:unit -- src/__tests__/context.test.ts && pnpm --filter @oxagen/mcp test:unit -- src/context.test.ts`

Run: `pnpm --filter @oxagen/app typecheck`

Run: `(cd packages/database && atlas migrate hash --dir "file://atlas/migrations") && pnpm db:lint-migrations && pnpm db:atlas-validate`

Run: `pnpm exec tsx tools/scripts/assert-local-db-target.ts --atlas-env local && pnpm --filter @oxagen/database exec atlas migrate apply --env local --to-version 20260804120000`

Run: `env -u DATABASE_URL DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen TENANT_RLS_ENFORCEMENT_ENABLED=true pnpm --filter @oxagen/database test:integration -- integration/iam-rls.test.ts integration/manifest-coverage.test.ts integration/rls.test.ts`

Run: `TURBO_CONCURRENCY=1 pnpm exec turbo run typecheck --filter=...@oxagen/oxagen`

Expected: PASS and `rg -n '00000000-0000-0000-0000-000000000000' apps/app/src/app/\[orgSlug\]/governance packages/iam/src apps/api/src/lib/context.ts` returns no scope sentinel.

- [ ] **Step 6: Commit**

```bash
git add packages/tenancy packages/database/src/tenant.ts packages/database/src/tenant.test.ts packages/database/atlas/migrations/20260804120000_hierarchical_org_scope_rls.sql packages/database/atlas/migrations/atlas.sum packages/oxagen/src/types.ts packages/oxagen/src/types.test.ts packages/oxagen/src/kernel.ts packages/oxagen/src/kernel.tenant-scope.test.ts packages/agent/src/types.ts apps/api/src/lib/context.ts apps/api/src/__tests__/context.test.ts apps/mcp/src/context.ts apps/mcp/src/context.test.ts 'apps/app/src/app/[orgSlug]/governance/_lib/invoke-org.ts' 'apps/app/src/app/[orgSlug]/governance/_lib/invoke-org.test.ts' packages/iam/src/bootstrap.ts tools/scripts/gen-rls-migration.ts
git commit -m "feat(tenancy): support explicit org authorization scope"
```

### Task 6: Add transaction-owned policy versioning and audit obligations

**Files:**
- Create: `packages/iam/src/policy-mutation.ts`
- Create: `packages/iam/src/policy-mutation.test.ts`
- Create: `packages/iam/src/policy-mutation.integration.test.ts`
- Create: `packages/iam/src/audit-events.ts`
- Create: `packages/iam/src/audit-events.test.ts`
- Create: `packages/iam/src/authorization-obligation.ts`
- Create: `packages/iam/src/authorization-obligation.test.ts`
- Modify: `packages/iam/src/index.ts`
- Create: `packages/iam/vitest.integration.config.ts`
- Modify: `packages/iam/package.json`

**Interfaces:**

```ts
mutateIamPolicy<T>(tx, {
  orgId, actorPrincipalId, idempotencyKey, event
}, mutation: (policyVersion: bigint) => Promise<T>): Promise<{
  result: T; policyVersion: string; eventId: string
}>;

recordAuthorizationDecision(tx, decisionEvent): Promise<{
  eventId: string; obligationId?: string
}>;

authorizeAndRecordTx(tx, request, {
  loadAuthority,
  resolveDecision
}): Promise<{
  decision: AuthorizationDecision;
  eventId: string;
  obligationId?: string;
  accessRequestId?: string;
}>;

completeAuthorizationObligation(tx, { decisionId, outcome, resultHash? }): Promise<void>;
```

- [ ] **Step 1: Write failing transaction tests**

Use a transaction-capable fake plus real-Postgres integration cases to prove: `SELECT ... FOR UPDATE` serializes the org counter; a duplicate idempotency key returns the original result without a second mutation/version/event; mutation failure rolls back state/version/event/outbox; event or outbox failure rolls back the mutation; event rows are append-only; the delivery row is mutable but uniquely tied to the event; runtime allow creates an admitted obligation before release; completion/failure is idempotent; and a missing completion remains queryable. Race a policy revoke against an authorization: authority loading and decision persistence share one transaction holding a compatible lock on the same policy-version row, so the outcome is either an allow admitted before the revoke or a deny on the new version—never a stale allow recorded after the revoke.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm --filter @oxagen/iam test:unit -- src/policy-mutation.test.ts src/audit-events.test.ts src/authorization-obligation.test.ts`

Expected: FAIL because no transaction-owned primitives exist.

- [ ] **Step 3: Implement canonical hashing and immutable event construction**

Use the one canonical JSON/hash implementation exported by `@oxagen/oxagen/iam` but keep security bindings distinct from display evidence. Compute `authorizationBindingHash` over the complete final normalized input/plan, including sensitive fields, and store only its digest. Separately redact the audit payload/diff, store only permitted metadata, and compute an `auditPayloadHash` over that redacted representation. Resource tuples, manifests, and effective scopes use domain-separated hash labels. Never authorize by comparing a redacted payload hash.

- [ ] **Step 4: Implement version bump, idempotency, event, and outbox in one transaction**

Policy mutations lock one `policy_versions` row `FOR UPDATE`, then resolve/insert a unique mutation receipt. Execute the mutation, increment exactly once, append the event and delivery, and complete the safe receipt in the same transaction. A concurrent identical retry reads the completed receipt; a different request hash using the same key fails with a typed conflict. Do not open a nested `withTenantDb` or call ClickHouse.

- [ ] **Step 5: Implement runtime obligation transitions**

`authorizeAndRecordTx` acquires a shared lock on that same org policy-version row, loads assignments/active versions/grants through the supplied transaction, resolves against the locked version, and writes the decision plus obligation/request before commit. Policy mutation and admission therefore serialize at the version boundary. Allow decisions create an `admitted` obligation and decision event before the handler runs. Deny writes only the decision event. Approval-required writes the decision event and durable request in Task 9. Completion/failure transitions append another event/outbox row. An admitted obligation is never treated as completed merely because the worker disappeared.

- [ ] **Step 6: Verify focused tests and types**

Run: `pnpm --filter @oxagen/iam test:unit -- src/policy-mutation.test.ts src/audit-events.test.ts src/authorization-obligation.test.ts`

Run: `env -u DATABASE_URL DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen pnpm --filter @oxagen/iam test:integration -- src/policy-mutation.integration.test.ts`

Run: `pnpm --filter @oxagen/iam typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/iam
git commit -m "feat(iam): add transactional policy audit primitives"
```

### Task 7: Provision and lifecycle-manage sibling principals

**Files:**
- Create: `packages/iam/src/principal-service.ts`
- Create: `packages/iam/src/principal-service.test.ts`
- Create: `packages/iam/src/service-account-service.ts`
- Create: `packages/iam/src/service-account-service.test.ts`
- Create: `packages/iam/src/assignment-service.ts`
- Create: `packages/iam/src/assignment-service.test.ts`
- Create: `packages/iam/src/system-policy-seed.ts`
- Create: `packages/iam/src/system-policy-seed.test.ts`
- Create: `packages/iam/src/principal-writer-coverage.test.ts`
- Modify: `packages/iam/src/index.ts`
- Modify: `packages/handlers/package.json`
- Modify: `packages/agent/package.json`
- Modify: `packages/auth/package.json`
- Modify: `pnpm-lock.yaml`
- Rewrite: `packages/handlers/src/iam-provision.ts`
- Rewrite: `packages/handlers/src/iam-provision.test.ts`
- Modify: `packages/handlers/src/org.create.ts`
- Modify: `packages/handlers/src/org.create.test.ts`
- Modify: `packages/handlers/src/org.member_invite.accept.ts`
- Modify: `packages/handlers/src/org.member_invite.accept.test.ts`
- Modify: `packages/handlers/src/org.member.remove.ts`
- Modify: `packages/handlers/src/org.member.remove.test.ts`
- Modify: `packages/handlers/src/org.member_role.change.ts`
- Modify: `packages/handlers/src/org.member_role.change.test.ts`
- Modify: `packages/agent/src/handlers/agent.definition.create.ts`
- Modify: `packages/agent/src/handlers/agent.definition.create.test.ts`
- Modify: `packages/agent/src/handlers/agent.definition.update.ts`
- Modify: `packages/agent/src/handlers/agent.definition.update.test.ts`
- Modify: `packages/agent/src/handlers/agent.definition.publish.ts`
- Modify: `packages/agent/src/handlers/agent.definition.publish.test.ts`
- Modify: `packages/agent/src/handlers/agent.deploy.ts`
- Modify: `packages/agent/src/handlers/agent.deploy.test.ts`
- Modify: `packages/handlers/src/workspace-agents.ts`
- Modify: `packages/handlers/src/workspace-agents.test.ts`
- Modify: `packages/handlers/src/workspace.create.ts`
- Modify: `packages/handlers/src/workspace.create.test.ts`
- Modify: `packages/handlers/src/api.key.create.ts`
- Modify: `packages/handlers/src/api.key.create.test.ts`
- Modify: `packages/handlers/src/api.key.rotate.ts`
- Modify: `packages/handlers/src/api.key.rotate.test.ts`
- Modify: `packages/handlers/src/api.key.revoke.ts`
- Modify: `packages/handlers/src/api.key.revoke.test.ts`
- Modify: `packages/oxagen/src/contracts/api.key.create.ts`
- Modify: `packages/oxagen/src/contracts/api.key.create.test.ts`
- Modify: `packages/auth/src/resolvers/api-key.ts`
- Modify: `packages/auth/src/resolvers/resolvers.test.ts`
- Modify: `packages/handlers/src/org.list.ts`
- Modify: `packages/handlers/src/org.list.test.ts`
- Modify: `packages/handlers/src/workspace.list.ts`
- Modify: `packages/handlers/src/workspace.list.test.ts`
- Modify: `apps/api/src/routes/v1/api.key.create.ts`
- Modify: `apps/api/src/__tests__/routes.billing.test.ts`
- Modify: `apps/api/src/routes/v1/auth.cli.token.ts`
- Modify: `apps/api/src/routes/v1/auth.cli.token.test.ts`
- Modify: `apps/mcp/src/tools/api.key.create.ts`
- Modify: `apps/mcp/src/tools/billing.handlers.test.ts`
- Modify: `apps/app/src/app/(onboarding)/new-organization/actions.ts`
- Modify: `apps/app/src/app/(onboarding)/new-organization/actions.test.ts`
- Modify: `apps/app/src/app/[orgSlug]/new-workspace/actions.ts`
- Modify: `apps/app/src/app/[orgSlug]/new-workspace/actions.test.ts`
- Modify: `apps/app/src/app/[orgSlug]/developer/tokens/api-key.ts`
- Modify: `apps/app/src/app/[orgSlug]/developer/tokens/api-key.test.ts`
- Modify: `apps/app/src/app/[orgSlug]/developer/tokens/tokens-panel.tsx`
- Modify: `apps/app/e2e/developer-tokens.spec.ts`
- Modify: `packages/inngest-functions/src/functions/privacy.export.process.ts`
- Modify: `packages/inngest-functions/src/functions/privacy.export.process.test.ts`
- Modify: `packages/ai/src/prompts/registry.ts`
- Modify: `packages/ai/src/prompts/registry.test.ts`
- Modify: `docs/capabilities/api.key.create.md`
- Regenerate: `docs/capabilities/schemas/api.key.create.json`
- Regenerate: `docs/capabilities/schemas/_index.json`
- Regenerate: `docs/capabilities/schemas/README.md`
- Regenerate: `packages/oxagen/capabilities.manifest.json`

**Interfaces:**
- `provisionPrincipalTx(tx, { kind, subjectId, scope, display, actorPrincipalId })` validates the source record and returns the one canonical principal.
- `ensureSystemPolicyTx` deterministically creates/restores the frozen org/workspace system-role identities, immutable active versions, explicit grants, and policy-version row from the Task 3 capability metadata and the approved role migration table. It is idempotent and is the only system-role seed implementation used by both new-organization bootstrap and Task 15 reset/reseed.
- `bootstrapOrganizationIamTx` is the sole pre-tenant system transaction: after authenticating the creating human, it atomically creates the organization/membership, calls `ensureSystemPolicyTx`, creates the human principal and protected Owner assignment against the seeded active Owner version, and commits the immutable event/outbox obligation.
- `createServiceAccountTx` accepts an org or workspace scope, requires at least one eligible initial role in that exact scope before activation, and atomically creates service account, principal, assignments, policy event, and version.
- `setPrincipalStatusTx` suspends/restores the bound subject, revokes invalid assignments, and records the policy mutation.
- `assignPrincipalRolesTx` provides the canonical exact-scope/eligible-kind/active-role assignment primitive needed by service creation and agent deployment; Task 8 completes its bulk, last-Owner, JIT, and archive semantics.
- `create_api_key` requires an explicit human/service `principalId`; agent principals are invalid. Rotation copies the binding; revocation invalidates only that credential and increments policy version.

- [ ] **Step 1: Write failing principal binding and lifecycle tests**

Cover: one human owning multiple agents yields one human principal plus one principal per stable agent; agent `subjectId` equals the agent row ID; agent creation and principal creation roll back together; ownership grants nothing; duplicate provisioning restores/returns the unconditional unique principal rather than inserting a new row; cross-org/workspace or wrong-kind bindings fail; draft agent may lack a role but deployment fails; publish/deploy succeeds only with an active workspace assignment; agent display-name changes update principal search metadata transactionally; and status transitions increment policy version plus audit. Exercise both ordinary agent definition creation and the built-in `qa-chat` workspace bootstrap writer.

System-policy/bootstrap tests prove a brand-new post-cutover organization receives the complete deterministic role matrix, one immutable active version per role, explicit grants only, a policy-version row, a human principal, and a valid protected Owner assignment in the same transaction. Failure at any seed/grant/assignment/event step rolls the organization back. Re-running the system seeder returns the same role/version/grant manifest without duplicates; missing or unmapped `defaultRoles` metadata fails closed.

For service/API-key cases cover: account plus service principal plus exact-scope initial assignment is atomic for org and workspace services; no active service account can be created without a role; key creation requires explicit human/service principal; an Owner creating a key for an unprivileged service does not transfer Owner; rotation retains `principal_id`; revoking one key leaves sibling keys and principal active; expired/revoked credentials fail before role resolution; the CLI PKCE exchange binds the approved human principal; and privacy export exposes only safe subject-principal metadata, never credential material or creator-derived authority.

Add a repository-source coverage test that enumerates every production insert/update of `schema.agents` and `schema.apiKeys` plus every read of `apiKeys.createdByUserId`. The allowlist names the lifecycle service, ordinary agent handler, built-in workspace bootstrap, CLI token exchange, auth resolver, org/workspace readers, and privacy projector explicitly; an unreviewed writer or creator-based authorization read fails the test.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pnpm --filter @oxagen/iam test:unit -- src/principal-service.test.ts src/service-account-service.test.ts src/assignment-service.test.ts src/system-policy-seed.test.ts src/principal-writer-coverage.test.ts`

Run: `pnpm --filter @oxagen/handlers test:unit -- src/iam-provision.test.ts src/org.create.test.ts src/org.member_invite.accept.test.ts src/org.member.remove.test.ts src/org.member_role.change.test.ts src/api.key.create.test.ts src/api.key.rotate.test.ts src/api.key.revoke.test.ts`

Run: `pnpm --filter @oxagen/agent test:unit -- src/handlers/agent.definition.create.test.ts src/handlers/agent.definition.update.test.ts src/handlers/agent.definition.publish.test.ts src/handlers/agent.deploy.test.ts`

Run: `pnpm --filter @oxagen/auth test:unit -- src/resolvers/resolvers.test.ts && pnpm --filter @oxagen/api test:unit -- src/routes/v1/auth.cli.token.test.ts src/__tests__/routes.billing.test.ts`

Run: `pnpm --filter @oxagen/app test:unit -- 'src/app/(onboarding)/new-organization/actions.test.ts' 'src/app/[orgSlug]/new-workspace/actions.test.ts' 'src/app/[orgSlug]/developer/tokens/api-key.test.ts' && pnpm --filter @oxagen/inngest-functions test:unit -- src/functions/privacy.export.process.test.ts`

Expected: FAIL on `subject_id`, explicit key binding, and deployment posture.

- [ ] **Step 3: Implement transaction-aware principal services**

Accept an existing transaction everywhere. Validate source rows before insert/update. Human membership removal/suspension, agent archive/suspension, service suspension, and credential revocation are source-of-truth hooks, not best-effort listeners. `assignedBy` and all mutation attribution use IAM principal IDs, never auth-user IDs or API-key IDs.

- [ ] **Step 4: Cut human and agent handlers over**

Move reusable IAM provisioning out of `@oxagen/handlers` into `@oxagen/iam`. Replace both the capability handler and duplicated onboarding server-action organization creation logic with `bootstrapOrganizationIamTx`; its system access is callable only after server-side authentication and never accepts an authority-bearing principal from form/API input. Keep `iam-provision.ts` as a thin compatibility entry only for org bootstrap until Task 15 rewrites seeding. Add `@oxagen/iam` dependencies without creating a package cycle. Keep the agent table free of a principal FK; linkage remains `principals.subject_id = agents.id`. Cut the built-in workspace-agent bootstrap through the same principal/assignment services so its active `qa-chat` row cannot exist without an agent principal and eligible workspace role.

- [ ] **Step 5: Cut API-key handlers over**

Change `create_api_key` input to require a public `principalId` and remove its agent surface/prompt instruction: an agent cannot mint credentials. Resolve the caller separately from the credential subject. Return only the existing one-time raw key material plus the subject principal public ID; never return an internal UUID. Rotate and revoke inside the policy mutation transaction. The existing developer-token server action resolves and supplies the authenticated human principal explicitly; it does not infer authority inside the credential service. Phase 4 adds the service-principal picker. API/MCP callers must provide an eligible principal. The public CLI PKCE exchange calls the same credential service with the human principal bound to its consumed code—no direct `api_keys` insert and no fire-and-forget audit.

Update `@oxagen/auth` to authenticate from `api_keys.principal_id` and return the subject principal, never the creator. Update org/workspace visibility readers and privacy projection to use explicit subject semantics. Regenerate capability schema docs with `pnpm docs:schemas`; update the MCP adapter, API tests, existing app action/unit/e2e coverage, and prompt registry so every consumer matches the required input and removed agent surface.

- [ ] **Step 6: Verify narrow tests and types**

Run all five commands from Step 2.

Run: `pnpm --filter @oxagen/iam typecheck && pnpm --filter @oxagen/handlers typecheck && pnpm --filter @oxagen/agent typecheck && pnpm --filter @oxagen/auth typecheck && pnpm --filter @oxagen/api typecheck && pnpm --filter @oxagen/mcp typecheck && pnpm --filter @oxagen/app typecheck`

Run: `pnpm docs:schemas && pnpm check:contracts && pnpm check:manifest --json && pnpm check:ui-parity`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/iam packages/handlers packages/agent packages/auth packages/oxagen/src/contracts/api.key.create.ts packages/oxagen/src/contracts/api.key.create.test.ts packages/oxagen/capabilities.manifest.json packages/inngest-functions/src/functions/privacy.export.process.ts packages/inngest-functions/src/functions/privacy.export.process.test.ts packages/ai/src/prompts/registry.ts packages/ai/src/prompts/registry.test.ts apps/api/src/routes/v1/api.key.create.ts apps/api/src/routes/v1/auth.cli.token.ts apps/api/src/routes/v1/auth.cli.token.test.ts apps/api/src/__tests__/routes.billing.test.ts apps/mcp/src/tools/api.key.create.ts apps/mcp/src/tools/billing.handlers.test.ts 'apps/app/src/app/(onboarding)/new-organization/actions.ts' 'apps/app/src/app/(onboarding)/new-organization/actions.test.ts' 'apps/app/src/app/[orgSlug]/new-workspace/actions.ts' 'apps/app/src/app/[orgSlug]/new-workspace/actions.test.ts' 'apps/app/src/app/[orgSlug]/developer/tokens/api-key.ts' 'apps/app/src/app/[orgSlug]/developer/tokens/api-key.test.ts' 'apps/app/src/app/[orgSlug]/developer/tokens/tokens-panel.tsx' apps/app/e2e/developer-tokens.spec.ts docs/capabilities/api.key.create.md docs/capabilities/schemas/api.key.create.json docs/capabilities/schemas/_index.json docs/capabilities/schemas/README.md pnpm-lock.yaml
git commit -m "feat(iam): provision human agent and service principals"
```

### Task 8: Implement versioned role, grant, and assignment services

**Files:**
- Create: `packages/iam/src/role-service.ts`
- Create: `packages/iam/src/role-service.test.ts`
- Create: `packages/iam/src/role-validation.ts`
- Create: `packages/iam/src/role-validation.test.ts`
- Modify: `packages/iam/src/assignment-service.ts`
- Modify: `packages/iam/src/assignment-service.test.ts`
- Modify: `packages/iam/src/index.ts`
- Modify: `packages/handlers/src/org.member_role.change.ts`
- Modify: `packages/handlers/src/org.member_role.change.test.ts`

**Interfaces:**
- `createRoleDraft`, `patchRoleDraft`, `publishRole`, `archiveRole`, `restoreRole`, and `restoreRoleVersion` all accept acting principal, explicit scope, expected revisions, reason, idempotency key, and an injected `IamResourceCatalogValidator` port. Task 12 binds the production read-only catalog adapter; unit tests use a complete deterministic fake.
- `assignPrincipalRoles` and `revokePrincipalRoles` accept arrays and perform one all-or-nothing transaction.
- The active role resolver loads only a stable role's `active_version_id`; it never selects `MAX(version)` or a draft.

- [ ] **Step 1: Write failing role lifecycle tests**

Cover immutable scope; exact-scope name uniqueness; one resumable draft; section patch CAS; base-active-version publish conflict; catalog-incomplete publish rejection; invalid resource/scope/action rejection; explicit rows for “all current” resources with future resources denied; published-version/grant immutability; restore creates a new version; system-role mutation rejection; archive revokes active assignments without deleting evidence; restore does not reactivate assignments; incompatible eligible-kind publication reports affected principals; and manifest hashes are deterministic.

- [ ] **Step 2: Write failing assignment tests**

Cover role/principal kind eligibility, exact scope, active role/version requirement, expiry, active-only uniqueness and reassignment after revoke, bulk idempotency/atomicity, acting-principal attribution, time-bounded JIT assignments, non-delegable break-glass metadata, last active human Owner protection on revoke/expiry, and runtime denial of drifted rows.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `pnpm --filter @oxagen/iam test:unit -- src/role-validation.test.ts src/role-service.test.ts src/assignment-service.test.ts`

Expected: FAIL because roles are mutable and grants are capability-only.

- [ ] **Step 4: Implement draft/publish/archive/restore transactions**

Patch only the named section and preserve opaque grants from catalog sections that were not loaded. Publish performs complete server-side catalog validation, inserts/finalizes an immutable published version, switches `active_version_id`, increments policy version, and records event/outbox atomically. A version conflict returns current active/draft revisions without mutating the caller's draft.

- [ ] **Step 5: Implement assignment invariants and route legacy membership writes through them**

Remove direct IAM assignment SQL from `org.member_role.change.ts`. Legacy membership labels may remain a display projection during the cutover, but they cannot grant access or bypass the shared assignment service. Lock the affected role/principal/Owner rows when enforcing the last-Owner invariant.

- [ ] **Step 6: Verify focused tests and types**

Run: `pnpm --filter @oxagen/iam test:unit -- src/role-validation.test.ts src/role-service.test.ts src/assignment-service.test.ts`

Run: `pnpm --filter @oxagen/handlers test:unit -- src/org.member_role.change.test.ts`

Run: `pnpm --filter @oxagen/iam typecheck && pnpm --filter @oxagen/handlers typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/iam packages/handlers/src/org.member_role.change.ts packages/handlers/src/org.member_role.change.test.ts
git commit -m "feat(iam): add immutable role policy lifecycle"
```

### Task 9: Generalize access requests and enforce single-use approvals

**Files:**
- Rewrite: `packages/iam/src/access-request.ts`
- Rewrite: `packages/iam/src/access-request.test.ts`
- Create: `packages/iam/src/approval-service.ts`
- Create: `packages/iam/src/approval-service.test.ts`
- Create: `packages/iam/src/approval-claim.integration.test.ts`
- Modify: `packages/iam/src/index.ts`

**Interfaces:**
- `createAccessRequestTx` accepts the server-resolved authenticated principal, scope, resource tuple, complete canonical final input/plan authorization-binding hash, request/run/step/decision IDs, policy version, kind, reason, requested role/TTL, and expiry. It computes the ordered singleton-chain hash internally. The schema remains forward-compatible with ordered chains, but capability input cannot provide chain IDs in Phase 1. It returns a durable request or throws; `null` is not a valid outcome.
- `decideAccessRequestTx` performs approve/deny with acting-principal attribution and segregation-of-duties enforcement.
- `claimExactApprovalTx` atomically matches every binding, checks current policy/authority, sets `consumed_at`, and creates the final authorization obligation in the same transaction.

- [ ] **Step 1: Write failing request state-machine tests**

Cover exact and temporary kinds; one pending duplicate per canonical request; required reason/expiry; requester/approver principal kinds; self-approval denial; approve/deny terminal transitions; stale policy; newer deny; changed input/graph-plan hash; changed singleton actor/scope/resource/run/step; rejection of caller-supplied acting-principal/authority-chain fields while preserving validated target-principal inputs; expired/revoked request; and database failure propagating `iam_policy_unavailable` instead of returning `null`.

- [ ] **Step 2: Write failing concurrency/replay tests**

Against real Postgres, race two approvals and two exact claims. Exactly one approval transition and one consumption may succeed. A retry with the same decision/obligation id is idempotent; a second execution or different input returns `iam_approval_replayed` or `iam_execution_input_changed`. Approval never overrides current deny, inactive principal, expired assignment, or credential revocation.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `pnpm --filter @oxagen/iam test:unit -- src/access-request.test.ts src/approval-service.test.ts`

Run: `env -u DATABASE_URL DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen pnpm --filter @oxagen/iam test:integration -- src/approval-claim.integration.test.ts`

Expected: FAIL because the current request is capability-only, nullable on failure, and has no consumption path.

- [ ] **Step 4: Implement exact-execution approval**

Canonicalize after all mutating hooks and before request creation. Compute the authorization-binding hash over the complete normalized input/plan and persist only that digest; redact a separate audit-display payload. Add a regression where two inputs differ only in a redacted secret/argument/target and must produce different approval hashes. Bind the opaque authorization to the final hash and exact execution identifiers. Claim with one conditional `UPDATE ... WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now` plus current resolver recheck and obligation insert in the same `authorizeAndRecordTx` policy-version transaction. Do not place an approval reference in a reusable decision cache.

- [ ] **Step 5: Implement temporary-access approval**

Approval delegates to `assignPrincipalRoles` with a required expiry and reason. It creates an ordinary time-bounded assignment, increments policy version, and emits the normal assignment event. It does not mint a bearer token or reusable exact authorization.

- [ ] **Step 6: Verify focused tests and types**

Run the commands from Step 3.

Run: `pnpm --filter @oxagen/iam typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/iam/src/access-request.ts packages/iam/src/access-request.test.ts packages/iam/src/approval-service.ts packages/iam/src/approval-service.test.ts packages/iam/src/approval-claim.integration.test.ts packages/iam/src/index.ts
git commit -m "feat(iam): add durable single-use approvals"
```

### Task 10: Cut runtime authorization and the kernel over fail-closed

**Files:**
- Rewrite: `packages/iam/src/fetch-authz.ts`
- Rewrite: `packages/iam/src/fetch-authz.test.ts`
- Rewrite: `packages/iam/src/check-iam.ts`
- Rewrite: `packages/iam/src/check-iam.test.ts`
- Create: `packages/iam/src/decision-cache.ts`
- Create: `packages/iam/src/decision-cache.test.ts`
- Rewrite: `packages/iam/src/bootstrap.ts`
- Rewrite: `packages/iam/src/bootstrap.test.ts`
- Remove: `packages/iam/src/denial.ts`
- Remove: `packages/iam/src/denial.test.ts`
- Remove: `packages/iam/src/emit-audit.ts`
- Remove: `packages/iam/src/emit-audit.test.ts`
- Modify: `packages/iam/src/index.ts`
- Modify: `packages/oxagen/src/kernel.ts`
- Modify: `packages/oxagen/src/kernel.test.ts`
- Modify: `packages/oxagen/src/kernel.trace.test.ts`
- Modify: `packages/oxagen/src/kernel.entitlement.test.ts`
- Modify: `packages/oxagen/src/types.ts`
- Modify: `apps/api/src/bootstrap.ts`
- Modify: `apps/api/src/__tests__/bootstrap.test.ts`
- Modify: `apps/api/src/__tests__/health.test.ts`
- Modify: `apps/mcp/src/middleware.ts`
- Create: `apps/mcp/src/middleware.test.ts`
- Modify: `apps/app/instrumentation.ts`
- Create: `apps/app/src/instrumentation.test.ts`
- Modify: every stale app source comment returned by `rg -l 'apps/app does (not|NOT) bootstrap|app does (not|NOT) bootstrap IAM|does not bootstrap kernel IAM|does NOT bootstrap IAM' apps/app/src -g '*.{ts,tsx}'`

**Runtime flow:**

```text
authenticate credential -> resolve exactly one explicit principal server-side
-> open authorizeAndRecordTx and lock current org policy-version row
-> load active assignments/active role versions/resource grants including expiries in that transaction
-> pure resolve at the locked version -> durably append decision (+ obligation or access request)
-> commit admission transaction
-> kernel allows, denies, or returns approval-required
-> handler -> append completion/failure against decision obligation
```

- [ ] **Step 1: Write failing loader/cache tests**

Prove human/service runtime lookup uses server-authenticated session identity or explicit API-key `principal_id`; capability input cannot name the acting principal or authority chain, while management contracts may carry a separately validated target principal; missing/inactive/expired/cross-scope state denies; expired rows reach the resolver so `validUntil` is correct; only active role versions load; grant/resource scope drift denies; and a policy-version lookup error is `iam_policy_unavailable`. Agent principals are assignable and simulatable in Phase 1, while production agent-chain admission waits for Phase 2's persisted delegation/`RunSpecV2` boundary.

Cache tests must prove the key contains principal chain, exact scope/resource/action, policy version, requested-scope hash, and relevant catalog hash; every hit compares current policy version and wall-clock expiry; cache values are pure predecisions only; exact approvals/final obligations never enter it; and a version change misses without a cross-process invalidation race.

- [ ] **Step 2: Write failing kernel security regressions**

Assert every subscription tier runs IAM; missing production bootstrap refuses startup/invocation; there is no enforcement-off flag; no principal is synthesized; no caller-supplied principal array reaches the resolver; contract `defaultEffect` does not authorize; Owner has only explicit grants; denied handlers never run; approval persistence failure returns policy unavailable, not pending; decision-event/obligation failure prevents a result/side effect; completion/failure uses the same decision ID; and the kernel independently rechecks every invocation even if discovery previously exposed the capability. Add a real-transaction race: a revoke and an invocation contend on the same policy row, and the recorded allow can never carry a version older than a revoke that committed first.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `pnpm --filter @oxagen/iam test:unit -- src/fetch-authz.test.ts src/check-iam.test.ts src/decision-cache.test.ts src/bootstrap.test.ts`

Run: `pnpm --filter @oxagen/oxagen test:unit -- src/kernel.test.ts src/kernel.trace.test.ts src/kernel.entitlement.test.ts`

Expected: FAIL on tier bypass, synthetic/fallback behavior, asynchronous audit, and missing policy metadata.

- [ ] **Step 4: Implement one runtime authorizer**

Replace `fetchAuthz`'s legacy DTO with one server-resolved `PrincipalAuthority`, then wrap it as the singleton array consumed by the pure resolver. Resolver/simulator chain support is groundwork only; do not accept an array from API/MCP/app/runner capability input. Run the policy-version read, authority load, cache check/miss resolution, and decision/obligation/request write inside `authorizeAndRecordTx`. The transaction acquires a shared lock on the org version row before reading authority; policy mutations acquire `FOR UPDATE` on the same row. Read current policy version on every invocation before consulting the bounded in-process predecision cache. Keep entitlement as a separate intersection/gate; installation or paid tier never grants IAM authority.

- [ ] **Step 5: Make the kernel enforcement path non-optional**

Change bootstrap injection so a grantable scoped capability cannot run until the runtime is installed. Preserve a narrow explicit path for `authorization.grantable:false` pre-tenant/bootstrap capabilities. Remove `enforced` boolean semantics and all graceful-degradation comments/types. The kernel passes the exact `{ kind: "capability", resourceId: contract.name, action: "invoke" }` tuple and explicit authorization scope.

For `require_approval`, create the request in the same locked durable decision transaction and return only after it commits. For allow, create the obligation before invoking the handler. A mutation that commits after this admission invalidates future decisions but does not retroactively rewrite the already committed attempt; Phase 2 owns durable run snapshots and claim/resume rechecks. After success/failure, transition the obligation; if that transition fails, surface/alert the still-admitted obligation rather than pretending audit completed.

- [ ] **Step 6: Bootstrap every production runtime and fail readiness closed**

API, MCP, and app startup must import handler registration, bootstrap entitlement, and bootstrap IAM exactly once. Rewrite the stale graceful-degradation comments and imports in `apps/app/instrumentation.ts`; its focused test proves missing policy tables/runtime fail closed and that handler, entitlement, billing, and IAM bootstraps execute exactly once in the Node runtime. Production readiness fails if any gate is absent. Tests may install an explicit deterministic fake; there is no production environment variable that turns IAM into allow.

- [ ] **Step 7: Verify focused tests and types**

Run the two commands from Step 3.

Run: `pnpm --filter @oxagen/iam typecheck && pnpm --filter @oxagen/oxagen typecheck && pnpm --filter @oxagen/api typecheck && pnpm --filter @oxagen/mcp typecheck && pnpm --filter @oxagen/app typecheck`

Run: `pnpm --filter @oxagen/app test:unit -- src/instrumentation.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/iam packages/oxagen/src apps/api/src apps/mcp/src apps/app/instrumentation.ts apps/app/src
git commit -m "feat(kernel): enforce durable IAM decisions on every tier"
```

### Task 11: Project durable IAM evidence and observe expiry

**Files:**
- Create: `packages/telemetry/src/migrations/0026_iam_authorization_evidence.sql`
- Modify: `packages/telemetry/src/schema.sql`
- Modify: `packages/telemetry/src/clickhouse.ts`
- Modify: `packages/telemetry/src/clickhouse.test.ts`
- Modify: `packages/telemetry/src/migrate-runner.test.ts`
- Create: `packages/inngest-functions/src/functions/iam.audit-outbox.project.ts`
- Create: `packages/inngest-functions/src/functions/iam.audit-outbox.project.test.ts`
- Create: `packages/inngest-functions/src/functions/iam.expiry-sweep.ts`
- Create: `packages/inngest-functions/src/functions/iam.expiry-sweep.test.ts`
- Modify: `packages/inngest-functions/src/functions.ts`
- Modify: `packages/inngest-functions/src/lease.ts` to expose a generic `FOR UPDATE SKIP LOCKED` lease helper
- Modify: `packages/inngest-functions/src/lease.test.ts`

**Interfaces:**
- The projector claims outbox rows with `FOR UPDATE SKIP LOCKED`, writes ClickHouse idempotently by `event_id`, and marks delivery published only after the insert succeeds.
- The expiry sweeper scans cross-tenant state only through `withSystemDb`, then performs each tenant mutation in explicit tenant scope with an idempotency key `expiry:<kind>:<id>:<expiresAt>`.

- [ ] **Step 1: Write failing ClickHouse schema/writer tests**

Extend the existing `audit_events` projection rather than creating mutable policy state in ClickHouse. Require event kind, actor/target principal kinds and IDs, exact scope/resource/action, policy version, decision/obligation IDs, principal-chain/effective/request hashes, outcome/reason, request/run/parent-run/trace IDs, occurrence time, and idempotent event ID. Preserve seven-year retention. Do not store raw input, prompt, context, property, credential, or forbidden inferred name values.

- [ ] **Step 2: Write failing projector lease/retry tests**

Cover concurrent workers, lease expiry/recovery, exponential retry, idempotent duplicate ClickHouse insert, publish-after-success only, dead-letter after bounded attempts, structured alerting, and tenant attribution. A ClickHouse outage leaves PostgreSQL policy and pending delivery intact.

- [ ] **Step 3: Write failing expiry tests**

Cover expired assignments, approvals, access requests, and credentials. Resolver denial is immediate at the supplied clock even before sweep. Sweep writes one explicit expired transition/event, increments policy version where persistent status changes, and never duplicates evidence across retries or a resolver-observed expiry race.

- [ ] **Step 4: Run focused tests and confirm failure**

Run: `pnpm --filter @oxagen/telemetry test:unit -- src/clickhouse.test.ts src/migrate-runner.test.ts`

Run: `pnpm --filter @oxagen/inngest-functions test:unit -- src/functions/iam.audit-outbox.project.test.ts src/functions/iam.expiry-sweep.test.ts src/lease.test.ts`

Expected: FAIL because the current emitter writes ClickHouse directly and there is no IAM outbox worker.

- [ ] **Step 5: Implement migration, projector, and sweeper**

Map the immutable PostgreSQL event payload to ClickHouse without recomputing authorization. Do not retain the current racy “read previous chain hash then append” writer as the durability mechanism. The Phase 5 signed manifest/export will provide evidence integrity; Phase 1 guarantees atomic commitment, idempotent projection, and visible delivery state.

- [ ] **Step 6: Verify focused tests and types**

Run the two commands from Step 4.

Run: `pnpm --filter @oxagen/telemetry typecheck && pnpm --filter @oxagen/inngest-functions typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/telemetry packages/inngest-functions
git commit -m "feat(iam): project durable authorization evidence"
```

### Task 12: Build tenant-safe IAM read models, resource catalog, simulator, and export

**Files:**
- Create: `packages/iam/src/resource-catalog.ts`
- Create: `packages/iam/src/resource-catalog.test.ts`
- Create: `packages/iam/src/role-query.ts`
- Create: `packages/iam/src/role-query.test.ts`
- Create: `packages/iam/src/principal-query.ts`
- Create: `packages/iam/src/principal-query.test.ts`
- Create: `packages/iam/src/posture-query.ts`
- Create: `packages/iam/src/posture-query.test.ts`
- Create: `packages/iam/src/access-preview.ts`
- Create: `packages/iam/src/access-preview.test.ts`
- Create: `packages/iam/src/permissions-export.ts`
- Create: `packages/iam/src/permissions-export.test.ts`
- Modify: `packages/iam/src/index.ts`
- Use read-only data from: `packages/database/src/schema/schema-registry.ts`
- Use read-only data from: `packages/database/src/schema/mcp.ts`
- Use read-only data from: `packages/database/src/schema/agent.ts`

**Read-model rules:**
- All queries are cursor-paginated, tenant-scoped, stable-sort by public ID after relevance/name, and return public IDs only.
- Resource catalog IDs are: canonical graph label/type names; capability registered names; canonical `mcp_server_public_id/tool_name`; skill public IDs; and agent public IDs.
- Catalog reads never call `getOrCreateRegistry` or mutate state. They use only the current pinned/enabled schema version, current installed/enabled MCP servers and latest descriptor per tool, current live skills, and current live agents.
- Simulator calls the production loader and pure resolver. Singleton previews must match Phase 1 runtime exactly. It may include one selected acting agent for an administrator's explicitly hypothetical future-chain impact preview, but labels that result non-executable and creates no delegation, assignment, snapshot, approval, or runtime authorization reference.

- [ ] **Step 1: Write failing resource-catalog tests**

Cover every resource kind, valid actions/scopes, canonical IDs, pinned graph version/hash, MCP server rename stability, deleted/disabled resources, skill/agent public IDs, capability metadata, newly appearing resources default denied, cursor/search behavior, partial source failure, and no write queries. A catalog reports `complete`, per-kind `unavailable`, and a deterministic hash; role publication rejects an incomplete catalog but unaffected draft sections remain readable.

- [ ] **Step 2: Write failing principal/role/posture query tests**

Principal search returns humans, agents, and services as sibling results with kind text, display/secondary identity, status, workspace, owner-for-display-only, existing assignments, and disabled reason. Search covers display name, email/IdP subject, agent name/slug, service identifier, and principal public ID without leaking deleted records by default. Role queries expose stable identity, active/draft revisions, exact grants, assignment counts, and no mutable historical version.

Posture computes deployable agents without active roles, agents without graph grants, high-risk capability/MCP grants, expiring/break-glass assignments, pending privileged approvals, and recent role changes using PostgreSQL policy state plus projected evidence availability.

- [ ] **Step 3: Write failing simulator and export tests**

For the same persisted singleton authority input, `previewIamAccess` and runtime resolution must return the same outcome, reason, policy version, scope hash, and trace IDs. A hypothetical human/service-plus-agent preview must be administrator-authored, tenant-validated, visibly `executable:false`, and use the same intersection code without being accepted by the kernel. Reject arbitrary cross-tenant chains, invalid target scope, non-owned draft overlays, and non-empty persisted delegation IDs until Phase 2 provides those records. Draft overlay is caller-owned, preview-only, and cannot create authority.

Permission exports are deterministic across query order and include principal kinds/status, role and active version IDs/hashes, exact grants, assignments/expiry, scope, policy version, timestamps, and manifest hash in JSON, NDJSON, and flat CSV. Phase 1 returns explicit `{ signed: false, signature: null, keyId: null }`; it never labels the artifact signed evidence.

- [ ] **Step 4: Run focused tests and confirm failure**

Run: `pnpm --filter @oxagen/iam test:unit -- src/resource-catalog.test.ts src/role-query.test.ts src/principal-query.test.ts src/posture-query.test.ts src/access-preview.test.ts src/permissions-export.test.ts`

Expected: FAIL because current IAM has only a role list and no unified catalog/query layer.

- [ ] **Step 5: Implement read-only adapters and reuse canonical resolver/hash code**

Query database tables directly from `@oxagen/iam`; do not import handlers or create a dependency cycle. Parse MCP tool IDs through one canonical builder/parser. Preserve unknown persisted grants in administrator output as opaque entries, mark catalog validation incomplete, and never silently delete them from a draft.

- [ ] **Step 6: Verify focused tests and types**

Run the command from Step 4.

Run: `pnpm --filter @oxagen/iam typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/iam
git commit -m "feat(iam): add resource catalog and access read models"
```

### Task 13: Add the Phase 1 IAM management capability contracts and handlers

**Files:**
- Create: `packages/oxagen/src/iam/schemas.ts`
- Create: `packages/oxagen/src/iam/schemas.test.ts`
- Regenerate: `packages/oxagen/src/contracts.generated.ts`
- Regenerate: `packages/oxagen/capabilities.manifest.json`
- Evolve: `packages/oxagen/src/contracts/iam.role.list.ts`
- Evolve: `packages/oxagen/src/contracts/iam.role.list.test.ts`
- Create contract + co-located test for each stem:
  - `packages/oxagen/src/contracts/iam.role.get.ts`
  - `packages/oxagen/src/contracts/iam.role.create.ts`
  - `packages/oxagen/src/contracts/iam.role_draft.update.ts`
  - `packages/oxagen/src/contracts/iam.role.publish.ts`
  - `packages/oxagen/src/contracts/iam.role.archive.ts`
  - `packages/oxagen/src/contracts/iam.role.restore.ts`
  - `packages/oxagen/src/contracts/iam.role_version.list.ts`
  - `packages/oxagen/src/contracts/iam.role_version.restore.ts`
  - `packages/oxagen/src/contracts/iam.principal.search.ts`
  - `packages/oxagen/src/contracts/iam.principal.get.ts`
  - `packages/oxagen/src/contracts/iam.service_account.create.ts`
  - `packages/oxagen/src/contracts/iam.service_account.suspend.ts`
  - `packages/oxagen/src/contracts/iam.service_account.restore.ts`
  - `packages/oxagen/src/contracts/iam.role_assignment.list.ts`
  - `packages/oxagen/src/contracts/iam.principal_role.assign.ts`
  - `packages/oxagen/src/contracts/iam.principal_role.revoke.ts`
  - `packages/oxagen/src/contracts/iam.resource.list.ts`
  - `packages/oxagen/src/contracts/iam.access.preview.ts`
  - `packages/oxagen/src/contracts/iam.permissions.export.ts`
  - `packages/oxagen/src/contracts/iam.posture.get.ts`
  - `packages/oxagen/src/contracts/iam.access_request.list.ts`
  - `packages/oxagen/src/contracts/iam.access_request.get.ts`
  - `packages/oxagen/src/contracts/iam.access_request.approve.ts`
  - `packages/oxagen/src/contracts/iam.access_request.deny.ts`
- Modify: `packages/oxagen/src/contracts/index.ts`
- Evolve: `packages/handlers/src/iam.role.list.ts`
- Evolve: `packages/handlers/src/iam.role.list.test.ts`
- Create: corresponding `packages/handlers/src/<stem>.ts` handlers for every new contract stem above
- Create: `packages/handlers/src/iam-management.test.ts`
- Modify: `packages/handlers/src/register.ts`

**Registered names:**

```text
list_iam_roles, get_iam_role, create_iam_role, update_iam_role_draft,
publish_iam_role, archive_iam_role, restore_iam_role,
list_iam_role_versions, restore_iam_role_version,
search_iam_principals, get_iam_principal,
create_iam_service_account, suspend_iam_service_account,
restore_iam_service_account, list_iam_role_assignments,
assign_principal_role, revoke_principal_role, list_iam_resources,
preview_iam_access, export_iam_permissions, get_iam_posture,
list_iam_access_requests, get_iam_access_request,
approve_iam_access_request, deny_iam_access_request
```

- [ ] **Step 1: Write failing shared wire-schema tests**

Test public IDs, exact authorization scope/resource unions, grant effects, graph budgets, role identity/version/draft DTOs, ISO times, opaque cursor pages, administrator-safe decision trace, deterministic export integrity metadata, and strict rejection of unknown input fields.

- [ ] **Step 2: Write failing contract metadata and concurrency tests**

Every management contract is sync, API/MCP only, org-authorized, high sensitivity, no billing, default deny, and has no agent metadata. Read/posture/preview/export default grants include Owner/Admin/Compliance; mutation defaults include Owner/Admin only. Mutations declare audit targets and public target ID fields.

Draft patch input includes a section-discriminated patch and `expectedDraftRevision`. Publish includes `expectedDraftRevision`, `expectedBaseActiveVersionId`, reason, and idempotency key. Bulk assignment/revocation uses arrays and one idempotency key. Principal search defaults to 20 and uses a cursor, not offset. Resource catalog returns hash/completeness/unavailable kinds.

- [ ] **Step 3: Run contract tests and confirm failure**

Run: `pnpm --filter @oxagen/oxagen test:unit -- src/iam/schemas.test.ts src/contracts/iam`

Expected: FAIL because the new contracts are absent and `list_iam_roles` still exposes the agent surface/legacy output.

- [ ] **Step 4: Implement and register strict contracts**

Keep shared schemas outside `src/contracts/` so `check-contracts.mjs` does not mistake a schema helper for a registered capability. New contracts declare `layers: ["schema", "api", "mcp", "unit", "docs"]`; do not claim `app` until Phase 4 supplies a real UI binding. Retain `app` on `list_iam_roles` because the existing Policies page remains a real consumer in this phase.

- [ ] **Step 5: Write failing handler-service delegation tests**

The handler family must only validate contract input, assert the authenticated management envelope already supplied by the kernel, call one `@oxagen/iam` service, and parse output. Mock services to prove no handler uses raw `db()`, `withSystemDb`, direct ClickHouse, role logic, manual Owner checks, or fire-and-forget audit.

- [ ] **Step 6: Implement thin handlers and lazy registration**

Use dotted legacy filenames but register the verb-first names above. `list_iam_roles` moves from `withSystemDb`/manual org filters to the tenant-safe role query. Service-account handlers call the atomic lifecycle service; access-request handlers call the state machine; all mutation attribution comes from `ctx.principal.id`.

- [ ] **Step 7: Verify contracts, handlers, and registries**

Run: `pnpm --filter @oxagen/oxagen test:unit -- src/iam/schemas.test.ts src/contracts/iam`

Run: `pnpm --filter @oxagen/handlers test:unit -- src/iam.role.list.test.ts src/iam-management.test.ts`

Run: `pnpm check:contracts && pnpm check:manifest --json`

Run: `pnpm --filter @oxagen/oxagen typecheck && pnpm --filter @oxagen/handlers typecheck`

Expected: PASS with every registered name resolving to exactly one lazy handler.

- [ ] **Step 8: Commit**

```bash
git add packages/oxagen/src/iam/schemas.ts packages/oxagen/src/iam/schemas.test.ts packages/oxagen/src/contracts packages/oxagen/src/contracts.generated.ts packages/oxagen/capabilities.manifest.json packages/handlers/src
git commit -m "feat(iam): add enterprise policy management capabilities"
```

### Task 14: Add org-scoped API/MCP parity and capability documentation

**Files:**
- Create: `apps/api/src/routes/v1/iam.ts`
- Evolve: `apps/api/src/routes/v1/iam.role.list.ts`
- Evolve: `apps/api/src/routes/v1/iam.role.list.test.ts`
- Create: corresponding `apps/api/src/routes/v1/<stem>.ts` thin adapter for every new Task 13 contract stem
- Create: `apps/api/src/routes/v1/iam.management.test.ts`
- Modify: `apps/api/src/app.ts`
- Create: corresponding `apps/mcp/src/tools/<stem>.ts` for every Task 13 stem
- Evolve: `apps/mcp/src/tools/iam.role.list.ts`
- Create: `apps/mcp/src/tools/iam.schema.test.ts`
- Create: `apps/mcp/src/tools/iam.handlers.test.ts`
- Verify/modify: `apps/mcp/src/tools/tool-registry.test.ts`
- Create/update: `docs/capabilities/<stem>.md` for every Task 13 stem
- Modify: `docs/capabilities/_index.md`
- Regenerate: `docs/capabilities/schemas/` with `pnpm docs:schemas`
- Modify: `apps/app/src/app/[orgSlug]/governance/policies/page.tsx`
- Modify: tests for the existing Governance Policies roles table
- Modify: `apps/app/capability-ui-map.json` only for the existing `list_iam_roles` binding if its description changes
- Regenerate: `packages/oxagen/src/contracts.generated.ts`
- Regenerate: `packages/oxagen/capabilities.manifest.json`

**API route map:**

```text
GET    /v1/:org_slug/iam/roles
GET    /v1/:org_slug/iam/roles/:roleId
POST   /v1/:org_slug/iam/roles
PATCH  /v1/:org_slug/iam/roles/:roleId/draft
POST   /v1/:org_slug/iam/roles/:roleId/publish
POST   /v1/:org_slug/iam/roles/:roleId/archive
POST   /v1/:org_slug/iam/roles/:roleId/restore
GET    /v1/:org_slug/iam/roles/:roleId/versions
POST   /v1/:org_slug/iam/roles/:roleId/versions/:versionId/restore
GET    /v1/:org_slug/iam/principals
GET    /v1/:org_slug/iam/principals/:principalId
POST   /v1/:org_slug/iam/service-accounts
POST   /v1/:org_slug/iam/service-accounts/:principalId/suspend
POST   /v1/:org_slug/iam/service-accounts/:principalId/restore
GET    /v1/:org_slug/iam/assignments
POST   /v1/:org_slug/iam/assignments
POST   /v1/:org_slug/iam/assignments/revoke
GET    /v1/:org_slug/iam/resources
POST   /v1/:org_slug/iam/preview
POST   /v1/:org_slug/iam/export
GET    /v1/:org_slug/iam/posture
GET    /v1/:org_slug/iam/access-requests
GET    /v1/:org_slug/iam/access-requests/:requestId
POST   /v1/:org_slug/iam/access-requests/:requestId/approve
POST   /v1/:org_slug/iam/access-requests/:requestId/deny
```

- [ ] **Step 1: Write failing org-router tests**

Mount a dedicated `iamScoped` Hono group with `authMiddleware` plus `orgMiddleware`, before `/v1/:org_slug/:workspace_slug`. Prove no workspace slug/sentinel is required, target workspace scope is validated from contract input, unauthenticated/cross-org access fails, typed errors survive, and every route invokes exactly its contract through the kernel. Assert the old workspace-only IAM list path is removed, not retained as an indefinite alias.

- [ ] **Step 2: Write failing MCP schema/handler tests**

Each xmcp module exports metadata derived from its contract, constructs an org authorization scope from authenticated context plus validated arguments, invokes the kernel on surface `mcp`, and parses output. Mutation annotations are not read-only/idempotent unless their idempotency contract makes them so. Typed IAM codes and safe conflict details survive MCP errors.

- [ ] **Step 3: Run tests and confirm failure**

Run: `pnpm --filter @oxagen/api test:unit -- src/routes/v1/iam.management.test.ts src/__tests__/context.test.ts src/__tests__/error.test.ts`

Run: `pnpm --filter @oxagen/mcp test:unit -- src/tools/iam.schema.test.ts src/tools/iam.handlers.test.ts src/tools/tool-registry.test.ts src/context.test.ts`

Expected: FAIL because only the legacy workspace-mounted role list exists.

- [ ] **Step 4: Implement the API router and MCP tools**

Keep one thin adapter module per capability; `iam.ts` only composes those modules into the org-scoped router. Parsing, authorization, and business logic remain contract/kernel/service concerns. Resolve target public IDs inside tenant services. Do not duplicate a second service-account list—the unified principal search is authoritative.

- [ ] **Step 5: Update capability docs and the existing read-only page**

Document scope, eligible principals, input/output, concurrency, typed errors, audit events, and examples for every contract, then run `pnpm docs:schemas` so the hosted JSON schemas match. Adapt the current Governance Policies role table to the versioned list output so its existing app-layer promise remains honest. Do not build the Phase 4 editable Permissions UI in this task and do not add fake app bindings for the new capabilities.

- [ ] **Step 6: Run parity and UI binding gates**

Run: `pnpm --filter @oxagen/api test:unit -- src/routes/v1/iam.management.test.ts src/__tests__/context.test.ts src/__tests__/error.test.ts`

Run: `pnpm --filter @oxagen/mcp test:unit -- src/tools/iam.schema.test.ts src/tools/iam.handlers.test.ts src/tools/tool-registry.test.ts src/context.test.ts`

Run: `pnpm check:manifest --json && pnpm check:ui-parity && pnpm check:mobile-parity`

Run: `pnpm docs:schemas`

Run: `pnpm --filter @oxagen/api typecheck && pnpm --filter @oxagen/mcp typecheck && pnpm --filter @oxagen/app typecheck`

Expected: PASS; all API capabilities have MCP parity, and only `list_iam_roles` claims an app binding in Phase 1.

- [ ] **Step 7: Commit**

```bash
git add apps/api apps/mcp apps/app/src/app/'[orgSlug]'/governance/policies apps/app/capability-ui-map.json docs/capabilities packages/oxagen/src/contracts.generated.ts packages/oxagen/capabilities.manifest.json
git commit -m "feat(iam): expose org policy management surfaces"
```

### Task 15: Reset/reseed pre-launch IAM, add readiness checks, and prove the Phase 1 exit

**Files:**
- Rewrite: `tools/scripts/seed-iam-defaults.ts`
- Rewrite: `tools/scripts/backfill-org-iam.ts` as `tools/scripts/reset-iam-prelaunch.ts`
- Remove: `tools/scripts/backfill-org-iam.ts`
- Modify: root `package.json`
- Rewrite: `packages/database/src/schema/iam.ts` to remove the enumerated legacy fields/tables
- Modify: `packages/database/src/schema/auth.ts` to make `principalId` required
- Rewrite: `packages/database/src/__tests__/iam-schema.test.ts` with final-state assertions
- Create: `packages/database/atlas/migrations/20260804130000_enterprise_iam_contract.sql`
- Modify: `packages/database/atlas/migrations/atlas.sum`
- Rewrite: `packages/handlers/src/iam-provision.ts`
- Rewrite: `packages/handlers/src/iam-provision.test.ts`
- Create: `packages/iam/src/readiness.ts`
- Create: `packages/iam/src/readiness.test.ts`
- Create: `packages/iam/src/authorization-performance.test.ts`
- Create: `packages/iam/src/authorization-performance.integration.test.ts`
- Create: `docs/runbooks/iam-prelaunch-cutover.md`
- Modify: `docs/specs/agent-rbac/spec.md` only for implementation evidence links/status after all checks pass

**Seed contract:**
- One org policy-version row.
- Explicit immutable system-role versions and explicit grants; no synthetic all-resource Owner and no future-resource wildcard.
- Complete migration table: org `Owner` stays human-only; org `Admin`, `Compliance`, and `Billing` permit human/service principals; legacy workspace `Viewer`, `Member`, and `Owner` metadata maps to `Observer`, `Contributor`, and `Operator`, whose published versions permit human/agent/service principals. Agents cannot receive org roles.
- Every existing contract `defaultRoles` key must resolve through that table in its declared valid scope or fail the seed. No role vocabulary is silently dropped, renamed heuristically, or broadened.
- The creating human receives the protected Owner assignment through the same assignment service.
- Agents and services receive no implicit role. Draft agents may remain inert; active/deployable agents require an active compatible workspace role; an active service requires at least one active compatible role in its exact org or workspace scope.

- [ ] **Step 1: Write failing seed/reset/readiness tests**

Assert repeatable seeds produce the same manifest and no duplicate active versions/grants/assignments; every legacy org/workspace role key maps through the frozen table; explicit default-role metadata is converted to capability grants only within each declared valid scope; Billing survives; Admin/Compliance/Billing can be assigned to services but not agents; Owner cannot be assigned to agents/services; no graph/MCP/skill/agent wildcard appears; and new resources remain denied.

Reset tests must refuse execution unless `ALLOW_DESTRUCTIVE_IAM_RESET=1`, parse the actual target, print only `scheme://***@host:port/database`, and accept only the exact local `localhost:5433/oxagen` allowlist unless a separately reviewed production migration exists. A blocklist of known production hosts is insufficient. The script supports a dry run with counts, cancels/resets unattributed v1 work, clears legacy IAM/MCP consent authorization state, reseeds, and verifies counts before commit. It never invents principals or rewrites production data silently.

Final schema/migration tests assert valid humans are mapped only as `subject_id = auth.users.id`; all new agent/service principals come from their canonical lifecycle transactions; required subject and credential bindings are non-null; composite source/scope FKs and immutability triggers are active; legacy `parent_user_id`, mutable role version/inheritance columns, capability-only role grants, and old access-request fields are physically gone; and no production module references their former Drizzle exports.

Readiness fails on missing policy row, missing active system versions, missing production IAM bootstrap, active agent/service without canonical principal/role, API key without explicit principal, legacy `parent_user_id`/role-grant reads, pending outbox dead letters above threshold, or queued/running unattributed `RunSpecV1` rows.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pnpm --filter @oxagen/handlers test:unit -- src/iam-provision.test.ts`

Run: `pnpm --filter @oxagen/iam test:unit -- src/readiness.test.ts src/authorization-performance.test.ts`

Expected: FAIL because seeding uses mutable roles/flat grants and no cutover readiness check exists.

- [ ] **Step 3: Implement guarded reset and deterministic reseed**

Add `pnpm db:reset-iam-prelaunch -- --dry-run` and an explicit live mode requiring the task-specific confirmation variable. Use `ensureSystemPolicyTx` from Task 7 plus the mutation/assignment services from Tasks 6-8; the reset script must not carry a second copy of role/version/grant SQL or its own role mapping. Add a post-cutover new-organization regression proving the ordinary bootstrap path and reset path produce the same system-policy manifest. The runbook orders backup, dry-run counts, exact database verification, expand/RLS migrations through version `20260804120000`, reset/reseed, the contract migration `20260804130000`, readiness, smoke tests, and rollback from backup. The contract migration begins with assertions that abort if any required subject/credential binding or reset invariant is unsatisfied. There is no deployed interval in which runtime reads both models: application cutover and reset/contract migration are one release gate.

- [ ] **Step 4: Apply and verify only against the explicit local database**

Run:

```bash
pnpm exec tsx tools/scripts/assert-local-db-target.ts --atlas-env local
pnpm --filter @oxagen/database exec atlas migrate apply --env local --to-version 20260804120000
```

Run:

```bash
env -u DATABASE_URL \
  DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
  pnpm exec tsx tools/scripts/assert-local-db-target.ts --database-url-env DATABASE_URL
env -u DATABASE_URL \
  DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
  ALLOW_DESTRUCTIVE_IAM_RESET=1 pnpm db:reset-iam-prelaunch -- --execute
```

Run:

```bash
pnpm exec tsx tools/scripts/assert-local-db-target.ts --atlas-env local
pnpm --filter @oxagen/database exec atlas migrate apply --env local --to-version 20260804130000
env -u DATABASE_URL DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen pnpm db:migrate
```

Expected: every target assertion prints only the redacted `postgres://***@localhost:5433/oxagen`; Atlas `--env local` is validated from its actual HCL URL, the reset validates its actual `DATABASE_URL`, reset reports before/after counts, seeds explicit roles, the contract migration removes legacy state only after its assertions pass, ClickHouse migration 0026 is applied, and readiness passes. Do not run any mutation command against an unresolved, merely blocklisted, or production-like target.

- [ ] **Step 5: Prove functional and performance exit criteria**

Run the canonical resolver, loader, service, approval, kernel, database RLS, API, MCP, projector, and readiness test files named in Tasks 1-14. Then run:

`pnpm --filter @oxagen/iam test:unit -- src/authorization-performance.test.ts`

Run: `env -u DATABASE_URL DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen pnpm --filter @oxagen/iam test:integration -- src/authorization-performance.integration.test.ts`

Expected: identical runtime/simulator outcomes for every resource kind; no deployable agent/service without explicit principal and role; warm in-process predecision p95 below 25 ms; cold fetch-and-resolve p95 below 100 ms on the documented local fixture; and exact approval replay denied.

- [ ] **Step 6: Run final affected-slice quality gates**

Run: `TURBO_CONCURRENCY=1 pnpm exec turbo run lint typecheck test:unit build --filter=@oxagen/oxagen --filter=@oxagen/iam --filter=@oxagen/database --filter=@oxagen/tenancy --filter=@oxagen/handlers --filter=@oxagen/agent --filter=@oxagen/telemetry --filter=@oxagen/inngest-functions --filter=@oxagen/api --filter=@oxagen/mcp --filter=@oxagen/app`

Run: `pnpm check:contracts && pnpm check:manifest --json && pnpm check:ui-parity && pnpm check:mobile-parity && pnpm db:lint-migrations && pnpm db:atlas-validate && pnpm check:vision`

Expected: PASS. Inspect `check:manifest --json` for genuine API/MCP gaps rather than relying on a zero-affected-package gate.

- [ ] **Step 7: Record implementation evidence**

Update the spec status to implemented only after all commands pass. Link the migrations, resolver tests, RLS integration tests, API/MCP parity evidence, performance result, and cutover runbook. State that Phase 1 establishes the policy foundation; graph/tool enforcement, full Permissions GUI, access reviews, and signed evidence remain gated by Phases 3-5.

- [ ] **Step 8: Commit**

```bash
git add tools/scripts/seed-iam-defaults.ts tools/scripts/reset-iam-prelaunch.ts tools/scripts/backfill-org-iam.ts package.json packages/database/src/schema/iam.ts packages/database/src/schema/auth.ts packages/database/src/__tests__/iam-schema.test.ts packages/database/atlas/migrations packages/handlers/src/iam-provision.ts packages/handlers/src/iam-provision.test.ts packages/iam/src/readiness.ts packages/iam/src/readiness.test.ts packages/iam/src/authorization-performance.test.ts packages/iam/src/authorization-performance.integration.test.ts docs/runbooks/iam-prelaunch-cutover.md docs/specs/agent-rbac/spec.md
git commit -m "feat(iam): complete prelaunch policy cutover"
```

## Phase 1 Exit Checklist

- [ ] Humans, agents, and services resolve through one canonical principal spine; API keys bind explicitly and never inherit creator authority.
- [ ] Role identity, draft concurrency, immutable versions, exact grants, assignment expiry/revocation, last Owner, and policy counter invariants are enforced in services and the database.
- [ ] Node labels, relationship types, capabilities, MCP tools, skills, and agents are cataloged and grantable only at valid scopes; properties are not represented as IAM resources.
- [ ] Resolver precedence is deny, approval, allow, implicit deny; authority intersects across the supplied principal chain; every clock and hash is deterministic.
- [ ] Every tier and production surface uses the same bootstrapped kernel runtime; unavailable/missing policy fails closed.
- [ ] Exact approvals are post-normalization, single-use, policy-current, input-bound, and non-cacheable; temporary approvals become expiring assignments.
- [ ] Policy mutations and runtime decisions create atomic PostgreSQL audit obligations; the projector is idempotent and ClickHouse is not policy state.
- [ ] Runtime and simulator results match for every Phase 1 resource kind.
- [ ] Org-scoped API plus MCP management parity passes; no management contract is agent-discoverable; no fake Phase 1 app mappings exist.
- [ ] The guarded local reset/reseed and readiness checks pass with no permissive legacy role, unattributed active work, or deployable unassigned agent/service.
- [ ] Phase 1 does not claim graph pre-retrieval enforcement, Stella/RunSpecV2 delegation, the editable Permissions GUI, access-review completion, signed exports, or SOC 2 certification.
