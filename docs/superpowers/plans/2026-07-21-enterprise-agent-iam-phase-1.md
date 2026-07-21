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
- PostgreSQL policy writes use `withTenantDb` and accept the caller's existing transaction. `withSystemDb` is limited to named cross-tenant projector/sweeper jobs. Raw `db()` is prohibited.
- A policy mutation, its org policy-version increment, immutable audit event, and outbox delivery row commit together. ClickHouse failure cannot roll back policy and cannot erase the delivery obligation.
- Runtime allow, deny, and approval outcomes are durably recorded before an agent-visible result or side effect. Exact approval claims and final execution decisions are never cached.
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
- Create: `packages/oxagen/src/iam/errors.ts`
- Create: `packages/oxagen/src/iam/errors.test.ts`
- Modify: `packages/oxagen/src/iam/index.ts`
- Modify: `packages/oxagen/src/types.ts`
- Modify: `packages/oxagen/src/types.test.ts`
- Modify: `packages/oxagen/src/kernel.ts`
- Modify: `apps/api/src/middleware/error.ts`
- Modify: `apps/api/src/__tests__/error.test.ts`

**Interfaces:**
- Produces: `AuthorizationScope`, `PrincipalRef`, `PrincipalAuthority`, `IamResourceKind`, `IamResourceRef`, `IamEffect`, `IamOutcome`, `IamReasonCode`, `DecisionTrace`, `AuthorizationDecision`, `IamErrorCode`, `IamError`.
- Extends: `CapabilityContext` with a required discriminated `authorizationScope`; retain `orgId` and optional `workspaceId` only as handler compatibility projections during Phase 1.
- Public runtime codes include the §11.1 codes relevant to Phase 1: authorization/approval/policy unavailable, role not found/version/draft/archive/system-role, scope/resource mismatch, principal inactive, last owner, tier packaging denial, catalog unavailable, approval replay, and input changed.

- [ ] **Step 1: Write failing model and error tests**

Test exhaustive resource/action pairing, org/workspace scope parsing, decimal policy versions, deterministic trace serialization, no zero UUIDs, no composite aliases, and API status mapping. Assert an unknown resource and denied resource map to the same public `403 iam_authorization_denied` response for a non-admin caller.

- [ ] **Step 2: Run the tests and confirm failure**

Run: `pnpm --filter @oxagen/oxagen test:unit -- src/iam/model.test.ts src/iam/errors.test.ts src/types.test.ts`

Run: `pnpm --filter @oxagen/api test:unit -- src/__tests__/error.test.ts`

Expected: FAIL because the model, codes, and discriminated authorization scope do not exist.

- [ ] **Step 3: Implement strict model types and Zod schemas**

Use discriminated unions for both scope and resources. Reject an org scope carrying `workspaceId`, a workspace scope without one, empty IDs, all-zero UUIDs where UUIDs are required, and actions invalid for a resource kind. Keep `PrincipalRef` limited to `{ id, kind, subjectId, status, orgId, workspaceId? }`; ownership and display metadata are not authority.

Represent `policyVersion` as a base-10 string at package boundaries and `bigint` only inside persistence. `validUntil` is the earliest authority expiry; when none exists, use `9999-12-31T23:59:59.999Z` and let the cache apply its shorter local TTL.

- [ ] **Step 4: Implement typed errors and API mapping**

Add a stable `code` field and structured safe details. Map authentication to 401, opaque denial to 403, approval required to 409, role/draft conflicts to 409 with current server revisions, unavailable policy/catalog to 503, and invalid admin-authored scope to 422. Never return resolver traces to non-admin runtime callers.

- [ ] **Step 5: Run focused tests and types**

Run: `pnpm --filter @oxagen/oxagen test:unit -- src/iam/model.test.ts src/iam/errors.test.ts src/types.test.ts`

Run: `pnpm --filter @oxagen/api test:unit -- src/__tests__/error.test.ts`

Run: `pnpm --filter @oxagen/oxagen typecheck && pnpm --filter @oxagen/api typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/oxagen/src/iam packages/oxagen/src/types.ts packages/oxagen/src/types.test.ts packages/oxagen/src/kernel.ts apps/api/src/middleware/error.ts apps/api/src/__tests__/error.test.ts
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
- Modify: `packages/oxagen/src/contracts/capability.registry.list.ts`
- Modify: `packages/oxagen/src/contracts/capability.registry.list.test.ts`
- Modify: `tools/scripts/check-contracts.mjs`
- Modify: `tools/scripts/check_manifest.mjs`
- Modify: `tools/scripts/check_manifest.test.ts`

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

Expected: PASS with zero unclassified or scope-inconsistent contracts.

- [ ] **Step 6: Commit**

```bash
git add packages/oxagen/src tools/scripts/check-contracts.mjs tools/scripts/check_manifest.mjs tools/scripts/check_manifest.test.ts
git commit -m "feat(capabilities): declare IAM resource scopes"
```

### Task 4: Build the replacement IAM schema, constraints, and RLS

**Files:**
- Rewrite: `packages/database/src/schema/iam.ts`
- Modify: `packages/database/src/schema/auth.ts`
- Modify: `packages/database/src/schema/index.ts`
- Modify: `packages/database/src/relations.ts`
- Modify: `packages/database/src/relations.test.ts`
- Rewrite: `packages/database/src/__tests__/iam-schema.test.ts`
- Modify: `packages/database/src/__tests__/schema-smoke.test.ts`
- Modify: `packages/database/src/tenant-policy.manifest.ts`
- Modify: `packages/database/src/tenant-policy.manifest.test.ts`
- Create: `packages/database/atlas/migrations/20260804110000_enterprise_iam_expand.sql`
- Create: `packages/database/atlas/migrations/20260804120000_enterprise_iam_reset.sql`
- Create: `packages/database/atlas/migrations/20260804130000_enterprise_iam_constraints.sql`
- Modify: `packages/database/atlas/migrations/atlas.sum`
- Test: `packages/database/integration/iam-rls.test.ts`

**Schema contract:**

- `iam.principals`: required `subject_id`, `kind`, `status`, nullable workspace, external identity/display projections, unique live `(org_id, kind, subject_id)`; no `parent_user_id` after cutover.
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
- `auth.api_keys`: required explicit `principal_id`, credential status/revocation, and no creator-based authorization semantics.

- [ ] **Step 1: Write failing schema and relation tests**

Assert all columns, FKs, partial unique indexes, enum/check constraints, public-ID prefixes, subject-kind bindings, same-org/workspace composite references, one live draft, active-version ownership, immutable published state, active-only assignment uniqueness, one service principal per account, approval single-use fields, audit immutability, and API-key principal binding. Assert no `parentUserId`, `roles.version`, `roles.parentRoleId`, or legacy capability-only `roleGrants` export remains.

- [ ] **Step 2: Write failing RLS coverage tests**

Classify identity/policy tables with the established nullable-workspace policy and outbox/event rows with explicit tenant columns. Assert tenant reads cannot cross orgs or workspaces; org-scoped roles are visible only inside the same org; a worker using tenant scope cannot claim another tenant's outbox; only the named system projector can scan cross-tenant deliveries.

- [ ] **Step 3: Run focused database tests and confirm failure**

Run: `pnpm --filter @oxagen/database test:unit -- src/__tests__/iam-schema.test.ts src/relations.test.ts src/tenant-policy.manifest.test.ts`

Expected: FAIL because the replacement tables and constraints do not exist.

- [ ] **Step 4: Implement Drizzle schema and migrations**

Migration 1 expands additive structures. Migration 2 performs the approved pre-launch cutover: map only valid human `subject_id = parent_user_id`, cancel/reset unattributed queued/running v1 work, remove legacy assignments/grants/roles/access requests, and leave no permissive role. Migration 3 validates counts, installs composite/partial constraints and immutability triggers, makes required bindings non-null, and drops legacy columns/tables. Do not invent agent/service principals or use a zero UUID.

Use PostgreSQL triggers only for invariants impossible to express with Drizzle checks: immutable published role versions/grants, `active_version_id` ownership/scope, subject source-kind/org validation, and append-only audit events.

- [ ] **Step 5: Regenerate the Atlas checksum and validate migrations**

Run: `(cd packages/database && atlas migrate hash --dir "file://atlas/migrations")`

Run: `pnpm db:lint-migrations && pnpm db:atlas-validate`

Expected: PASS; `atlas.sum` contains the three ordered migrations and no edited historical checksum.

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
git add packages/database/src packages/database/integration/iam-rls.test.ts packages/database/atlas/migrations
git commit -m "feat(database): add versioned enterprise IAM schema"
```
