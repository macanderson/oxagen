# Agent RBAC — Design Specification

Status: **Proposed** - Author: platform - Date: 2026-07-07
Related: `docs/specs/iam/plan.md`, `docs/adr/ADR-009` (unified capability/tool model), `ADR-013` (capability packs / entitlements), `ADR-014` (workspace-scoped MCP registry), `ADR-019` (unified agent engine), `ADR-022` (capability naming), `packages/oxagen/src/agent-schema.ts`.

## 0. Recommendation (TL;DR)

**Make every deployed agent a first-class IAM principal and give it roles through the existing IAM spine — do not build a second permission system.** The substrate already exists end-to-end as _declaration_; what is missing is _enforcement at four seams_:

| Dimension                              | Declared today                                                                                           | Enforcement seam (exists, unwired)                                                                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capabilities / function tools          | `contract.defaultRoles`, `agent.riskLevel`, `iam.role_grants`                                            | `invoke()` kernel IAM (`packages/oxagen/src/kernel.ts`) resolving against the **agent principal**, plus the already-present-but-never-populated `allowlist: Set<string>` in `packages/agent/src/runtime/materialize-tools.ts` |
| Graph node labels + relationship types | `graphAccess.retrieval.scopeToTypes[]`, `graphAccess.budget` (declared, **zero enforcement references**) | `scopedSession` in `packages/ontology/src/tenant.ts` — the same chokepoint that already injects `orgId`/`workspaceId`                                                                                                         |
| MCP servers + tools                    | `agentTools[{type:"mcp_server"}]`, per-tool consents (`mcp.mcp_consents`)                                | the existing glob allow/deny/ask engine `packages/mcp-config/src/permissions.ts` + `serverAllowlist` in `apply-agent-binding.ts` (today additive-only)                                                                        |
| Skills / subagents                     | `agentTools[{type:"skill"\|"agent"}]`                                                                    | same binding path; intersection instead of union                                                                                                                                                                              |

Concretely: an **agent role** is an `iam.roles` row (scopeKind `workspace`) whose grants carry (a) the existing capability→effect map and (b) a new typed **resource-scope condition** for graph labels, relationship types, MCP server:tool globs, and skill slugs. Agents get roles via `iam.principal_role_assignments`. At run time the agent's effective permissions are **the intersection of its own grants and the invoking human's grants** — an agent can never exceed the human it acts for (the delegation ceiling), and a subagent can only narrow, never widen, its parent's scope.

This is wedge work, not plumbing: it completes the accountability chain — identity (principal) → knowledge scope (graph grants) → permitted action (capability grants) → commercial terms (billing meters already in `invoke()`) → verified outcome → audit record (ClickHouse IAM audit already emits from `checkIAM`).

## 1. Scope

In scope:

- Agent principals: provisioning, lifecycle binding to `agent.agents`, delegation ceiling.
- Agent roles: system defaults, custom roles, grants across four resource dimensions (capabilities, graph labels/relationship types, MCP servers/tools, skills/subagents).
- Enforcement at the four seams above, at **all org tiers** (see §3.4).
- Contracts + UI for assigning roles during agent creation/review (including the AI-assisted setup flow, which proposes a role).
- Audit + metering of denials and approval escalations.

Out of scope (deferred):

- Row-/node-level graph ACLs (per-node ownership). This spec stops at label + relationship-type granularity.
- Cross-org agent federation (A2A callers keep today's behavior; they hit the API-key scope first).
- Human JIT access-request UX changes (`iam.access_requests` reused as-is for `require_approval` grants).
- Retro-fitting the fixed filesystem tool set of code agents (`packages/agent-engine/src/tools.ts`) beyond an on/off capability grant (`agent.code.execute`); per-path sandbox policy is its own spec.

## 2. Goals and acceptance criteria

1. Every non-managed agent has exactly one `iam.principals` row (`kind='agent'`, `parentUserId` = creator) created at `agent.definition.create` and soft-deleted with the agent.
2. An agent with no role assignment behaves exactly as today (back-compat default role, see §3.2) — zero behavior change until a role is attached.
3. A capability call from an agent run resolves IAM against the agent principal ∩ invoking-user principal; a `deny` blocks the tool at materialization AND at `invoke()`; `require_approval` routes through the existing consent/approval flow.
4. A graph query issued by an agent whose role scopes labels/relationship types never returns a node/edge outside that scope, and never exceeds the role's traversal budget — enforced inside `scopedSession`, not in callers.
5. An agent may reach only MCP servers/tools its role's glob rules allow; `ask` rules reuse the first-use consent flow.
6. All four dimensions emit the existing IAM audit events to ClickHouse with `principal_kind='agent'` and run lineage (`runId`, `parentRunId`).
7. Subagent dispatch (`agent.subagent.dispatch`) intersects the child's role with the parent run's effective scope — narrowing only.
8. Coverage thresholds hold; every new contract ships API + MCP parity and docs per the capability-parity rule.

## 3. Architectural decisions

### 3.1 Agents are principals, not users-with-flags

`iam.principals` was built for this (`kind IN human|agent|service`, `parentUserId`). Decision: **one principal per agent identity** (not per version, not per run). Versions change config; identity and role assignments persist. Runs carry the principal in `AuthzContext` alongside the human principal.

Rejected alternative — per-run principals: explodes the principal table, breaks role-assignment UX, and lineage already lives in run records.

### 3.2 Roles, defaults, and the back-compat role

Reuse `iam.roles` + `iam.role_grants` + `iam.principal_role_assignments` unchanged for capability grants. Add four **system default agent roles**, seeded by `seed-iam-defaults.ts`:

| Role                          | Intent             | Capability posture                                                            | Graph posture                                                            | MCP posture                          |
| ----------------------------- | ------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------ |
| `Agent Observer`              | read/answer only   | `category in {read, introspection, graph, memory}` allow; mutations deny      | labels/rels: as-configured, `mode=read` forced                           | deny all                             |
| `Agent Contributor`           | standard worker    | reads allow; `riskLevel=low\|medium` mutations allow; `high` require_approval | as-configured                                                            | allow listed servers, `ask` per tool |
| `Agent Operator`              | trusted automation | Contributor + `high` allow except `category=vcs`/billing/security             | as-configured incl. `extend`                                             | allow listed servers/tools           |
| `Agent Legacy (unrestricted)` | back-compat        | mirror of today's behavior: everything the **invoking user** may do           | unenforced scopes ignored → enforced as declared (§4 Phase 3 flips this) | today's additive behavior            |

`Agent Legacy` is auto-assigned to existing agents by backfill so shipping enforcement changes nothing until a workspace opts an agent into a real role. New agents created after Phase 1 default to `Agent Contributor`.

### 3.3 Resource scopes ride on grants as typed conditions

`iam.role_grants` today maps role → capability → effect, with a `conditions` seam (`time_window`, `ip_ranges`). Extend conditions with a typed `resource_scope` payload (zod-validated in `packages/oxagen/src/iam/conditions.ts`):

```ts
resourceScope: {
  graph?: {
    labels?: string[];            // node labels the agent may touch; empty/undefined = all
    relationshipTypes?: string[]; // edge types; empty/undefined = all
    mode?: "read" | "extend";     // ceiling; agent config may narrow, never widen
    budget?: { maxHops?: number; maxNodes?: number; maxTraversalMs?: number }; // ceilings
  };
  mcp?: { rules: Array<{ pattern: string; effect: "allow" | "deny" | "ask" }> }; // "server:tool" globs, first-match-wins — same engine as packages/mcp-config/src/permissions.ts
  skills?: { slugs?: string[] };  // loadable skill slugs; undefined = all enabled workspace skills
  agents?: { refs?: string[] };   // dispatchable subagent slugs/ids; undefined = none beyond config
}
```

**Relationship between role scope and per-agent config:** the role is the _ceiling_, the agent definition (`graphAccess`, `agentTools`) is the _request_. Effective scope = intersection. This keeps `agent-schema.ts` untouched and preserves the existing builder UX — the role becomes a governance layer over it, exactly like the schema comment already promises for subagents ("inherits and may narrow, never widen").

### 3.4 Enforcement runs at every tier — this is not enterprise ACL

`checkIAM` short-circuits to unconditional allow for non-enterprise orgs (`canAccessACL(tier)`). Decision: **agent-principal resolution bypasses that fast-path.** Rationale: agent RBAC is a core product safety property (an agent is an unattended automation; a human clicking a button is not), and it is the wedge's "governed" claim. Tier gating applies only to _custom_ agent roles: non-enterprise orgs get the four system roles; custom role authoring stays enterprise. Implementation: `checkIAM` takes `principalKind`; the fast-path applies only when `principalKind='human'`.

### 3.5 Deny wins, and the two-layer gate stays

Materialize-tools filtering is UX (the model never sees a tool it can't call); `invoke()` kernel resolution is the real gate (defense against prompt-injected direct capability names, exactly the "un-poisonable" property from `docs/VISION.md`). Both layers read one resolution, computed once per run and cached on the run context — not two divergent policies.

### 3.6 Graph enforcement lives in `scopedSession`

`packages/ontology/src/tenant.ts` is the single chokepoint every graph query already passes through (it injects `$orgId`/`$workspaceId` and rejects non-scoped Cypher). Extend it to accept an optional `GraphScope` (labels, relationshipTypes, budget) resolved from the run context:

- Traversal capabilities (`ontology.neighbors`, `ontology.query`, `semantic.*`) get scope predicates injected as Cypher `WHERE` clauses / APOC label filters and budget clamps (LIMIT, hop caps) — enforced server-side, not by prompt.
- Same seam-bypass guard style as tenancy: a query from an agent-scoped session that doesn't carry the scope markers throws, so a new query path cannot silently skip the filter.
- `mode=read` scope rejects write clauses (reuse the existing read/extend distinction at the capability layer: `graph_write`-category capabilities simply resolve to deny).

### 3.7 MCP reuses the glob engine

Do not invent a second matcher. `evaluatePermission(serverName, toolName, rules)` from `packages/mcp-config/src/permissions.ts` moves (or is re-exported) to a shared package and evaluates the role's `mcp.rules` at two points: `applyAgentBinding` (server allowlist becomes an intersection, fixing today's additive-only widening) and per-tool-call in the MCP tool bridge (`ask` → existing `mcp_consents` first-use consent flow, with the **agent principal** recorded as the consent subject).

## 4. Phase ordering and dependencies

Phases land independently, each behind its own flag, each with back-compat defaults. Order: 1 → 2 → (3 ∥ 4) → 5.

### Phase 1 — Agent principals + role spine

Scope: provision principal on `agent.definition.create` (backfill script for existing agents → `Agent Legacy`); seed four system roles; `resource_scope` condition type + resolver support (resolution only, no enforcement); contracts `agent.role.assign`, `agent.role.revoke`, `agent.role.list`, `agent.role.get` (API+MCP parity, docs); audit events carry `principal_kind`.
Acceptance: principals exist for all live agents; assigning/revoking roles round-trips; resolver unit tests cover intersection + delegation ceiling; zero runtime behavior change.
Risks: principal backfill on shared local DB (verify with SELECT, not logs). Rollback: roles unassigned → `Agent Legacy` semantics; principal rows are inert.

### Phase 2 — Capability enforcement (tools + kernel)

Scope: run context carries resolved agent grants; `materializeTools.allowlist` populated restrictively; kernel `invoke()` resolves agent principal (∩ user) when `ctx.principalKind='agent'`, bypassing the tier fast-path per §3.4; `require_approval` routes to the existing approval flow (`agent.approval.resolve`).
Acceptance: an `Agent Observer` cannot call a mutation capability even when named directly in a poisoned prompt (kernel-level test); legacy-role agents unchanged; denial audit rows in ClickHouse.
Risks: latency — one resolution per run, cached; fast-path change is `principalKind`-guarded so human traffic is untouched. Rollback: flag off → allowlist never populated, kernel skips agent resolution.

### Phase 3 — Graph scope enforcement

Scope: `GraphScope` support in `scopedSession` + predicate/budget injection in `ontology.*` / `semantic.*` query builders; effective scope = role ceiling ∩ `graphAccess` declaration (finally enforcing `scopeToTypes` and `budget`); subagent narrowing on dispatch.
Acceptance: integration test against live Neo4j proving out-of-scope labels/rel-types never return; budget clamps observable; `Agent Legacy` + humans unaffected.
Risks: Cypher predicate injection must not break existing query plans — measure; label filters interact with vector-index entry points (filter post-ANN with oversampling, per the known ANN pattern). Rollback: scope param optional; flag off restores pass-through.

### Phase 4 — MCP + skills enforcement

Scope: shared glob engine; role `mcp.rules` evaluated in `applyAgentBinding` (intersection) and per-call (`ask` → consent with agent principal); `skills.slugs` filter on skill index + `agent.skill.load`; `agents.refs` filter on `agent.subagent.dispatch`.
Acceptance: e2e — agent with `deny github:*` cannot see or call those tools; consent rows record the agent principal; skill index in the system prompt excludes unauthorized slugs.
Risks: consent UX confusion between user- and agent-scoped consents — label clearly. Rollback: flag off → today's additive union.

### Phase 5 — Surfaces: builder, review, AI-assisted setup

Scope: role picker in the agent builder (create + edit) with the four system roles + custom (enterprise); the review step renders effective scope (role ∩ config) as the single accountability view; `agent.definition.suggest` proposes the narrowest adequate role (`suggestedRole` output field, additive change) and the create flow assigns it on draft save; `docs/capabilities/` + user docs.
Acceptance: e2e with screenshots — describe → generate → review shows proposed role → save draft → agent lists with role badge; non-managers cannot assign roles above their own grants (delegation ceiling in UI and contract).
Risks: none structural. Rollback: UI hides picker; drafts default to `Agent Contributor`.

## 5. Observability & billing

- Every resolution outcome (allow/deny/approval) emits the existing IAM audit event with `principal_kind`, `agent_id`, `run_id`, capability, and dimension — queryable per agent for compliance reviews (`security/audit` surface).
- Denials and approval escalations are meterable events (ClickHouse), feeding the usage→billing loop: governed calls are billable calls.
- `agent.trace.get` spans annotate scope-filtered graph queries (`graph_query` log entries gain `scopeApplied: true`).

## 6. Open questions

1-Question: Should `Agent Legacy` be time-boxed (auto-migrate to `Agent Contributor` after N releases)? Recommend yes,
  with a workspace-level override.
1-Answer: No - we need to simply reset the entire system before going live we have no customers so we don't need
  to do backwards compatibility work - build the feature as if it all should work and we will address any data issues between here and launch as one offs.
2-Question: Do A2A inbound tasks (`/a2a`) map to the target agent's principal alone, or intersect with the caller's API-key scope?
2-Answer: Intersect to be consistent with the delegation.
3-Question: Graph scope for `extend` proposals: are proposed nodes/edges validated against the label allowlist at proposal time or approval time?
3-Answer: fail fast, verify on approve - also make sure to verify the properties as well somehow we need to make it possible for
          agents building inferred nodes and edges to make sure they try and populate all the properties/the complete schema.

## Changelog

- 2026-07-07 — Initial proposal (recommendation + four-seam design + five phases).
