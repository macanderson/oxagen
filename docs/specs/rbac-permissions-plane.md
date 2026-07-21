# RBAC Permissions Plane — historical proposal

- **Status:** Superseded — do not implement
- **Date:** 2026-07-07
- **Author:** platform
- **Related:** [ADR-009](../adr/ADR-009-unified-capability-tool-model.md) (unified capability/tool model), [ADR-013](../adr/ADR-013-oxagen-plugins-capability-packs.md) (capability packs), [ADR-014](../adr/ADR-014-workspace-scoped-mcp-registry-single-default.md) (workspace-scoped MCP registries), [docs/VISION.md](../VISION.md) (governance wedge)

> The approved canonical design is
> [`docs/specs/agent-rbac/spec.md`](agent-rbac/spec.md). It resolves principal
> identity, deny precedence, delegation, graph label/relationship scope, tool
> enforcement, the Permissions UI, and the pre-launch reset posture. This file
> is retained only as historical analysis. Plugin-specific authorization not
> covered by the canonical design requires a separate approved specification.

---

## 1. Summary & motivation

Oxagen's wedge is being **the metered, governed, graph-grounded control plane for teams that build and resell AI agents** (`docs/VISION.md`). "Governed" is a load-bearing word: every capability is a typed contract with IAM + entitlement enforcement so that a downstream agent tool is *inherently* governed and un-poisonable. Contract governance is one of the three pillars of the moat.

Today that governance is **real and strong at exactly one of the four enforcement levels** — capability contracts — and **partial, parallel, or absent at the other three**:

1. **Skills** — no per-skill permissions exist. A skill's accessibility is a side effect of the `defaultRoles` on the `skill.*` / `agent.skill.load` capability contracts, which are the same for *every* skill. There is no way to say "only the Compliance role may load the `pii-redaction` skill" or "agents may not edit the `deploy` skill."
2. **Capability contracts** — fully governed by the 8-rule resolver, but with two serious defects (a tier bypass and a schema regression, §2) that mean the fine-grained matrix is effectively off for 90%+ of orgs and direct/policy grants are dead in prod.
3. **MCP server** — per-request scope is derived from an API key, and external tools are policy-checked, but *first-party* tools are neither scoped per key nor hidden from `tools/list` when unauthorized. An unauthorized tool is fully listed and only fails on call.
4. **Plugins / tools** — governed by a **separate** entitlement service (install/enable state), not by the IAM grant model. There is no per-plugin role grant — if a pack is installed in a workspace, every principal who can invoke its capabilities may do so.

The consequence: a customer reselling agents cannot express, in one coherent model, *"this principal may use this resource."* They configure capability role-grants in one place, plugin installs in another, MCP key scoping nowhere, and skill access not at all. This proposal defines a **single resource-grant model** that all four levels resolve through, reusing the existing `GrantEffect` vocabulary, the existing 8-rule resolver, and the existing `org`-schema IAM tables rather than inventing a parallel system.

---

## 2. Current state (what exists today, by level)

### 2.0 The shared spine: contracts + resolver + kernel

Every user-facing action is a `CapabilityDeclaration` (`packages/oxagen/src/types.ts`). Relevant fields:

- `scoped` (default true) — enforce tenant-scoped queries.
- `sensitivity`: `low | medium | high | destructive` — drives audit tagging and seed decisions.
- `defaultEffect`: `allow | deny | require_approval` — the resolver's rule-8 fallback.
- `defaultRoles: { org: Partial<Record<SystemOrgRole, GrantEffect>>, workspace: Partial<Record<SystemWorkspaceRole, GrantEffect>> }` — the seeded role→capability matrix.
- `agent?: { requiresApproval?, riskLevel?, category? }` — agent-surface approval/risk metadata.
- `aliases?` — retired names, so a rename never orphans a grant row (ADR-022).

Roles are fixed system vocabularies: `SystemOrgRole = Owner | Admin | Compliance | Billing`; `SystemWorkspaceRole = Owner | Member | Viewer`. `GrantEffect = allow | deny | require_approval`.

The **resolver** (`packages/oxagen/src/iam/resolve.ts`) is a pure, I/O-free function with a fixed precedence:

```
Rule 1  Workspace explicit deny        → DENY
Rule 2  Org enforced deny policy       → DENY
Rule 3  Workspace explicit allow       → ALLOW
Rule 4  Org enforced allow policy      → ALLOW
Rule 5  Workspace require_approval     → PENDING
Rule 6  Org default grant              → inherit
Rule 7  Role-inherited grant           → inherit
Rule 7.5 System org Owner              → ALLOW (super-user)
Rule 8  Contract defaultEffect         → fallback
```

Grants and policies may carry a `conditionsJsonb` bag evaluated by `packages/oxagen/src/iam/conditions.ts` — a dependency-free evaluator supporting `time_window` (tz-aware, midnight-wrapping) and `ip_ranges`/`ip_allow` (IPv4/IPv6 CIDR). It is **fail-closed**: unknown keys, malformed values, or a null client IP against an IP condition all evaluate to `false`.

The **kernel** (`packages/oxagen/src/kernel.ts`, `_invokeCore`) is the single dispatch path for every surface. Enforcement order per invocation:

```
getCapability (alias-resolve) → surface allowlist → input validation
  → runInTenantScope (scoped caps) → IAM check → billing admission gate
  → capability entitlement gate → handler → output validation → audit/trace emit
```

IAM is wired in by `bootstrapIAMRuntime()` (`packages/iam/src/bootstrap.ts`) with **enforcement always on**. The kernel fails **closed** when the IAM check *throws* (unconditional, independent of the enforcement flag — OXA-2056), but only logs a would-deny when enforcement is off and the resolver *decides* deny.

### 2.1 Skills — no per-skill permissions

`skills` and `skill_versions` (`packages/database/src/schema/agent.ts`) carry identity, a per-workspace `enabled` toggle, and a pinned `activeVersionId`. **There is no permissions column and no per-skill grant table.** Access to skills is governed only through the `skill.*` capability contracts, e.g. `skill.enable` and `agent.skill.load` (`packages/oxagen/src/contracts/`), whose `defaultRoles` are identical across all skills:

```ts
// agent.skill.load — same matrix for every skill in the workspace
defaultRoles: {
  org: { Owner: "allow", Admin: "allow" },
  workspace: { Owner: "allow", Member: "allow" },
}
```

So "who may load a skill" is a property of the *verb*, not the *skill*. A workspace cannot restrict a sensitive skill to a subset of principals, gate skill editing away from agents, or grant a partner-authored skill to one team only.

### 2.2 Capability contracts — governed, but two defects blunt it

Enforcement is real (§2.0), but two issues mean the fine-grained matrix rarely fires:

- **Tier bypass (P0).** `checkIAM` (`packages/iam/src/check-iam.ts:74`) reads the org's plan tier and, for any non-enterprise org, returns an unconditional `allow` before the resolver runs — `canAccessACL(tier)` is `tier === "enterprise"`. For every non-enterprise org, the only access control is *role membership plus each contract's `defaultEffect`*; explicit deny grants, `require_approval`, conditions, and the entire matrix are inert. This is confirmed in `docs/audit/silent-failure-findings.md` and surfaced (as intended paid-tier behaviour) on the public site, but it means the governance story is tier-gated rather than universal.
- **Direct grants + policies are dead in prod.** The resolver's rules 1–6 operate on `Grant` and `Policy` rows, but those **tables were dropped in migration 0027**. `fetchAuthz` (`packages/iam/src/fetch-authz.ts:243`) now returns empty `grants` and `policies` arrays, so in production only rule 7 (role grants via `role_grants` + `principal_role_assignments`), rule 7.5 (Owner), and rule 8 (default) can fire. The per-principal and per-workspace grant machinery the resolver was built for has no storage backing it.

The live IAM tables are (`packages/database/src/schema/iam.ts`, all in the `iam`/`org` schema): `principals`, `roles`, `role_grants`, `access_requests`, `principal_role_assignments`. JIT access is real — a `pending_approval` resolution creates an `access_requests` row via `createAccessRequest` (`packages/iam/src/access-request.ts`).

### 2.3 MCP server — scope yes, tool-level authz partial

`buildContext` (`apps/mcp/src/context.ts`) is the single auth entrypoint. It accepts **API keys only** (session tokens are rejected at the edge), derives `orgId`/`workspaceId`/`apiKeyId` solely from the validated credential (never from client headers), and fails closed on an empty scope. Each first-party MCP tool then calls `invoke(name, args, ctx, { surface: "mcp" })`, so it inherits the full kernel enforcement chain — including the same tier bypass.

Two gaps:

- **No per-key tool narrowing.** An API key carries org+workspace scope but no allowlist of *which tools* it may call. Every enabled capability is reachable by every key in the workspace.
- **Unauthorized tools are listed, not hidden.** The xmcp `tools/list` surface enumerates every registered tool; authorization is only checked on invocation. A least-privilege posture wants unauthorized tools **absent** from discovery, not merely erroring on call.

External (proxied) MCP tools *are* policy-checked: the agent runtime dispatches `mcp.<server>.<tool>` synthetic ids through `authorizeExternalCapability` (`packages/oxagen/src/kernel.ts`), which runs the same IAM gate without needing a registered contract.

### 2.4 Plugins / tools — a separate entitlement plane

Plugin/pack access is governed by an **entitlement service** (`packages/plugins/src/entitlements/entitlement-service.ts`), not the IAM grant model. The kernel's capability entitlement gate fires only for contracts *claimed by a plugin*; it queries `plugin.installed_plugins` (type `agent_capability`, `enabled=true`) for the exact `(orgId, workspaceId)`, with a 30s cache, and throws `capability_not_installed` when the pack is not entitled. Entitlement is **workspace-scoped** (ADR-013/014): installing a pack in one workspace does not entitle siblings.

This is a binary install/enable check with **no principal dimension**. Once a pack is installed, any principal who passes the capability's IAM check may use it — there is no "grant this plugin to the Billing role only."

### 2.5 The apps/app gap

`apps/app` does **not** bootstrap the IAM kernel runtime (CLAUDE.md gotcha) — `invoke()` from the app skips the IAM resolver. Server actions therefore gate **manually**. `resolveStudioScope` (`apps/app/src/lib/studio/scope.ts`) resolves session → org → workspace, asserts org membership, then reads `workspace_users.role` and exposes a boolean `canManage = role ∈ {owner, admin}`. Every Studio surface (Agents, Tools, Skills, Marketplace) hand-rolls this. This is a coarse, per-surface check that lives entirely outside the resolver and the audit trail.

---

## 3. Proposed model — a layered resource-grant plane

One model, four resource types, resolved through the **existing** 8-rule resolver and the **existing** `GrantEffect` vocabulary.

### 3.1 Principals (unchanged)

Principals already exist as first-class rows (`iam.principals`, `kind ∈ human | agent | service`), with `ResolvedPrincipal` threaded through the kernel. We reuse them verbatim:

- **Users** — carry org roles (`Owner | Admin | Compliance | Billing`) and workspace roles (`Owner | Member | Viewer`) via `principal_role_assignments`.
- **API keys** — resolve to their creator's principal today (`fetch-authz.ts`); the durable model is a dedicated **service principal per key**, so a key can be granted resources independently of its creator.
- **Agents** — already modelled as `kind: "agent"` service principals with a `parentUserId`; grants can target them directly (e.g. deny an agent the `deploy` skill).

### 3.2 Resources

A **resource** is anything a grant can target. We introduce a `resource_type` discriminator:

| `resource_type` | `resource_id` | Actions (examples) | Today |
|---|---|---|---|
| `capability` | contract name (`agent.deploy`) | invoke | Governed (role-grants only, tier-gated) |
| `skill` | `skl_…` public id | `load`, `edit`, `activate`, `enable` | **New** — no per-skill grants exist |
| `mcp_tool` | contract name / `mcp.<server>.<tool>` | `call`, `list` | Partial — scope only, no per-key allowlist |
| `plugin` | plugin id (`oxagen/media-svg`) | `use`, `install`, `enable` | Entitlement only, no principal dimension |

The `capability` row keeps back-compat with `role_grants.capability_id` — a capability grant is just a resource grant with `resource_type='capability'` and `resource_id = capability name`.

### 3.3 Grant shape — one new table, existing vocabulary

Rather than a bespoke ACL per level, add a single generalized grant table. It mirrors the resolver's existing `Grant` interface (`resolve.ts`) so the pure resolver needs no new decision logic — only a widened fetch.

```sql
-- iam.resource_grants
id            uuid pk            -- rsg_ public id
org_id        uuid not null
principal_type text not null      -- 'user' | 'api_key' | 'agent' | 'role'
principal_id  uuid not null       -- principal id, OR role id when principal_type='role'
resource_type text not null       -- 'capability' | 'skill' | 'mcp_tool' | 'plugin'
resource_id   text not null       -- contract name | skl_… | plugin id
action        text not null       -- 'invoke' | 'load' | 'edit' | 'activate' | 'call' | 'use' | '*'
scope_kind    text not null       -- 'org' | 'workspace'
scope_id      uuid not null
effect        text not null       -- 'allow' | 'deny' | 'require_approval'  (GrantEffect)
conditions    jsonb               -- evaluated by conditions.ts (time_window, ip_ranges)
expires_at    timestamptz         -- JIT / time-bounded grants
-- + auditMixin + softDeleteMixin
```

Notes:

- `principal_type='role'` collapses today's `role_grants` into the same table (a role-scoped grant), so we have **one** grant surface, not two. `role_grants` can be migrated in or kept as a compatibility view.
- `action='*'` means "all actions on this resource," letting a single row express "the Compliance role may do anything to the `pii-redaction` skill."
- `conditions` and `expires_at` come for free — the resolver already evaluates them.

### 3.4 Resolution order — compose with the 8 rules, don't replace them

Resource grants fold into the existing precedence. The key composition principle is **specificity + deny-bias**:

1. **`deny` > `require_approval` > `allow`** at equal specificity (already how rules 1–7 are ordered).
2. **Resource-specific beats capability-default.** A grant on `(skill, skl_x, load)` is more specific than the `agent.skill.load` contract's `defaultRoles`, so it wins.
3. **Principal-specific beats role-inherited beats default.** A direct user/agent grant outranks a role grant, which outranks `defaultEffect`.
4. **Workspace beats org for allows; org-enforced beats everything for denies** — unchanged from rules 1–4.

Concretely, `fetchAuthz` widens to also load matching `resource_grants` rows and maps them into the resolver's existing `Grant[]` (with `capabilityId` generalized to a `resourceKey = ${resource_type}:${resource_id}:${action}`). The resolver's rules 1, 3, 5, 6 already handle workspace/org allow/deny/approval on those `Grant` rows — **reviving the direct-grant path that migration 0027 left dead** (§2.2), now generalized to any resource. No new rules; the ordering that already exists is exactly the composition we want.

### 3.5 Enforcement points

| Level | Enforcement seam | Change |
|---|---|---|
| **Capabilities** | `kernel._invokeCore` IAM check | Widen `fetchAuthz` to load `resource_grants` (type `capability`). No kernel change. |
| **Plugins** | `kernel` entitlement gate (after billing) | Keep the install/enable check; **add** a principal-dimension `resource_grants` check (type `plugin`, action `use`) so a pack can be granted per-role even when installed workspace-wide. |
| **Skills** | `agent.skill.load` / `skill.*` handlers | Before load/edit/activate, resolve `(skill, skl_id, action)` through the resolver. This is the net-new surface. Skill enable/disable stays a workspace toggle; per-principal *access* becomes a grant. |
| **MCP** | `buildContext` + `tools/list` | (a) attach the key's grant set to the context; (b) **filter `tools/list`** to the authorized set so unauthorized tools are *hidden*, not just erroring; (c) per-key tool allowlists become `resource_grants` on the key's service principal. |
| **apps/app** | `resolveStudioScope` | Replace the hand-rolled `canManage` boolean with a shared `assertCapability(ctx, name, action)` helper backed by the resolver, and **bootstrap the IAM runtime in apps/app** so `invoke()` from server actions is gated identically to API/MCP. |

The MCP `tools/list` filtering is the highest-leverage least-privilege win: discovery becomes a function of authorization, so an agent that shouldn't see a tool literally cannot enumerate it.

---

## 4. Rollout plan (each phase independently shippable)

**Phase 0 — Fix the two capability defects (unblocks everything).**
- Decide the tier-bypass policy: either make the resolver run for all tiers with a cheap role-only fast path (recommended — governance is the wedge, not a paid add-on), or make the bypass explicit and documented. At minimum, stop equating "non-enterprise" with "no IAM."
- Reland grant storage as `resource_grants` (§3.3) so rules 1–6 have backing tables again. Migration in `packages/database/atlas/migrations/`; verify with a post-migrate `SELECT`.

**Phase 1 — Generalize the fetch + resolver mapping.**
- Widen `fetchAuthz` to read `resource_grants` and map to `Grant[]` keyed by `resourceKey`. Fold `role_grants` in via `principal_type='role'`. No resolver logic changes; add unit tests over the composition matrix.

**Phase 2 — apps/app parity.**
- Bootstrap IAM in apps/app; add `assertCapability` helper; migrate `resolveStudioScope.canManage` call sites onto it. Keeps the coarse behaviour as a default grant while making it resolver-backed and audited.

**Phase 3 — Skills as resources.**
- Add skill grant management UI + `skill.grant.*` capability(ies); enforce in `agent.skill.load` / `skill.edit` / `skill.version.activate` handlers. Default grants preserve today's behaviour (Owner/Admin/Member load) so nothing breaks on rollout.

**Phase 4 — MCP tool-level authz.**
- Attach grant set to `buildContext`; filter `tools/list`; add per-key allowlists. Ship behind a flag so existing keys default to "all tools" until an allowlist is set.

**Phase 5 — Plugin per-principal grants.**
- Extend the entitlement gate with the `plugin`/`use` resource check. Installed-but-not-granted becomes a distinct, explainable denial from not-installed.

Migration safety throughout: every phase's default grants reproduce current behaviour, so enabling a phase is a no-op until an admin authors a narrowing grant.

---

## 5. Risks & alternatives considered

- **ReBAC (OpenFGA / Zanzibar).** A relationship-graph authz service is the "correct" long-horizon answer for arbitrary resource hierarchies. Rejected *for now*: it adds a vendor/service dependency (against the vendor-neutrality moat), a second source of truth beside Postgres, and network latency on the hot `invoke()` path. Our resource set is small and flat (four types, fixed actions); the pure in-process resolver already handles it in zero I/O once data is pre-fetched. Revisit if resources gain deep hierarchy (folders, nested workspaces).
- **Policy-as-code (Cedar / OPA).** Expressive, but moves policy into a DSL the customer must learn and we must sandbox-evaluate. Our differentiator is *typed contracts*, not a policy language; a jsonb condition bag (`conditions.ts`) already covers time/IP, the only conditions in demand. Rejected as premature.
- **Extending the in-house model wins because** it reuses the resolver, the `GrantEffect` vocabulary, the condition evaluator, the audit pipeline, and the `iam` schema — the composition we need already exists in `resolve.ts`; we are mostly *feeding it data it was designed for* and widening the fetch. It also revives the dead direct-grant path (0027) as a side effect.
- **Risk: performance on the hot path.** `resource_grants` is read on every scoped invocation. Mitigate with the same batching `fetchAuthz` already does (parallel queries) and a short TTL cache keyed by `(principal, workspace)`, mirroring the entitlement service's 30s cache.
- **Risk: default-grant drift.** If Phase-N default grants don't exactly reproduce current behaviour, a rollout silently locks users out. Mitigate with a seed migration whose grants are asserted in tests against each contract's `defaultRoles`, and enforcement-off shadow logging (the kernel already supports would-deny logging) before flipping any phase to enforce.

---

## 6. Open questions

1. **Tier policy.** Should fine-grained resource grants remain an enterprise-tier feature (matching today's `canAccessACL`), or should *deny*/least-privilege be universal while the *matrix-authoring UI* is the paid surface? The vision argues governance is the wedge, not an upsell — leaning universal-enforcement, paid-authoring.
2. **API-key principals.** Do we finally cut over from creator-inheritance to a dedicated service principal per key (needed for per-key MCP allowlists to be meaningful)? This is a prerequisite for Phase 4.
3. **Action vocabulary.** Is a closed enum per resource type (`load|edit|activate` for skills) sufficient, or do we need free-form actions? Closed enums keep the UI and seed tractable; free-form invites drift.
4. **Grant authoring surface.** One unified "Access" admin UI across all four resource types, or per-surface (skills grants in Studio, key allowlists in Developer settings)? A unified surface best expresses the "Stripe-for-agents" governance story.
5. **`role_grants` migration.** Fold into `resource_grants` (`principal_type='role'`) outright, or keep as a compatibility view indefinitely? Folding is cleaner but touches the seed/provision path (`iam-provision.ts`).
6. **Agent self-grants.** When an agent spawns a subagent, should it be able to *delegate* a subset of its own grants, or only ever operate under statically-assigned ones? Delegation is powerful but expands the attack surface for prompt-injection privilege escalation.
