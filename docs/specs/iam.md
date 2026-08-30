# IAM

Archived spec & plan — status: shipped (audited 2026-07-03).

> **Status: Shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> All three IAM phases have shipped. Phase 1 (tenant-to-org schema rename) completed with full migrations and route updates. Phase 2 (IAM data layer) delivered Postgres and ClickHouse schemas with idempotent seeding. Phase 3 (pure resolver, audit emission, kernel integration) is complete with comprehensive testing and CI guards.

**Implementation evidence**

- packages/database/src/schema/org.ts — org schema with organizations, orgUsers, orgSlugHistory tables
- packages/database/src/schema/iam.ts — 5 IAM tables (principals, roles, roleGrants, accessRequests, principalRoleAssignments) with OXA-1389 comment
- packages/telemetry/src/migrations/0003_iam_audit.sql — ClickHouse audit_events table for Phase 2
- packages/oxagen/src/iam/resolve.ts — pure resolver with 8-rule decision order (OXA-1390 Phase 3)
- packages/oxagen/src/iam/resolve.test.ts — 575 lines comprehensive unit test suite covering all resolver branches
- packages/iam/src/check-iam.ts — IAM check orchestrator (fetchAuthz + resolve + emitAudit)
- packages/iam/src/emit-audit.ts — fire-and-forget audit emission with hash-chain integrity
- packages/iam/src/bootstrap.ts — wires checkIAM into kernel.invoke via setKernelIAMRuntime (OXA-1498)
- packages/handlers/src/iam-provision.ts — bootstraps org and workspace IAM, seeds roles and grants
- packages/oxagen/src/contracts/agent.approval.resolve.ts — contracts using registerCapability with defaultRoles
- packages/oxagen/src/kernel.ts — invoke() lines 586-668 integrate IAM check with fail-closed enforcement
- tools/scripts/check-contracts.mjs — CI guard verifying contract registry completeness

**Source documents** (archived verbatim below)

- `docs/specs/iam/plan.md`

## Plan — `plan.md`

## IAM — Implementation Plan (Wave 1: The Spine)

Sequenced delivery plan for the load-bearing foundation that every operational surface in v2 depends on. Built from [`../information-architecture/spec.md`](../information-architecture/spec.md) §§ 9, 12, 15.

Status: **ready to execute** — Wave 1 only. Waves 5 + 6 (Access surface UI, SSO/SCIM, Compliance dashboards) will appear in this file as separate phases when their predecessors land.

### CI cost constraint

Each phase below ships as **one big PR**, not many small ones. Vercel CI minutes are the bottleneck; we trade reviewability of small diffs for fewer build runs. Where review needs splitting, use Reviewable / GitHub "Files changed" filters by directory, not separate PRs.

---

### Goals

1. Every governable action in the platform passes through a single capability check that is impossible to bypass.
2. The data model exists to represent humans, agents, and service accounts uniformly as principals, with grants resolvable in a documented order.
3. The legacy "tenant" naming is gone from schema, code, routes, and user-facing copy.
4. Default roles seed cleanly into every new org and workspace.
5. Audit events are written at every contract invocation; storage is ready for the eventual UI to read.

### Out of scope (deferred to later waves)

- The Access zone UI (matrix, role builder, policies editor) — Wave 5.
- SSO, SCIM, MFA enforcement — Wave 5.
- Audit feed UI, SIEM export endpoints, compliance dashboards — Wave 6.
- JIT access request UI — Wave 5.
- Custom role builder UI — Wave 5.

### Phase ordering and dependencies

```
Phase 1: Rename tenant → org
         ↓
Phase 2: IAM data layer (Postgres + ClickHouse, seeds)
         ↓
Phase 3: defineContract() helper + resolver + audit emission + handler sweep
```

Phase 1 must land first because IAM schemas reference `org_id`. Phase 3 depends on Phase 2's schemas and on Phase 1's column naming.

---

### Phase 1 — Rename tenant → org

**Ticket:** OXA-XXX *(filled in below)*

**Deliverable:** Single PR that removes "tenant" from the entire codebase, no view aliases, no compatibility shims. The schema is `org`, the table is `organizations`, the column is `org_id`.

#### Scope

**Database (one migration file: `0003_rename_tenant_to_org.sql`)**

| Before | After |
|---|---|
| Schema `organization` | Schema `org` |
| Table `organization.tenants` | Table `org.organizations` |
| Table `organization.tenant_users` | Table `org.org_users` |
| Table `organization.tenant_slug_history` | Table `org.org_slug_history` |
| Index `tenants_slug_idx` | Index `organizations_slug_idx` |
| Index `tenant_users_tenant_user_idx` | Index `org_users_org_user_idx` |
| Column `tenant_id` (everywhere it appears, ~all tenant-scoped tables) | Column `org_id` |
| Column `old_slug` / `new_slug` (in slug history) | Unchanged |
| PK prefix `ten_` | PK prefix `org_` |

Migration uses `ALTER SCHEMA ... RENAME TO`, `ALTER TABLE ... RENAME TO`, and `ALTER TABLE ... RENAME COLUMN`. Postgres handles all FK rewrites automatically because the rename preserves OIDs.

**Drizzle schema**

- `_schemas.ts`: `organizationSchema = pgSchema("organization")` → `orgSchema = pgSchema("org")`.
- `_mixins.ts`: `tenantScopeMixin` → `orgScopeMixin`. Returns `{ orgId: uuid("org_id").notNull(), workspaceId: ... }`.
- `organization.ts` → `org.ts` (file rename). Exports become `organizations`, `orgUsers`, `orgSlugHistory`.
- Every schema file using `tenantScopeMixin` switches to `orgScopeMixin`.
- The barrel `schema/index.ts` re-exports the renamed members.

**Capability contracts (`packages/oxagen/src/contracts/`)**

- `tenant.create.ts` → `organization.create.ts`. Update Zod schema field names, contract id string, JSDoc.
- `tenant.create.test.ts` → `organization.create.test.ts`. Update assertions.
- Anywhere a contract takes `tenantId` as input → `orgId`.

**Apps**

- Route segment `[tenantSlug]` → `[orgSlug]`. File-system rename. Search-and-replace `params.tenantSlug` → `params.orgSlug`.
- Onboarding route `(onboarding)/new-tenant` → `(onboarding)/new-organization`. Update `actions.ts` to import the renamed contract.
- Server actions that take `tenantId` → `orgId`.
- App shell: `TenantSwitcher` → `OrgSwitcher`. `availableTenants` prop → `availableOrgs`. Types `ResolvedTenant` → `ResolvedOrg`.
- UI string sweep — already substantially done in earlier work, finish anything missed.
- 301 redirects in `apps/app/src/middleware.ts` from any pre-existing v1-shaped URLs: `/new-tenant` → `/new-organization`.

**Cross-cutting**

- `CLAUDE.md`: any reference to tenant terminology in the runtime model.
- README references.

#### Acceptance

- [ ] `pnpm db:migrate` applies the rename migration cleanly on a fresh DB and on the current dev DB.
- [ ] `pnpm typecheck` is green across all 19 packages.
- [ ] `pnpm lint` is green.
- [ ] `pnpm dev` boots, login → org creation → workspace creation → chat all work end-to-end.
- [ ] `grep -rE "tenantId|tenant_id|tenantSlug|TenantUser|tenantSchema" packages apps` returns no matches in `.ts`/`.tsx` (excluding migrations and node_modules).
- [ ] Migration is reversible (down migration documented inline, even if not run).

#### Risks

- **Live data loss** if anyone is on the dev DB while the migration runs. Mitigation: include a guard in the migration script that aborts if any DB connection != the migrator. Document the cutover.
- **Forgotten string references** in JSON/Markdown/SQL files. Mitigation: the `grep` step in acceptance criteria is the safety net.

#### Rollback

Single-shot revert of the rename migration. Drizzle schema files revert via git. No data migration to undo because column renames preserve data in place.

---

### Phase 2 — IAM data layer

**Ticket:** OXA-XXX

**Deliverable:** Single PR that adds the Postgres + ClickHouse schemas for the IAM model, exports them from `@oxagen/database`, and seeds default roles + grants directly from each contract's `defaultRoles` declaration.

#### Scope

**New Postgres schema (`org` extended)**

Migration `0004_iam_foundation.sql`. All tables under the `org` schema (one PG schema for the whole IAM model — no separate `iam` schema). **6 tables total** — there is no `capability_registry` table; capability metadata lives on each contract's `defineContract` call and is discovered at runtime by walking the package `contracts` arrays.

```
org.principals          all humans, agents, services
org.roles               role definitions, system + custom, versioned
org.role_grants         role → capability mapping
org.grants              direct principal → capability grants
org.policies            conditional grants, enforced flag, sensitivity tags
org.access_requests     JIT access requests
org.sessions            principal sessions (active + revoked)
```

Each table uses `idMixin('prn' / 'rol' / 'grn' / 'pol' / 'arq' / 'ses')`, `auditMixin()`, and `orgScopeMixin()` (where appropriate — principals can be org or workspace scoped).

Key columns:

```
principals: kind ('human'|'agent'|'service'), display, status, mfa_status,
            idp_subject, parent_user_id (for delegated agents)
roles:      name, description, scope_kind ('org'|'workspace'),
            is_system_default, version, parent_role_id
role_grants: role_id, capability_id, effect ('allow'|'deny'|'require_approval')
grants:     principal_id, capability_id, scope_kind, scope_id,
            effect, conditions_jsonb, granted_by, granted_at, expires_at
policies:   name, capability_id, scope_kind, scope_id,
            effect, enforced (bool), conditions_jsonb, sensitivity_tag
access_requests: requester_id, capability_id, scope_kind, scope_id,
                 status ('pending'|'approved'|'denied'|'expired'),
                 approver_id, approved_at, ttl_seconds
sessions: principal_id, started_at, expires_at, ip, ua, idp_session_id,
          revoked_at, revoked_by, revoke_reason
```

Indexes designed for the resolver's read patterns: lookups by `(principal_id, capability_id, scope)` are hot; everything else is occasional.

**ClickHouse schema (new package `@oxagen/telemetry` table)**

Migration in `packages/telemetry/migrations/`:

```sql
CREATE TABLE audit_events (
    occurred_at DateTime64(3),
    event_id UUID,
    org_id UUID,
    workspace_id Nullable(UUID),
    capability LowCardinality(String),
    scope_kind Enum('org', 'workspace'),
    scope_id UUID,
    acting_principal_id UUID,
    acting_principal_kind Enum('human', 'agent', 'service'),
    human_principal_id Nullable(UUID),
    outcome Enum('allow', 'deny', 'pending_approval'),
    decision_reason LowCardinality(String),
    target_kind Nullable(String),
    target_id Nullable(String),
    payload_hash String,
    ip Nullable(IPv6),
    ua Nullable(String),
    request_id UUID,
    correlation_id Nullable(UUID),
    trace_jsonb String DEFAULT ''
) ENGINE = ReplacingMergeTree(occurred_at)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (org_id, occurred_at, event_id)
TTL occurred_at + INTERVAL 7 YEAR;
```

Hash-chaining is implemented at write time, not at storage time — the application computes a chain hash that links each event to the previous one for the same `(org_id, capability)`. ClickHouse stays as the column store; tamper-evidence is a write-time concern.

**Drizzle exports**

- `packages/database/src/schema/iam.ts` — new file with all 6 PG tables.
- `packages/database/src/schema/index.ts` — re-export.
- `packages/database/src/relations.ts` — relations between principals, roles, grants, sessions.

**Seed migration (`0005_iam_seed_defaults.sql`)**

Inserts the system roles **for every existing org** at migration time, and the seed function fires for new orgs via a trigger.

```
Org roles (per-org rows):
  Owner       (id stable per-org: deterministic from org_id)
  Admin
  Compliance
  Billing

Workspace roles (per-workspace rows):
  Owner
  Member
  Viewer
```

Each system role gets its `role_grants` rows written directly from the `defaultRoles` field on each contract. The seed migration script walks the `contracts` arrays exported from `@oxagen/oxagen/contracts` and `@oxagen/agent/handlers`, reads each contract's `defaultRoles: { org: { Owner: 'allow', ... }, workspace: { ... } }` declaration, and writes the corresponding `role_grants` rows. There is no separate `default-role-grants.ts` dataset — the contracts are the authoritative source. Adding a new contract automatically includes its default grants in the next seed run.

#### Acceptance

- [ ] Postgres migration applies; 6 IAM tables exist with correct indexes (no `capability_registry` table).
- [ ] ClickHouse migration applies; `audit_events` table exists.
- [ ] Seed migration inserts 4 org roles + 3 workspace roles per existing org/workspace.
- [ ] `role_grants` rows are seeded from each contract's `defaultRoles` field — verified by querying the DB and comparing to the `defaultRoles` declarations in the contract source.
- [ ] New org creation (via existing `organization.create` flow) writes the 4 default roles automatically.
- [ ] `pnpm typecheck` green.
- [ ] `pnpm db:check` reports the 6 new IAM tables.

#### Risks

- **ClickHouse migration drift** between local and production. Mitigation: run `pnpm db:migrate` always under `doppler run` (now removed — use `vercel env pull`-sourced `.env.local`) so the same connection string is used.
- **Seed migration on existing prod data** if anyone migrates a populated DB. Mitigation: seed is idempotent (insert-on-conflict do-nothing).

#### Rollback

Drop the IAM tables in reverse FK order. ClickHouse table drop. Seed reverses cleanly because rows are deterministic.

---

### Phase 3 — defineContract() + resolver + audit emission + handler sweep

**Ticket:** OXA-XXX

**Deliverable:** Single PR that introduces the `defineContract()` helper as the single load-bearing capability boundary, the pure resolver function, the audit event emitter, and migrates every existing contract handler through `defineContract`.

#### Scope

**`defineContract()` helper (`packages/oxagen/src/iam/define-contract.ts`)**

`defineContract` is the only entrypoint for declaring a governable action. It accepts a single typed argument and returns an object with `{ id, metadata, invoke(ctx, input) }`. The raw handler closure never escapes the helper — there is no way to call the handler without going through the capability check by construction.

```ts
// packages/oxagen/src/contracts/organization.create.ts
export const organizationCreate = defineContract({
  id: "organization.create",
  domain: "organization",
  description: "Create a new organization with an owner",
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({ name: z.string(), slug: z.string() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => { /* … */ },
});
```

Argument shape enforced by TypeScript — `sensitivity`, `defaultEffect`, `defaultRoles`, `input`, and `output` are all required fields. There is no separate metadata decoration step; the type system rejects an incomplete `defineContract` call at compile time.

`invoke(rawCtx, input)` internally:

1. Resolves the principal from the request session.
2. Fetches grants, roles, and policies for that principal scoped to the call.
3. Runs the pure resolver (`resolve.ts`).
4. Emits an audit event with the full trace (fire-and-forget).
5. On `allow` — calls the handler with a `CheckedContext` (resolved principal + scope).
6. On `deny` — returns a structured denial response without touching the handler.
7. On `pending_approval` — creates an `access_requests` row, returns a denial with the request ID.

**Pure resolver (`packages/oxagen/src/iam/resolve.ts`)**

```ts
type ResolveInput = {
  principal: Principal;
  capability: string;
  scope: { kind: 'org' | 'workspace'; orgId: string; workspaceId?: string };
  grants: Grant[];           // pre-fetched from DB by caller
  roles: Role[];             // pre-fetched
  policies: Policy[];        // pre-fetched
};

type ResolveResult =
  | { outcome: 'allow'; trace: Trace }
  | { outcome: 'deny';  reason: 'no_grant' | 'workspace_deny' | 'org_enforced_deny' | 'expired' | 'condition_failed'; trace: Trace }
  | { outcome: 'pending_approval'; requestId?: string; trace: Trace };

type Trace = {
  steps: TraceStep[];        // ordered, every rule evaluated
  decidedBy: TraceStep;      // pointer to the rule that decided
};
```

Implements the documented order (see IA spec §12):

1. Workspace explicit deny → DENY
2. Org enforced deny → DENY
3. Workspace explicit allow → ALLOW
4. Org enforced allow → ALLOW
5. Workspace require_approval → PENDING
6. Org default grant + workspace silence → inherit org
7. Role-inherited grant → inherit role
8. Default-deny

Pure function: takes pre-fetched data, returns a decision + trace. No I/O. `defineContract`'s `invoke` is the only caller. Easy to unit-test exhaustively. Note: the `capabilityRegistry` parameter from the original design is removed — capability metadata is carried on each contract object and does not need to be passed into the resolver.

**Audit emitter (`packages/oxagen/src/iam/emit-audit.ts`)**

Builds the `AuditEvent` payload from the resolver trace + invocation context, computes the hash-chain pointer (read the latest event for `(org_id, capability)`, hash it with this event), writes to ClickHouse via `@oxagen/telemetry`. Called from one place only: inside `invoke()` in `define-contract.ts`. The write is fire-and-forget but logs failures loudly — auditing failures are critical incidents.

**Contract discovery model**

Each package exposes a `contracts` array as its public surface for capability discovery. Everything that needs to read the registry — the seed migration, the access matrix UI in Wave 5, capability auto-docs — walks these arrays. Adding a contract means creating the file and adding one line to the array:

```ts
// packages/oxagen/src/contracts/index.ts
export const contracts = [
  organizationCreate,
  workspaceCreate,
  chatMessageSend,
] as const;
```

```ts
// packages/agent/src/handlers/index.ts
export const contracts = [
  agentApprovalResolve,
  agentPlanApprove,
  agentTaskBackgroundCancel,
  agentTaskBackgroundRead,
  agentCodeExecute,
] as const;
```

The `contracts` array is the canonical registry. No database table mirrors it. Any tooling that previously queried `capability_registry` now imports the array directly (or via dynamic `import()` in the seed script).

**CI guard (`tools/scripts/check-contracts.mjs`)**

Structurally there is no bypass to guard against — the capability check lives inside `defineContract` and the handler never escapes. The lighter check that remains: verify that the package-level `contracts` array contains every `defineContract` call found in that package's `contracts/` directory. This is a ~20-line glob + grep script. It catches forgotten exports (contract file exists but was not added to the array), not bypasses. Added to the root `gate` script.

**Handler sweep**

Every existing contract handler in the codebase is refactored through `defineContract`. Inventory from earlier explorations:

| Contract | File | Capability id |
|---|---|---|
| organization.create | `packages/oxagen/src/contracts/organization.create.ts` | `organization.create` |
| workspace.create | `packages/oxagen/src/contracts/workspace.create.ts` | `workspace.create` |
| chat.message.send | `packages/oxagen/src/contracts/chat.message.send.ts` | `chat.message.send` |
| agent.approval.resolve | `packages/agent/src/handlers/agent.approval.resolve.ts` | `agent.approval.resolve` |
| agent.plan.approve | `packages/agent/src/handlers/agent.plan.approve.ts` | `agent.plan.approve` |
| agent.task.background.cancel | `packages/agent/src/handlers/agent.task.background.cancel.ts` | `agent.task.background.cancel` |
| agent.task.background.read | `packages/agent/src/handlers/agent.task.background.read.ts` | `agent.task.background.read` |
| agent.code.execute | `packages/agent/src/handlers/agent.code.execute.ts` | `agent.code.execute` |

Each file is refactored to export a single `defineContract({...})` call containing `id`, `domain`, `description`, `sensitivity`, `defaultEffect`, `defaultRoles`, `input`, `output`, and `handler`. The old separate handler export is removed. Server actions that call the handler are updated to call `.invoke(rawCtx, input)` and handle the structured denial response.

**Unit tests**

`packages/oxagen/src/iam/resolve.test.ts` covers every branch of the resolver:

- Org allow, no workspace override → allow.
- Org allow, workspace deny → deny (rule 1).
- Org enforced deny, workspace allow → deny (rule 2 beats rule 3).
- Workspace require_approval → pending (rule 5).
- No grant anywhere → deny (rule 8).
- Expired grant → deny.
- Conditional grant with failing predicate → deny.
- Trace contains exactly the steps evaluated.

Aim for >95% line coverage on `resolve.ts`.

#### Acceptance

- [ ] All resolver branches unit-tested; coverage >95%.
- [ ] Every existing contract handler is refactored through `defineContract`; CI `contracts` array check passes.
- [ ] CI guard (`check-contracts.mjs`) fails when a contract file exists in `contracts/` but is not added to the package `contracts` array.
- [ ] Audit events appear in ClickHouse after invoking any contract end-to-end.
- [ ] Hash chain verification: a script can replay events for an `(org_id, capability)` pair and confirm chain integrity.
- [ ] `pnpm dev` end-to-end smoke: signup → org create → workspace create → chat → background task all succeed, each writes audit events.
- [ ] Denial response shape is consistent across all handlers (uniform structured error).
- [ ] `pnpm gate` passes.

#### Risks

- **ClickHouse write latency** on hot paths. Mitigation: fire-and-forget with a bounded retry queue in-process. If ClickHouse is unavailable, queue locally up to 1000 events, then circuit-break and log. Audit writes never block user actions.
- **Hash chain race conditions** if two contract invocations for the same `(org_id, capability)` happen concurrently. Mitigation: chain hash is best-effort linkage, not a strict-ordering guarantee. Tamper-detection is at the *range* level (any reorder is detectable), not at the per-event level. Document this clearly.
- **Forgotten export.** Mitigation: the CI `contracts` array check catches any contract file not added to the package array. Structurally there is no bypass to miss.

#### Rollback

`defineContract` can be split back into separate handler + wrapper exports; the underlying handlers still work. The audit table accumulates events but doesn't block anything. Removing the CI guard is a one-line change. No data state to unwind.

---

### After Wave 1

Wave 1 lands. The platform now has:

- A clean schema with no tenant terminology.
- A unified principal/grant/role/policy data model (6 Postgres tables).
- A pure, tested resolver that decides every capability invocation.
- A `defineContract()` boundary that is structurally impossible to bypass — the capability check, audit emission, and handler invocation are collapsed into one call.
- A per-package `contracts` array that is the canonical capability registry, discoverable without a database table.
- A lightweight CI guard that ensures every contract file is exported in its package array.

The shell rework (Wave 2) and route restructure (Wave 3) can start in parallel because they don't touch any of this. Wave 5 (the Access zone UI) becomes a "walk the contracts arrays, read the data model, and render it" problem, which is exactly what we want for a stable IAM ship.

---

### Changelog

- 2026-05-29 — Initial Wave 1 plan. Schema rename committed to `org` schema + `organizations` table (no view alias), per locked product decision.
- 2026-05-29 — Capabilities architecture collapsed: single `defineContract()` helper replaces `withMetadata` + `withCapabilityCheck` + `default-role-grants.ts` + `capability_registry` table + CI guard. Discovery is a per-package `contracts` array.

