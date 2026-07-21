# Enterprise Agent IAM and Graph Context Permissions

- **Status:** Design approved; written specification awaiting final review
- **Date:** 2026-07-21
- **Owner:** Platform
- **Canonical scope:** Agent identity, RBAC, graph context authorization, tool authorization, administration UI, and audit evidence
- **Supersedes:** The 2026-07-07 contents of this file and the agent-specific decisions in `docs/specs/rbac-permissions-plane.md`
- **Related:** `docs/VISION.md`, `docs/adr/ADR-009-unified-capability-tool-model.md`, `docs/adr/ADR-033-stella-engine-core.md`, `docs/specs/adaptive-context/spec.md`, `docs/specs/workspace-schema-registry/spec.md`, `packages/oxagen/src/agent-schema.ts`

## 0. Decision

Oxagen will ship one IAM control plane in which humans, agents, and service
accounts are sibling principals. Administrators assign versioned roles to those
principals. Roles may authorize:

1. Neo4j node labels;
2. Neo4j relationship types;
3. Oxagen capabilities;
4. individual MCP tools;
5. skills; and
6. dispatchable agents.

The initial graph permission boundary is **node label plus relationship type**.
There is no customer-authored property-level IAM matrix in v1. This is a
deliberate product decision, not an unfinished implementation.

Oxagen remains the enforcement host when the TypeScript agent loop is replaced
by Stella's Rust package. The IAM resolver, capability kernel, context broker,
and audit pipeline are the policy enforcement points. Stella receives only
authorized context and authorized callable ports. Context Graph Protocol (CGP)
objects may request or describe context, but they never grant access.

The sellable outcome is an administrator being able to answer, with evidence:

> Who initiated this work, which agent acted, what knowledge could it retrieve,
> which tools could it invoke, which policy version allowed it, and what happened?

## 1. Scope

### 1.1 In scope

- First-class IAM principals for humans, agents, and service accounts; API keys
  are credentials bound to an explicit principal.
- Versioned, custom RBAC roles assignable through one unified principal picker.
- Resource grants for node labels, relationship types, capabilities, MCP tools,
  skills, and agent dispatch.
- Delegation ceilings for human-to-agent, service-to-agent, A2A, and subagent
  execution.
- Enforcement before graph candidate selection and at every tool invocation.
- A new `/{orgSlug}/governance/permissions` administration surface.
- Effective-access simulation using the production resolver.
- Immutable policy-change and authorization-decision evidence.
- Access-review and signed-export coverage for all principal kinds.
- Deployment and runtime behavior that fails closed when authorization cannot be
  established.

### 1.2 Explicitly deferred

- Customer-authored property-level allow/deny rules.
- Per-node or row-level ownership ACLs.
- Relationship-based authorization engines such as OpenFGA/Zanzibar.
- A customer-facing policy language such as Cedar or Rego.
- Role inheritance. The existing `roles.parentRoleId` is not used by v1.
- Direct per-principal grants. Principals receive access through roles only.
- AI-authored roles or policies. The v1 editor is fully manual.
- A filesystem path-policy matrix for code-agent sandbox tools.
- Cross-organization federation beyond intersecting the inbound service
  principal with the target agent.

### 1.3 Property handling in v1

A node-label grant authorizes the contract-defined, context-safe projection of
that node. A relationship-type grant does the same for the relationship.
Reserved operational values such as tenant keys, raw embeddings, and internal
storage metadata are excluded by the graph contracts for every principal; that
is output-schema hygiene, not property IAM.

All customer-domain properties in the context-safe projection are visible when
their node label or relationship type is authorized. If a value requires a
different audience, it must be modeled as a separately protected node,
relationship, sealed document, or secret-store resource. The UI must not imply
that post-retrieval field stripping provides property authorization.

If property IAM is added later, it requires a separate approved specification.
It must exclude denied properties before predicate evaluation, candidate
selection, ranking, embeddings, hydration, citations, exports, replay, and logs.
"Retrieve and then strip" is prohibited.

## 2. Non-negotiable security invariants

1. **Default deny for agents and services.** An agent or service without an
   applicable role grant receives no graph resource and no tool.
2. **Deny wins.** Within a principal's assigned roles, an applicable deny beats
   approval and allow. Approval beats allow.
3. **Delegation narrows.** Effective authority is the intersection of every
   principal and requested configuration in the delegation chain. It is never a
   union.
4. **Discovery is not enforcement.** Denied tools are absent from discovery, and
   the kernel independently rechecks each invocation.
5. **Retrieval authorization precedes retrieval.** Unauthorized graph resources
   cannot participate in filtering, candidate generation, ranking, traversal,
   prompt construction, citation generation, exports, caches, or replay.
6. **Current policy is authoritative.** Durable enqueue, materialization, or an
   earlier allow decision cannot survive a later revocation. Newly granted
   authority also cannot silently widen an in-flight run beyond its admission
   snapshot.
7. **Missing policy fails closed.** Production startup fails when IAM is not
   bootstrapped. A policy lookup failure denies; it never selects a legacy or
   unfiltered fallback.
8. **Availability failure does not widen access.** An already-authorized
   retriever may degrade to an empty result when unavailable. Authorization
   failure terminates the operation.
9. **Agent configuration requests access; it does not grant it.** Agent tool and
   graph declarations are always bounded by IAM.
10. **Protocol declarations do not grant authority.** Imported CGP frames,
    manifests, and A2A payloads are intersected with host authority.
11. **Policy decisions are attributable.** Every decision carries the initiator,
    actor, delegation chain, scope, policy version, and request/run identifiers.
12. **No self-escalation.** Agents cannot author roles, assign themselves roles,
    approve their own access, or delegate authority they do not possess.

## 3. Architecture and trust boundaries

```text
Authenticated surface / durable-run admission
  -> resolve initiating principal and acting agent
  -> resolve effective authority and persist an authorization reference
  -> construct AuthorizedRunPorts
       ContextRecallPort  -> Oxagen context broker -> Neo4j/context providers
       GraphMutationPort  -> schema-validated proposal/approval/commit
       ToolExecutor       -> Oxagen capability kernel invoke()
       SkillLoaderPort    -> kernel-authorized skill content/provenance
       SandboxPort        -> capability-gated filesystem/command/network policy
       AgentDispatchPort  -> attenuated child authority
  -> Stella engine loop (TypeScript today, Rust later)
  -> audit/evidence projection
```

### 3.1 Policy decision point

The IAM resolver is the policy decision point (PDP). It returns a typed decision:

```ts
type AuthorizationDecision = {
  decisionId: string;
  outcome: "allow" | "deny" | "require_approval";
  policyVersion: string; // decimal form of the org-wide monotonic counter
  effectiveScopeHash: string;
  validUntil: string;
  reasonCode: string;
  trace: DecisionTrace;
};
```

There is one monotonic authorization policy counter per organization. Any role,
grant, assignment, principal, delegation, approval, credential-binding, or
relevant catalog change increments it, including workspace-scoped changes. The
broader invalidation is intentional: one unambiguous counter is safer than an
underspecified org/workspace version vector.

`validUntil` is the earliest expiry across assignments, delegation, approval,
credential, and admission snapshot. A cache entry cannot live beyond it even
when the policy counter has not changed.

The trace is available to administrators and audit systems. It is never inserted
into a model-visible prompt.

### 3.2 Policy enforcement points

- **Capability kernel:** reauthorizes every built-in capability invocation.
- **External MCP bridge:** reauthorizes every proxied server/tool invocation.
- **Context broker:** authorizes every lexical, semantic, vector, graph,
  memory, pinned-context, citation, and export retrieval.
- **Graph mutation adapter:** requires capability authorization plus per-label,
  per-relationship, and endpoint authorization for every write stage.
- **Dispatch adapter:** derives an attenuated child authorization envelope.
- **Sandbox adapter:** gates command, filesystem, network, and secret-broker
  requests before they reach a sandbox driver, and fences persistent sessions
  when their authority changes.
- **Skill loader:** reauthorizes the skill resource immediately before its
  content is assembled into a prompt.
- **Policy mutation handlers:** enforce who may create, publish, assign, revoke,
  restore, approve, and export policy state.

The UI, agent builder, tool materializer, and schema descriptions are policy
administration or policy-information points. They do not become enforcement
boundaries.

### 3.3 Engine and CGP boundary

Stella receives opaque authorized ports and context results, not role rows,
grant manifests, Cypher strings, or a policy evaluator. An engine swap therefore
cannot weaken enforcement.

CGP remains provider-neutral. Oxagen may attach non-model-visible metadata such
as `decisionId`, `policyVersion`, `effectiveScopeHash`, issuer, and disclosure
summary to a compiled context manifest. It must not serialize Oxagen role names,
forbidden values, credentials, or grant logic into a context frame.

For authorization, Oxagen derives a frame's graph resources from host-owned
provider registration and stored ingestion provenance. A frame's self-declared
label, type, or sharing scope is non-authoritative. Unclassifiable or conflicting
provider provenance denies the frame.

An external context provider is eligible for `ContextRecallPort` only when it
accepts the authority-qualified label/type scope and applies that scope before
filtering, candidate generation, ranking, or hydration. The provider returns an
attested decision reference bound to the request, effective-scope hash, catalog
version, and result. Host-side provenance validation remains mandatory but is a
secondary check, not permission to post-filter a globally ranked result. A
provider that cannot prove pre-retrieval enforcement fails closed; Oxagen may
instead query a host-controlled corpus already partitioned by authorized
resources.

## 4. Principal identity and delegation

### 4.1 Unified principal binding

`iam.principals` remains the identity spine, with these binding semantics:

```text
kind=human   subject_id=auth.users.id
kind=agent   subject_id=agent.agents.id
kind=service subject_id=iam.service_accounts.id
```

Add `subject_id uuid NOT NULL` and enforce:

```text
UNIQUE (org_id, kind, subject_id)
```

`parent_user_id` is removed from principal identity. It currently identifies a
human principal and has a uniqueness constraint that would collide when one
human creates multiple agents. Agent ownership remains agent-domain metadata;
ownership does not confer runtime authority. `idp_subject` remains optional
external identity metadata for human principals.

An agent receives exactly one principal for its stable agent identity, not one
per version or run. A service account receives one stable service principal.
API keys are rotatable credentials whose records carry an explicit
`principal_id`; rotation or multiple active keys do not create additional
principals. Credentials authenticate a human or service principal but are not
themselves authority and never silently inherit the creator's access.

Principal suspension or deletion invalidates all active decisions immediately.
Draft agents may exist without a role, but deployment is blocked until the agent
has at least one active workspace role. Agent creation and principal creation are
one transaction. Agent archive/delete and service-account suspension update the
bound principal's status and policy version in the same transaction. Revoking an
API key invalidates only that credential and snapshots admitted through it,
increments the policy version, and leaves the service principal and sibling keys
active.

Human org-membership removal/suspension and service-account suspend/delete are
source-of-truth lifecycle hooks: they update principal status, revoke invalid
assignments/delegations, and increment policy version transactionally. Every
subject binding validates same-org and compatible-workspace ownership, prevents
orphans, and enforces the principal kind expected by its source record.

### 4.2 Durable authorization context

Introduce `RunSpecV2`. Identity fields are derived by authenticated server code,
never accepted from caller-supplied JSON:

```ts
type RunAuthorityV1 = {
  initiatingPrincipalId: string;
  actingPrincipalId: string;
  actingAgentId: string;
  actingAgentVersionId: string;
  actingAgentVersionHash: string;
  principalChainIds: string[];
  delegationId: string;
  delegationChainIds: string[];
  admissionDecisionId: string;
  authorizationSnapshotId: string;
  authorizationSnapshotHash: string;
  policyVersionAtEnqueue: string;
  requestedScopeHash: string;
  credentialId?: string;
  scope:
    | { kind: "org"; orgId: string }
    | { kind: "workspace"; orgId: string; workspaceId: string };
};
```

The run record stores this authority reference and its lineage. Grant rows are
not copied into caller-controlled `RunSpecV2`. Admission creates an immutable,
server-owned authorization snapshot containing the principal chain, resource
ceilings, graph budget, applicable assignment/grant revisions, expiry, and
canonical hash. A worker resolves:

```text
admission snapshot ceiling INTERSECT current authorization
```

when claiming/resuming a run, before every context request, before every tool
invocation, and before every child dispatch. A suspended principal, revoked
assignment, or newer deny therefore stops a queued or resumed run, while a new
allow does not widen work already in flight.

The admission snapshot includes the resolved agent-definition version and tool/
graph request. Execution also loads the current active agent definition and
intersects it with that admission ceiling. Removing a binding or requested graph
resource narrows an in-flight run; publishing a new allow cannot widen it.
Access-relevant agent-definition publication increments the org policy version.

Admission atomically persists the ordered delegation records, immutable
authorization snapshot, run row with foreign keys to both, and audit-outbox
event. Partial admission is impossible. The acting principal must be
`kind=agent`, and its `subject_id` must equal `actingAgentId`. The first
`principalChainIds` member is the initiator, the last is the actor, the leaf
`delegationChainIds` member equals `delegationId`, and every delegation row
connects adjacent principals in order.

Durable enqueue is admitted through a typed kernel capability; `RunStore`
remains an internal persistence adapter and is not called directly by an HTTP
surface. Interactive chat and A2A resolve the acting agent principal before tool
materialization, not merely after the run for lineage display.

`CapabilityContext` and tenant attribution distinguish:

- initiating principal;
- acting principal;
- originating human user when present;
- acting agent;
- delegation chain;
- run and parent-run identifiers; and
- authorization decision and policy version.

Authorization scope is always the discriminated org/workspace union shown
above. An org decision has no `workspaceId`; a workspace decision requires one.
Zero UUIDs, empty strings, truthiness tests, and synthetic principals are
prohibited as scope or attribution sentinels.

### 4.3 Delegation rules

`iam.principal_delegations` records each authorized act-as relationship with
delegator, delegate, org/workspace scope, purpose (`interactive`, `scheduled`,
`a2a`, or `subagent`), status, validity window, optional parent delegation, and
run id. It is established by authenticated host code after dispatch permission
is resolved. It records and constrains delegation; it never copies grants.

Delegator and delegate must differ, share an organization, have compatible
workspace scope, and form an acyclic chain. Missing, expired, suspended, or
revoked delegation fails closed.

- Human-to-agent: human effective authority intersects agent authority.
- Service-to-agent: service effective authority intersects agent authority.
- Scheduled agent: a deployment service principal intersects agent authority;
  the creator is never used implicitly.
- A2A: the inbound credential authenticates a service principal projected into
  the target organization; foreign-org principal ids are denied. That local
  service principal intersects the target agent.
- Subagent: current effective envelope intersects the child agent.
- Per-run restrictions and request filters may narrow the result again.
- Approval cannot expand authority beyond any other member of the chain.

Dispatch authorization uses the structured tuple
`{ resourceKind: "agent", resourceId: <stable agent public id>, action: "dispatch" }`.
Composite-string aliases are prohibited.
The runtime delegation chain is persisted on the run and audit events; it is not
inferred from agent ownership.

## 5. Role and resource-grant model

### 5.1 Role behavior

- System roles remain immutable.
- Custom roles are scoped immutably to an organization or one workspace. Scope
  cannot be edited after creation; changing scope clones a new role.
- The role creator may start from an Observer, Contributor, or Operator template,
  but applying a template creates an ordinary explicit custom role. Templates do
  not contain future-resource wildcards.
- The published role version declares eligible principal kinds so a human-only
  Owner role cannot be assigned to an agent. Changing eligibility requires the
  normal draft/review/publish transaction.
- Principals may hold multiple roles.
- Assignments may expire and are soft-revocable.
- JIT and break-glass access use time-bounded role assignments with a reason.
- A break-glass role is human-only, cannot be delegated, notifies security
  administrators, and is included in every access review.
- Direct principal grants and role inheritance are not supported in v1.

The human system Owner is protected as the organization-management root role,
but receives explicit system grants rather than a synthetic allow for every
resource. Data-plane graph and tool access remains reviewable. Owner authority
cannot be assigned to or inherited by agents; emergency data access uses the
audited break-glass path.

### 5.2 Versioned policy state

Role identity and active policy content are separated:

- `iam.roles` owns stable role identity, nullable `workspace_id`, and
  `active_version_id`. Org roles require `workspace_id IS NULL`; workspace roles
  require a workspace id. Live role names are unique within their exact scope.
- `iam.role_versions` stores one resumable draft and immutable published
  versions, including org/workspace scope, reason, author principal, version
  number, eligible principal kinds, delegable/non-delegable posture, graph
  budget ceiling, manifest hash, and time.
- `iam.resource_grants` stores normalized grants for a role version with the same
  denormalized org/workspace keys so RLS and tenant queries remain explicit.
- `iam.principal_role_assignments` continues to bind principals to stable roles.
  Its assignment scope must equal the role scope, and `assigned_by` becomes an
  acting-principal reference rather than a human-user assumption.
- `iam.policy_versions` stores one current monotonic policy version per org.
- `iam.authorization_snapshots` stores immutable admission ceilings and hashes.

Publishing is one transaction: validate draft, persist the immutable version,
switch `active_version_id`, increment the org policy version, write the
audit outbox event, and invalidate caches. A version mismatch returns a typed
conflict and preserves the administrator's draft.

Publication rejects an eligible-principal-kind change while incompatible active
assignments exist and returns the affected principals. Runtime resolution also
validates each assignment against the active role version and denies any
inconsistent row; database drift cannot become authority.

Database checks/composite references enforce that role, active version, resource
grants, and assignments share the same org/workspace scope. Active-assignment
uniqueness ignores soft-revoked rows, so reassigning a previously revoked role is
possible without reviving historical audit rows.

Restoring an older role version creates and publishes a new version; historical
records are never made mutable.

Archiving a role atomically marks it inactive, soft-revokes its active
assignments, increments policy version, invalidates caches, and writes the audit
outbox event. The resolver excludes archived roles immediately while retaining
role and assignment history for evidence. Restoring the role identity does not
reactivate old assignments; administrators must assign it again explicitly.

### 5.3 Resource taxonomy

| Resource kind | Canonical resource id | Actions |
|---|---|---|
| `graph_node_label` | canonical Neo4j domain label, e.g. `Customer` | `read`, `extend` |
| `graph_relationship_type` | canonical Neo4j type, e.g. `OWNS_ACCOUNT` | `traverse`, `extend` |
| `capability` | canonical verb-first capability name | `invoke` |
| `mcp_tool` | stable server id plus tool name | `call` |
| `skill` | stable skill public id | `load` |
| `agent` | stable agent public id | `dispatch` |

Every grant contains `resourceKind`, `resourceId`, `action`, and `effect`, where
effect is `allow`, `deny`, or `require_approval`. Matching is exact in v1.
Bulk-selecting all current resources writes explicit grants; it does not create a
future wildcard. Newly registered labels, relationship types, tools, skills,
capabilities, and agents therefore default to denied.

Resource kind metadata declares valid scope kinds. Graph labels, relationship
types, MCP tools, skills, and agent dispatch are workspace-only. Capabilities
declare org, workspace, or both in contract metadata. Draft validation,
publication, and runtime resolution all reject a grant in an invalid scope; an
org role can never grant `Customer:read` across every workspace.

Capability entitlements remain a separate commercial/installability gate.
Effective access is:

```text
installed and entitled
  INTERSECT IAM role authority
  INTERSECT initiating principal authority
  INTERSECT acting agent authority
  INTERSECT agent-definition request
  INTERSECT per-run restrictions
```

Entitlement or installation never grants IAM authority.

### 5.4 Resolution algorithm

For each principal in the chain:

1. Reject an inactive, suspended, deleted, cross-org, or cross-workspace
   principal.
2. For an org decision, load active org assignments only. For a workspace
   decision, load active org assignments plus assignments for that exact
   workspace. Aggregate denies across both.
3. When authority crosses an act-as edge, exclude non-delegable roles/grants
   from the upstream principal's transferable authority.
4. Match grants by exact resource kind, resource id, and action.
5. If any matching role denies, resolve deny.
6. Otherwise, if any matching role requires approval, resolve approval.
7. Otherwise, if at least one matching role allows, resolve allow.
8. Otherwise, resolve deny.

Expiry evaluation uses the resolver's supplied clock; resolver tests never
depend on an internal `new Date()` call. V1 has no undeclared grant-condition
language: time-bounding is expressed through assignment, delegation, snapshot,
credential, and approval expiry.

Then intersect every principal result and every requested ceiling:

```text
any deny or missing grant -> deny
else any approval          -> require_approval
else                       -> allow
```

Roles are additive only within one principal: matching allows union, then any
matching deny removes the resource and any approval upgrades an allow to
approval-required. The resulting per-principal sets—not raw role sets—intersect
across the principal chain, admission snapshot, agent request, and run filters.

This replaces the current role path in `resolve.ts`, where an allow may be
selected before a deny from another assigned role. The same pure resolver powers
the kernel, context broker, simulator, and tests.

### 5.5 Approval semantics

`require_approval` creates a durable IAM access request for the exact principal
chain, resource, action, workspace, run/request, canonical input hash, and policy
version. Requests have one of two kinds:

- **Exact execution:** approval creates an `iam.approval_authorizations` row
  bound to request and decision ids, principal-chain hash, scope,
  resource/action, canonical input or graph-plan hash, run/step, policy version,
  approver, expiry, and revoked/consumed timestamps. The opaque reference is
  atomically consumed once with the authorized invocation; replay fails.
- **Temporary access:** approval creates an ordinary time-bounded role
  assignment through the assignment contract. JIT and break-glass access use
  this path and do not produce a reusable bearer token.

Invocation still intersects approval with the admission snapshot and current
policy; an approval cannot override a newer deny, expired delegation, revoked
credential, or principal suspension. Revocation increments policy version.
An exact-execution approval and its final execution decision are never cached or
reused. After final normalization, each invocation atomically claims the
single-use authorization with its execution obligation; a cache may supply only
the pure role/delegation predecision. An idempotent handler retry resumes the
same obligation and cannot consume the approval for a different input or step.

The approved hash and the final policy-enforcement decision bind the exact
post-hook, post-normalization input or graph plan that will execute. Mutating
host hooks must run before canonicalization and approval. After the final
enforcement point, hooks are observe-only; any attempted mutation invalidates
the decision and restarts normalization, approval, and authorization. No engine
or adapter may alter an authorized command, query plan, tool input, dispatch
target, or context request on the way to execution.

If one graph plan touches any approval-required label or relationship, the whole
normalized plan pauses. Approval binds to the complete plan hash; the broker
does not return a partially approved subgraph under that request.

`iam.access_requests` must be generalized beyond its current capability-only
shape. Existing agent execution approval records are not themselves IAM grants.
The product may show both in one approvals inbox, but resolving a model/tool
confirmation cannot bypass the IAM access-request state machine. An actor cannot
approve their own privileged request when separation-of-duties is enabled.

## 6. Graph context authorization

### 6.1 Canonical graph resource catalog

The pinned Workspace Schema Registry is the administration catalog for domain
node labels and relationship types. A host-owned `GraphResourceCatalog` maps
current physical forms—Neo4j domain labels, `GraphNode.label`, and compatibility
`EntityNode.entityType`—to canonical resources under one pinned ontology/schema
version. Conflicting mappings or any unknown extra domain label deny the whole
node. Authorization never chooses the most permissive interpretation.

The UI groups resources by schema, while grants use the canonical Neo4j label or
relationship-type name. A rename is a new resource and defaults to denied;
publishing a schema rename reports affected roles, increments the org policy
version, and invalidates catalog-bound decisions.

Structural labels such as `GraphNode` and compatibility labels such as
`EntityNode` are not customer grant targets. Platform domain labels that may be
retrieved, such as `Execution` or `AgentMemory`, appear explicitly in the
catalog. A node with no recognized domain label is denied to agents.

For nodes carrying multiple domain labels, every recognized domain label must be
allowed. This prevents a broad label from exposing a node that also carries a
restricted label. A relationship is visible only when:

1. its relationship type is allowed;
2. its start node is visible; and
3. its end node is visible.

### 6.2 Agent graph request

Replace the ambiguous `graph.retrieval.scopeToTypes` declaration with separate
requested sets:

```ts
type RequestedGraphScope = {
  ontologyId: string;
  mode: "read" | "extend";
  nodeLabels: string[];
  relationshipTypes: string[];
  budget: {
    maxHops: number;
    maxNodes: number;
    maxTraversalMs: number;
    minRelevance: number;
  };
};
```

The declaration is mandatory for deployable agents and is a request beneath the
role ceiling. Empty arrays mean no graph resources, not all resources.

### 6.3 Authorized context scope

The PDP compiles an opaque host-side envelope:

```ts
type AuthorizedContextScope = {
  decisionId: string;
  policyVersion: string;
  effectiveScopeHash: string;
  ontologyId: string;
  schemaVersionId: string;
  catalogHash: string;
  contextProjectionId: string;
  readableNodeLabels: ReadonlySet<string>;
  extendableNodeLabels: ReadonlySet<string>;
  traversableRelationshipTypes: ReadonlySet<string>;
  extendableRelationshipTypes: ReadonlySet<string>;
  budget: GraphBudget;
};
```

Action sets remain separate throughout compilation. Permission to extend one
label or relationship type cannot upgrade a different read/traverse-only
resource. Within one principal, role allows combine as a union after deny and
approval precedence. Only then are principal-chain results, the admission
snapshot, agent request, and run restrictions intersected.

Every published role containing a graph allow/approval and every deployable
agent request declares a complete, versioned graph budget. Before resolution,
older/omitted values normalize to platform hard defaults. For one principal,
`maxHops`, `maxNodes`, and `maxTraversalMs` take the minimum across active roles
contributing a graph allow/approval; `minRelevance` takes the maximum. Apply the
same polarity across the principal chain, admission snapshot, agent request,
run restrictions, and platform hard limits.

The context broker accepts typed query plans, not arbitrary Cypher. A plan
declares candidate labels, traversed relationship types, endpoint labels,
contract-owned projection id, temporal cutoff, and traversal budget. Callers do
not provide arbitrary property lists. The broker validates the
plan against `AuthorizedContextScope`, compiles the database query, and validates
the returned resources before producing a context result.

Tenant scope is enforced by the broker's typed compiler on every anchor node,
traversed relationship, start node, end node, write target, and subquery using
both organization and workspace identifiers. Returned resources are verified
against the same scope. The Neo4j session is internal to the broker and is not
available to engines or agent handlers.

The current `scopedSession()` check that a Cypher string merely contains `orgId`
is bypassable. It must be replaced or restricted to broker-compiled plans; it is
neither a sufficient tenant boundary nor a graph-authorization boundary.

### 6.4 Every retrieval path uses the broker

The following paths must consume `ContextRecallPort` or another broker-owned
authorized adapter:

- explicit ontology and graph capabilities;
- lexical and semantic search;
- vector/ANN candidate generation and hydration;
- Engram and agent-memory recall;
- task-frame and pinned-context compilation;
- citations and snippets;
- graph get/list/export;
- CGP provider reads and exports;
- trace, replay, and local context caches.

Stored context/replay artifacts retain non-model-visible provenance sufficient
to reauthorize them: canonical graph resources, catalog/schema version,
projection id, original capability/MCP/skill/agent resource refs, decision id,
snapshot hash, and policy version. Replay checks current policy for both the
stored context resources and the original actions; it never treats recorded raw
output as pre-authorized.

Derived artifacts—including memory, summaries, embeddings, citations,
execution artifacts, and cached model output—retain the transitive canonical
resource set and source scope hashes that influenced them. Reading a derived
artifact requires current authorization for the artifact's own resource and
every transitive source resource/action reference in that provenance closure,
including graph label read/relationship traverse, capability invoke, MCP tool
call, skill load, and agent dispatch. Missing or incomplete provenance denies.
Only a separately approved, audited sanitization/reclassification workflow may
produce a new independent artifact with narrower provenance; v1 does not infer
that a summary, tool result, or embedding is safe.

Unauthorized labels and relationship types are excluded before candidate
generation and ranking. A global ANN query followed by post-filtering is not an
acceptable authorization implementation. The adapter must build the candidate
set from authorized labels, for example with label-aware indexes or an equivalent
pre-filtered retrieval plan.

Aggregate and vocabulary paths use the same authorized corpus. Denied resources
contribute no label/type names, distinct values, counts, source totals, growth,
timestamps, schema recommendations, or other statistics. A capability that
cannot calculate an aggregate from a pre-authorized candidate set is denied
unless the caller has explicit authority for the complete underlying resource
set; post-hoc subtraction is not sufficient.

Authorization-denied and authorization-unavailable errors are terminal.
Retriever-unavailable errors may produce an empty result only after the request
has an established authorized scope. No context compiler may fall back to an
older unfiltered implementation.

### 6.5 Extend mode

`extend` permits proposing nodes and relationships of already authorized labels
and relationship types. It does not create new schema vocabulary and does not
directly mutate Neo4j.

At proposal time, Oxagen validates:

- label/relationship authorization;
- start and end node authorization;
- pinned schema membership;
- required properties and schema conformance;
- traversal/context budget; and
- the capability and approval decision.

The same checks run again at approval and materialization time against current
policy and the current pinned schema. Creating a new label or relationship type
requires separate schema-management capability authorization.

All graph writers use `GraphMutationPort`; kernel capability authorization alone
is insufficient. Direct agent mutation capabilities—`upsert_node`,
`upsert_edge`, `ingest_graph`, `delete_node`, `delete_edge`, `add_node_label`,
`remove_node_label`, and `approve_semantic_edge`—are removed from the agent
surface. Agents submit typed extension proposals. The host requires the proposal
capability plus every applicable node-label `extend`, relationship-type
`extend`, and endpoint permission at proposal, approval, and commit.

Graph deletion, relabeling, retyping, and schema-vocabulary mutation are not
supported through production graph capabilities for any principal in v1. Human
or service ingestion paths may retain typed upsert/ingest mutations, but they
still use `GraphMutationPort` for tenant, schema, resource, and endpoint checks.
A capability allow can never compensate for a denied graph resource.

For an upsert or merge, `GraphMutationPort` resolves natural/external keys inside
the protected adapter. If a key matches an existing node or relationship, the
port authorizes the complete current pre-image—including every label, type, and
endpoint—before revealing that it exists or applying any update, then separately
authorizes the proposed post-image. A collision with a hidden resource returns
an opaque denial rather than existence, conflict, or timing detail.

Relabeling or retyping is a security reclassification, not ordinary `extend`.
Any future online reclassification or deletion workflow requires its own
approved action model and must authorize/audit the pre-image, post-image, and
endpoints. Offline schema migrations remain operator-controlled maintenance, not
an IAM role capability.

### 6.6 Raw Cypher

`run_cypher` is disabled on every production surface in v1. An agent principal
cannot invoke it even if a prompt names it or a custom role attempts to grant it.
Agent and human graph access use typed query-plan capabilities only.

A future human break-glass Cypher path requires its own approved specification,
an explicitly allowed human principal kind, restricted Neo4j credentials,
query-plan or AST validation, tenant enforcement, approval, result limits, and
full audit. The current mutation-keyword denylist and `orgId` token check are not
sufficient and must not remain reachable as a production escape hatch.

## 7. Tool, MCP, skill, and agent authorization

### 7.1 Materialization

The tool materializer receives an effective authorization envelope. Denied
capabilities and MCP tools are absent. Allowed tools are callable. Approval-
required tools remain discoverable with explicit approval metadata and pause on
call; they are not represented as ordinary allowed tools. This is a usability
and prompt-safety measure and does not replace execution-time authorization.

Agent definition bindings are requests:

- function entries request capabilities;
- MCP entries request installed servers/tools;
- skill entries request skills;
- agent entries request dispatch targets.

At agent-version publication and again at admission, host code resolves every
mutable slug/display reference to the tenant-scoped canonical identity used by
the resource grant: capability name, stable MCP server/tool identity, skill
public id, or agent public id. The immutable agent version persists those
resolved ids. Authorization never keys on a mutable slug; rename preserves the
identity, while deletion, cross-workspace lookup, or ambiguous/reused slug fails
closed.

Request-body filters and agent bindings narrow the effective set. The current
additive union of request and agent skill/MCP references is replaced by
intersection. If a requested agent cannot be loaded or authorized, the turn
fails closed rather than silently running as an unbound agent.

### 7.2 Invocation

- `invoke()` rechecks current resource authorization after surface validation
  and before billing, entitlement, or handler execution.
- Synthetic external MCP calls use default deny for agent/service principals and
  are rechecked by the external-tool authorization path.
- MCP `tools/list` and agent discovery omit unauthorized tools.
- Skills cannot grant capabilities; every expanded capability remains subject to
  its own grant.
- Every skill load goes through `SkillLoaderPort` and the `load_skill` kernel
  capability, rechecking both the skill resource and current policy immediately
  before skill content reaches prompt assembly. Revoked skills are not loaded.
- Installed MCP servers do not imply permission to every current or future tool.
- Subagent dispatch requires the structured agent-resource `dispatch` grant and
  the attenuated child scope.
- `AgentDispatchPort` accepts provenance-bearing references rather than copied
  parent prompt, context, or tool-output blobs. It rebuilds child context through
  `ContextRecallPort` under the child's envelope. Model-authored task text
  conservatively carries the transitive provenance of the prompt and tool
  outputs that influenced it; the child must be authorized for that closure.
  Raw or opaque context payloads are rejected. Any future declassification or
  cross-scope disclosure requires a separate approved resource/action design.
- Revocation between discovery and invocation is honored.
- Missing IAM or entitlement runtime is a production startup error, not an allow.

IAM is the launch authority for individual MCP tools. Installation, entitlement,
credential availability, and server health are necessary preconditions but do
not grant access. Existing `mcp-config` allow/deny/ask rules and user-keyed
consents are migrated/reset into principal-bound IAM grants and access requests,
then retired as authorization sources before launch. During the temporary
cutover, the result is the intersection and any deny wins; `ask` maps to
`require_approval`. There is no indefinite dual-policy mode.

Capability contracts that are unsafe to delegate declare allowed principal kinds
or equivalent non-delegable metadata enforced by the kernel. Sensitivity or
`riskLevel` is descriptive and cannot substitute for an explicit permission.

### 7.3 Sandbox and code-agent tools

The engine never receives a raw command runner, filesystem object, network
client, or vault. `SandboxPort` is a host-owned adapter. Command execution is an
honest coarse bundle: because a shell can read and write through ordinary
commands, granting it necessarily grants read and write inside the explicitly
mounted workspace and run scratch space. The UI, simulator, policy trace, and
audit evidence show that implication and never claim that a separate file-read
or file-write deny constrains an allowed shell. Standalone file-read or
file-write capabilities are useful only for restricted tools that do not expose
command execution.

The sandbox driver enforces the actual boundary with least-privilege mounts: no
host filesystem, sibling workspace, credential store, or vault mount is
reachable. Network is a separate driver-enforced capability and is denied by
default. The per-path filesystem matrix remains deferred, so an administrator
either grants the coarse command bundle for the mounted workspace or does not
expose it.

Every sandbox session, process, mount, snapshot, and egress lease is bound to the
organization, workspace, initiating/acting principal chain, acting agent, run
lineage, authorization snapshot hash, effective-scope hash, policy version, and
`validUntil`. Creation, connection, resume, command execution, and network use
all recheck current authority. A different or narrower envelope cannot reconnect
to a broader session or read its files; it receives a clean session or a denial.
On revocation, expiry, or policy narrowing, the host immediately fences the
lease and terminates or reconfigures every affected process before releasing any
more output or side effects. Background processes cannot retain filesystem or
network authority after their grant ends.

Secrets are never injected wholesale into an agent sandbox. Until a separate
secret-resource authorization design is approved, agent principals cannot
request vault-secret injection. Existing human-operated secret-management
capabilities remain kernel-authorized, and secret values never enter prompts,
context caches, or audit payloads.

## 8. Administration UI

### 8.1 Information architecture

Add these canonical routes:

| Route | Purpose |
|---|---|
| `/{orgSlug}/governance/permissions` | Redirect to Overview |
| `/{orgSlug}/governance/permissions/overview` | Posture and review summary |
| `/{orgSlug}/governance/permissions/roles` | Role catalog |
| `/{orgSlug}/governance/permissions/roles/new` | Create role draft |
| `/{orgSlug}/governance/permissions/roles/{roleId}` | Deep-linked role editor/detail |
| `/{orgSlug}/governance/permissions/principals` | Unified principal catalog |
| `/{orgSlug}/governance/permissions/principals/{principalId}` | Principal assignments/detail |
| `/{orgSlug}/governance/permissions/simulator` | Effective-access simulator |

Governance desktop navigation adds Permissions beside Policies. The existing
Governance mobile switcher adds the same destination; the feature does not add a
second fixed mobile navigation component. Roles and Principals are URL-backed
full-page routes on mobile and deep-linkable on every viewport.

The page owns an Organization/Workspace scope selector. Graph, MCP, skill, and
agent resources require a workspace scope. Existing `/{orgSlug}/access` remains
the session and periodic-review surface, and is extended to include all principal
kinds. Existing Governance Policies remains for non-IAM controls and links to
Permissions. Permission-management links must not be split across Studio pages.

Enforcement, principal provisioning, role authoring, assignment, and revocation
are universal safety behavior; no subscription tier may bypass the resolver or
restore permissive defaults. Commercial packaging may entitle advanced
simulation, signed exports, maker-checker workflows, or retention, but packaging
is not an authorization decision and is outside this specification. A packaged
control is gated server-side and shown with a clear explanation rather than
silently hidden.

### 8.2 Overview

The overview presents actionable posture, not generic charts:

- deployable agents without active roles;
- agents without an explicit graph scope;
- high-risk capability and MCP grants;
- expiring or break-glass assignments;
- pending privileged approvals;
- assignments not included in the latest review;
- most recent role changes; and
- last completed access review.

Every card links to a filtered Roles, Principals, Simulator, Audit, or Access
Review view.

### 8.3 Role catalog and editor

Desktop uses a three-pane layout:

1. searchable role catalog;
2. editor; and
3. live effective-access and blast-radius summary.

Tablet and mobile use full-page role routes. The editor contains:

- **Identity:** name, description, immutable organization/workspace scope,
  eligible principal kinds, version, and system/custom status.
- **Context:** separate node-label and relationship-type matrices with
  `read`/`traverse`, `extend`, deny, and approval controls; graph budget ceilings
  under Advanced.
- **Tools:** capabilities grouped by domain/risk, individual MCP tools grouped by
  server, skills, and dispatchable agents.
- **Assignments:** for published roles only, unified principal picker,
  assignment scope, and optional expiry. Assignment/revocation commits
  independently and immediately; it is not part of a role draft publication.
- **Review:** exact before/after diff, affected principals, widened graph scope,
  newly available high-risk tools, delegation-ceiling violations, and required
  reason.

Selecting all current graph/tool resources persists explicit rows and states
that future resources remain denied. A relationship grant whose known endpoints
are not readable is shown as ineffective with a one-click path to review the
missing node labels; the UI never auto-widens access.

Edits save as section-scoped patches to a server-side draft carrying
`baseActiveVersion` and monotonic `draftRevision`. Every patch sends
`expectedDraftRevision`; publish sends both the expected draft revision and base
active version. `Review and publish` is the only role-policy activation point.
Assignments use their separate immediate contracts and are disabled for an
unpublished role.

Security mutations are pessimistic: the UI changes local draft state but does
not claim a role or assignment is active until the server transaction succeeds.
A partial catalog failure may still save unaffected section patches without
deleting opaque/unloaded grants, but publication requires complete server-side
catalog validation and is disabled while that validation is unavailable.
Unsaved navigation requires confirmation.

### 8.4 Unified principal picker

`search_iam_principals` is the single source. It does not union separate human
and agent searches. Results are sibling options grouped visually by kind:

- People
- Agents
- Service accounts

Each result includes principal public id, kind text and icon, display name,
secondary identity, status, workspace, owner for display only, existing role
assignments, and a disabled reason when applicable.

Behavior requirements:

- server-side relevance search by display name, email/IdP subject, agent
  name/slug, service-account identifier, and principal public id;
- 200 ms debounce with cancellation and stale-response sequencing;
- cursor pagination with 20 initial results;
- optional kind filters over the same result set;
- already-assigned and suspended principals remain visible but disabled with a
  reason;
- deleted principals are hidden by default;
- selected values survive recoverable request errors;
- full ARIA combobox/listbox keyboard behavior and result announcements; and
- text labels in addition to color and icons.

### 8.5 Effective-access simulator

The simulator selects:

- workspace;
- initiating principal;
- optional acting agent and delegation chain;
- resource kind and resource; and
- action.

It calls the production resolver through `preview_iam_access` and renders Allow,
Deny, or Approval Required with policy version and an administrator-safe trace.
Examples include:

- Can Agent A read `Customer`?
- Can Agent A traverse `OWNS_ACCOUNT`?
- Can User B acting through Agent A invoke `create_pull_request`?
- Why was this MCP tool omitted?

The client never recreates resolution logic.

### 8.6 Agent Builder integration

Agent Builder adds a Permissions step that selects existing roles and previews:

```text
invoking principal
  INTERSECT deny-biased effective authority of selected roles
  INTERSECT agent configuration
```

Over-ceiling graph labels, tools, skills, and dispatch targets are disabled with
an explanation. Builder cannot create roles, synthesize policies, or turn a
selection into authority. Deployment is blocked until role, graph request, and
tool request are valid.

### 8.7 UI states and accessibility

Every independently loaded section supports:

- loading skeletons shaped like the final content;
- empty onboarding;
- ideal content;
- partial catalog failure with unaffected sections retained;
- typed error with retry;
- contextual permission denial;
- version conflict preserving the local draft; and
- policy-changed/stale simulator result.

Effect selectors are labelled radio groups, never color-only. Tables use real
links/buttons rather than clickable rows. Dialog focus returns to its trigger.
Status and validation updates use live regions. Keyboard-only, reduced-motion,
and 44 px mobile target checks are release gates.

## 9. Contracts and persistence

### 9.1 Capability contracts

Evolve `list_iam_roles` to the versioned resource model and add:

- `get_iam_role`
- `create_iam_role`
- `update_iam_role_draft`
- `publish_iam_role`
- `archive_iam_role`
- `restore_iam_role`
- `list_iam_role_versions`
- `restore_iam_role_version`
- `search_iam_principals`
- `list_iam_role_assignments`
- `assign_principal_role`
- `revoke_principal_role`
- `list_iam_resources`
- `preview_iam_access`
- `export_iam_permissions`
- `get_iam_posture`
- `list_iam_access_requests`
- `get_iam_access_request`
- `approve_iam_access_request`
- `deny_iam_access_request`
- `create_iam_access_review`
- `get_iam_access_review`
- `list_iam_access_reviews`
- `decide_iam_access_review_assignment`
- `complete_iam_access_review`
- `export_iam_access_review`

Management contracts are no-billing, high-sensitivity capabilities with default
deny and explicit Owner/Admin grants. Compliance receives read, simulation, and
export access but not mutation access. IAM mutation contracts are not exposed on
the agent surface. Every contract follows API/MCP parity and app-layer mapping.

App Server Actions live in the owning route segment's `actions.ts`, validate
inputs, assert the authenticated management envelope, and call the capability.
`apps/app/instrumentation.ts` is the Node-runtime bootstrap entrypoint and must
successfully initialize the same IAM gate as API/MCP before serving production
requests. The stale `invoke-org.ts`/app-skill comments that say the app does not
bootstrap IAM are superseded and must be corrected during implementation.

Replace the org-only zero-workspace sentinel helper with the discriminated
authorization scope. Page/Action assertions remain defense in depth and improve
errors, but the bootstrapped kernel is the final authorization decision.

`preview_iam_access` accepts a discriminated scope, initiating principal id,
optional acting-agent principal id, ordered persisted delegation ids, exact
resource tuple, and optional caller-owned draft role version for impact preview.
The server validates tenant/scope, status, adjacency, acyclicity, dispatch
authority, and draft ownership. Arbitrary client-authored principal chains are
rejected and simulator results never create an executable grant.

### 9.2 Persistence changes

The implementation plan must include migrations for:

- `principals.subject_id` and corrected uniqueness;
- stable `service_accounts` identities with rotatable principal-bound API-key
  credentials;
- agent and service principal provisioning/lifecycle;
- explicit credential-to-service-principal binding;
- scoped, acyclic `principal_delegations`;
- scoped role identity, unique names, `active_version_id`, and eligible principal
  kinds;
- immutable `role_versions`;
- generalized `resource_grants` tied to role versions;
- assignment/role scope constraints and principal-based attribution;
- generalized resource-aware `access_requests`;
- single-use `approval_authorizations` for exact execution;
- one monotonic `policy_versions` counter per org;
- immutable authorization snapshots referenced by durable runs;
- transactional IAM audit outbox records; and
- assignment review/export coverage for all principal kinds.

There are no production customers. Do not add `Agent Legacy`, permissive
backfills, dual-read compatibility, or default-all migrations. Reset and reseed
pre-launch environments after the migration, then require explicit roles and
scopes.

All new IAM tables use tenant RLS and the established nullable-workspace
convention. Database/migration assertions require:

- one principal per `(org, kind, subject)` and one principal per service account;
- same-org/workspace subject and principal bindings with no orphans;
- one active draft per role;
- `active_version_id` belonging to that role and exact scope;
- one live grant per `(roleVersion, resourceKind, resourceId, action, effect)`;
- active-only assignment uniqueness so a revoked assignment can be recreated;
- no scope-incompatible role, grant, assignment, delegation, or snapshot;
- no active deployable agent/service without a principal and role; and
- no queued/running unattributed `RunSpecV1` row.

Principal migration order is expand schema, populate/reset pre-launch data,
validate counts and constraints, switch all reads/writes to `subject_id`, then
remove `parent_user_id`. Unattributable v1 runs are cancelled/reset; they are
never assigned a zero-UUID or invented service principal.

## 10. Audit and review evidence

### 10.1 Policy changes

Every draft publication, role archive/restore, assignment, revocation, principal
status change, approval, and break-glass action writes an immutable event in the
same transaction as the state change. A durable outbox projects those events to
ClickHouse without making ClickHouse mutable policy state.

Wall-clock expiry becomes ineffective at `validUntil` without waiting for a
write. An idempotent sweeper records the explicit expired state and emits one
`expiry_observed` event; the first resolver denial may enqueue the same
deduplicated event. Cache validity and enforcement never depend on sweeper
timing.

Policy events include:

- actor principal id and kind;
- target role/principal ids and kinds;
- org/workspace scope;
- previous and new versions and hashes;
- structured before/after diff;
- reason, request id, and idempotency key;
- outcome and typed failure code; and
- occurrence time.

### 10.2 Runtime decisions

Every runtime allow, deny, and approval decision writes a durable decision-outbox
record before an agent-visible context result or side effect is released. Agent
execution fails closed if that durable admission record cannot be written. Tool
and graph execution use the decision id as an idempotent obligation key and emit
append-only completion/failure events; unfinished obligations remain retryable
instead of disappearing through fire-and-forget telemetry.

Graph, capability, MCP, skill, and dispatch decisions record:

- initiating and acting principals;
- agent and complete delegation chain;
- delegation and authorization snapshot ids/hashes;
- resource kind/id/action;
- requested and effective scope hashes;
- decision id, outcome, reason, and policy version;
- request, run, parent-run, and trace identifiers;
- entitlement/approval result where applicable; and
- counts and identifiers needed for evidence.

Sandbox evidence additionally records the session/lease id, mount profile,
egress profile, effective-scope hash, creation/resume/fence events, and process
termination outcome. Dispatch evidence records the child envelope and hashes of
the provenance references considered, never the referenced values themselves.

Audit payloads do not contain graph property values, prompts, credentials,
retrieved context, or forbidden resource names inferred only during denial.

### 10.3 Reviews and exports

Quarterly access-review snapshots include human, agent, and service principals,
their active assignments, assignment expiry, last activity, and reviewer
decision. Confirming or revoking an assignment is an auditable action.

`export_iam_permissions` produces:

- signed JSON or NDJSON evidence with manifest hash;
- a flat CSV access matrix; and
- policy version, role versions, grants, assignments, principal kinds, scope,
  and timestamps.

Audit export remains separate and reuses the signed Security Audit export. The
product may state that these controls support SOC 2 access-control and audit
evidence; it must not claim that enabling the feature certifies a customer.

## 11. Errors, concurrency, and cache behavior

### 11.1 Typed errors

At minimum, contracts and UI distinguish:

- `iam_authorization_denied`
- `iam_approval_required`
- `iam_policy_unavailable`
- `iam_role_not_found`
- `iam_role_version_conflict`
- `iam_role_draft_conflict`
- `iam_role_archived`
- `iam_system_role_immutable`
- `iam_scope_mismatch`
- `iam_invalid_resource_scope`
- `iam_delegation_ceiling`
- `iam_principal_inactive`
- `iam_last_owner`
- `iam_tier_denied`
- `iam_raw_cypher_non_delegable`
- `iam_context_scope_unavailable`
- `iam_resource_catalog_unavailable`
- `iam_approval_replayed`
- `iam_execution_input_changed`
- `iam_dispatch_disclosure_denied`
- `iam_sandbox_authority_changed`

A conflict response returns the current server version. The client preserves its
draft and presents base, local, and current state; last-write-wins is prohibited.

For non-administrator runtime callers, an unknown resource and an existing but
denied resource use the same status, public error code, response shape, and
bounded timing envelope. Only the administrator simulator and protected audit
trace may distinguish invalid scope, missing catalog entries, and denied
resources. Discovery endpoints likewise omit both without exposing counts that
reveal hidden catalog entries.

Assignment writes are idempotent against the existing uniqueness constraints.
Bulk assignment/revocation is one transaction with one idempotency key. The last
active human Owner cannot be revoked or expired.

### 11.2 Cache safety and performance

- Decision caches are keyed by principal chain, workspace, resource/action,
  policy version, authorization snapshot hash, admission/current agent-version
  hashes, graph catalog hash, and requested-scope hash.
- Those caches contain only pure RBAC/delegation predecisions. Exact-execution
  approval authorizations and final side-effect decisions are non-cacheable and
  always perform the post-normalization atomic single-use claim described in
  §5.5.
- Policy publication and principal/assignment revocation synchronously increment
  the policy version and invalidate affected entries.
- A worker compares the referenced version with the current version before using
  a cached decision and refuses entries past `validUntil`. Version lookup
  failure denies.
- Context/result caches include `effectiveScopeHash` and policy version; entries
  are never shared across different scope hashes.
- Principal and resource catalogs use cursor pagination and server-side search.
- The implementation performance budget is under 25 ms p95 for warm in-process
  authorization and under 100 ms p95 for a cold fetch-and-resolve path, measured
  without graph/tool execution time.

## 12. Verification matrix

### 12.1 Resolver and identity

| Scenario | Required result |
|---|---|
| One assigned role allows and another denies the same resource | Deny |
| One role allows and another requires approval | Approval required |
| Initiator allows `Customer`; agent does not | Deny |
| Agent allows `Customer`; initiator does not | Deny |
| Parent dispatches a more privileged child | Child receives the intersection |
| New label/tool appears after role publication | Denied |
| Agent probes a denied resource id and a nonexistent resource id | Responses are externally indistinguishable |
| New allow is published after a run starts | In-flight run remains bounded by its admission snapshot |
| Agent binding is removed after a run starts | In-flight run narrows on next recheck |
| Agent is suspended after durable enqueue | Claim/resume denied |
| One human owns multiple agents | One human principal plus one distinct principal per agent |
| API key created by Owner has no service role | Denied; creator authority is not inherited |
| One of several service-account keys is revoked | That credential/snapshots fail; sibling keys and principal remain active |
| Break-glass role is used through an agent | Non-delegable authority is excluded; deny |
| Role becomes human-only while agents remain assigned | Publish rejects; runtime drift denies |
| Org role contains a graph/MCP/skill/agent grant | Publish and runtime reject invalid scope |
| Exact-execution approval is replayed | Atomic second consumption is denied |
| Role is archived with active assignments | Authority stops; assignments remain only as revoked evidence |
| Last human Owner revocation is attempted | Typed rejection |

### 12.2 Graph and context

| Scenario | Required result |
|---|---|
| Allowed node also carries a denied domain label | Node excluded before candidate generation |
| Node carries an unknown/conflicting extra domain label | Whole node denied |
| Relationship type allowed but an endpoint label denied | Relationship/path excluded |
| Endpoint labels allowed but relationship type denied | Traversal denied |
| Optional match reaches a denied label | Denied endpoint and path absent |
| Vector query has a denied label among nearest neighbors | Denied node does not enter candidate/ranking set |
| Stats/vocabulary query runs with one denied label/type | Denied names and their counts/totals/timestamps contribute nothing |
| Engram/pinned context contains a denied resource | Excluded before prompt compilation |
| Authorization service fails during compilation | Turn fails closed; no legacy fallback |
| Authorized retriever times out | That source yields empty authorized context only |
| Agent submits raw Cypher containing a fake `$orgId` token | Tool absent and invocation denied |
| Query mentions tenant ids on one anchor but not another endpoint/subquery | Broker rejects the plan/query |
| `upsert_node` capability is allowed but target label `extend` is denied | Mutation denied at GraphMutationPort |
| Allowed-label upsert key collides with an existing denied-label node | Opaque deny before existence or pre-image is revealed |
| Restricted label is removed/retyped to an allowed label | Operation unavailable; node does not become visible |
| Parent has `minRelevance=.9`; child requests `.1` | Effective minimum relevance remains `.9` |
| Extend proposal loses permission before approval | Approval/materialization denied |
| CGP frame requests broader scope | Host intersection wins; frame grants nothing |
| CGP frame self-labels allowed but host provenance is denied/unknown | Frame denied |
| Replay contains a now-denied graph/tool resource | Replay reauthorization denies that artifact/action |
| `AgentMemory` is derived from `Customer` and caller lacks `Customer:read` | Artifact denied despite `AgentMemory:read` |
| Cached artifact derives from a now-denied MCP/tool action | Read and narrower-child dispatch both deny |
| External provider cannot attest authorized pre-retrieval filtering/ranking | Provider call fails closed |

### 12.3 Tools and dispatch

| Scenario | Required result |
|---|---|
| Registered capability is outside effective grants | Not materialized |
| Prompt directly names that denied capability | Kernel denies |
| Tool is revoked after materialization | Invocation denies |
| MCP server installed but tool not granted | Tool absent and direct call denied |
| Skill requests an ungranted capability | Capability remains absent/denied |
| Granted skill is revoked before prompt assembly | Skill content is not loaded |
| Skill/agent slug is renamed or reused | Stored stable id governs; deleted/ambiguous target denies |
| Chat request adds an MCP server outside the agent role | Request cannot widen binding |
| IAM allow conflicts with legacy MCP deny/ask during cutover | Deny wins / approval required; no bypass |
| Approved input is mutated by a host/engine hook before execution | Decision invalidated; input is re-normalized, re-approved, and reauthorized |
| Parent can read `Customer`; child cannot; dispatch includes derived Customer data | Dispatch denied; raw parent context is never forwarded |
| Command execution is allowed while standalone file write is denied | Trace truthfully shows mounted-workspace read/write included in command bundle |
| Sandbox network or secret injection lacks explicit authority | Network denied; secret injection unavailable |
| Grant is revoked while a sandbox background process is running | Lease fenced and process stopped before further I/O or egress |
| Narrower run reconnects to a broader prior sandbox session | Reconnect denied or a clean isolated session is created |
| Agent binding lookup fails | Bound turn fails closed |
| Missing production IAM bootstrap | Runtime refuses startup |

### 12.4 UI and evidence

End-to-end coverage must prove:

1. Owner enters the canonical Permissions routes, deep-links to a role, refreshes
   without losing selection, then creates a custom role draft, selects explicit
   labels, relationship types, capabilities, MCP tools, skills, and an agent,
   reviews the blast radius, and publishes a version.
2. Unified typeahead returns a seeded human, agent, and service as sibling
   principals; the agent appears exactly once; keyboard selection works.
3. Suspended and already-assigned principals remain visible but unselectable with
   reasons.
4. Assigning the role to an agent updates Principal detail and Agent Builder's
   effective-access preview.
5. Two-browser editing produces a version conflict, preserves the stale editor's
   draft, and cannot overwrite the newer policy.
6. Compliance sees the read-only surface and signed exports; Member sees a
   contextual denial; direct Server Action calls cannot bypass either result.
7. A graph-catalog failure leaves tool and assignment sections usable with a
   retryable partial state, preserves opaque graph grants, and prevents publish
   until full server validation is available.
8. Simulator output matches a real kernel/context-broker decision for the same
   principal chain and resource.
9. Access Review includes humans, agents, and services and produces signed
   evidence for confirm/revoke decisions.
10. Loading, empty, ideal, partial, error, permission-denied, approval, and
    conflict states have screenshot-backed Playwright coverage.
11. Keyboard-only, reduced-motion, desktop, tablet, and mobile flows pass.
12. Every new app-layer capability has a real `capability-ui-map.json` binding and
    passes manifest, UI-parity, mobile-parity, accessibility, and narrow tests.
13. Approval-required graph/tool calls appear as gated, cannot execute before
    approval, and reject replay after one exact execution.
14. Archiving a role revokes effective assignments immediately; restoring it
    does not reactivate them.

## 13. Delivery sequence

This document is the canonical program design, not one giant implementation
unit. After approval, implementation planning is decomposed into separately
reviewed specifications/plans for:

1. IAM identity, role versions, grants, resolver, approvals, and policy audit;
2. delegation, authorization snapshots, `RunSpecV2`, and durable admission;
3. context broker, graph catalog, retrieval indexes, and `GraphMutationPort`;
4. capability/MCP/skill/sandbox/dispatch enforcement; and
5. Permissions UI, Access Review, simulator, and signed evidence exports.

The first two subprojects freeze shared `PrincipalRef`, discriminated scope,
policy revision, authorization decision/snapshot, authorized-port, and audit
event interfaces before downstream plans begin. A downstream plan may narrow an
interface but cannot silently redefine the trust boundary in this program spec.

### Phase 1 — IAM identity and policy foundation

- Correct principal subject binding and uniqueness.
- Provision agent and service principals transactionally with their subjects.
- Add principal lifecycle hooks.
- Add role versions, resource grants, policy versions, generalized access
  requests, and the audit outbox.
- Replace allow-before-deny role resolution with deny-biased resolution and
  chain intersection.
- Remove the non-enterprise IAM bypass and the synthetic all-resource Owner
  allow; seed explicit system management grants instead.
- Implement role/principal/resource/simulator/export contracts.
- Reset and reseed pre-launch IAM state without a permissive legacy role.

**Exit:** The production resolver and simulator return identical, traced results
for every resource kind; no deployable agent/service lacks an explicit principal
and role.

### Phase 2 — Delegation and durable run authority

- Persist scoped, acyclic principal delegations.
- Create immutable authorization snapshots from the Phase 1 resolver.
- Introduce `RunSpecV2`, expanded discriminated `CapabilityContext`, and full
  delegation/run attribution.
- Make admission atomically write delegation, snapshot, run, and audit outbox.
- Re-resolve snapshot ceiling against current authority and current agent
  definition on claim/resume.

**Exit:** Every run identifies initiator, actor, agent, ordered delegation chain,
snapshot, credential, scope, and current policy version; revocation narrows and
new grants cannot widen in-flight work.

### Phase 3 — Enforcement ports

- Add the authorized context broker/query-plan boundary.
- Route explicit and implicit context retrieval through it.
- Enforce label/type visibility before candidate selection and ranking.
- Replace additive tool bindings with intersection.
- Filter discovery and recheck kernel/MCP/skill/dispatch invocation.
- Enforce provenance-safe child dispatch and derived-artifact reauthorization.
- Add sandbox mount/egress enforcement, authority-bound sessions, and revocation
  fencing.
- Remove agent raw-Cypher access and fail-open fallbacks.

**Exit:** The complete security matrix in §12 passes against live Neo4j and real
kernel/MCP adapters. No UI is generally available before this exit.

### Phase 4 — Permissions UI and Agent Builder

- Ship Overview, Roles, Principals, and Simulator behind a feature flag.
- Add server-side drafts, review/publish, version conflicts, unified typeahead,
  responsive behavior, and all mandatory UI states.
- Add role selection and effective-access preview to Agent Builder.

**Exit:** An administrator can create, assign, explain, and verify an agent's
knowledge and tool scope without scripts or direct database access.

### Phase 5 — Audit readiness and launch hardening

- Generalize Access Reviews to all principal kinds.
- Add signed permission snapshot/export and audit deep links.
- Exercise JIT, break-glass, maker-checker, revocation, cache invalidation,
  restore, and disaster-recovery paths.
- Document the control/evidence mapping without asserting certification.

**Exit:** A security reviewer can reproduce who had access, why, under which
version, when it changed, and which actions/retrievals resulted.

Phases may be developed in parallel behind flags, but launch order is fixed:
identity and enforcement precede the editable UI. A feature flag may hide an
unfinished surface; it may not turn an authorization failure into an allow.

## 14. Rejected alternatives

### UI over current agent configuration

Rejected because `graphAccess` and agent tool bindings are declarations, not
enforced authority. It would create a false-security control plane.

### Neo4j-native RBAC as the primary model

Rejected because it governs only the graph, does not cover capabilities/MCP/
skills/agents, does not express Oxagen's delegation chain, and would couple
authorization to a shared database connection model. It may be used later as
defense in depth.

### OpenFGA/Zanzibar, Cedar, or OPA in v1

Rejected as unnecessary operational and policy-language complexity. Oxagen's
resource set is typed and bounded, and the existing pure resolver is the correct
seam once fed versioned resource grants.

### Direct grants

Rejected because they make access reviews and explanations harder and permit
one-off privilege drift. Time-bounded role assignments cover JIT needs while
keeping one administration model.

### Property-level IAM in v1

Rejected because a correct implementation must govern every derived channel,
not merely API serialization. Node-label and relationship-type authorization
removes the immediate enterprise control gap without making a field-security
claim the platform cannot yet enforce.

### Post-retrieval graph filtering

Rejected because unauthorized resources would still influence candidate
selection, ranking, counts, latency, embeddings, and fallbacks.

## 15. Launch acceptance

The feature is launchable only when all of the following are true:

- every deployable agent and service has a distinct active IAM principal;
- every agent has explicit workspace roles, graph request, and tool request;
- all graph/context entry points use an authorized broker path;
- external context providers prove pre-retrieval authorization and derived
  artifacts enforce transitive source provenance;
- all discovered tools are filtered and all invocations are reauthorized;
- child dispatch never copies broader parent context into a narrower envelope;
- sandbox sessions, mounts, processes, and egress are authority-bound and fenced
  on revocation or expiry;
- deny wins and delegation intersections are proven by unit/integration tests;
- durable runs retain lineage and honor current revocations;
- the UI uses production contracts and the production resolver;
- access reviews and exports include all principal kinds;
- policy changes and runtime decisions produce immutable evidence without raw
  context values;
- no legacy/default-all role, raw agent Cypher, unfiltered fallback, or missing
  IAM-runtime allow remains; and
- property-level controls are neither exposed nor claimed.

## Changelog

- 2026-07-21 — Replaced the earlier proposal with the approved enterprise
  principal/RBAC, node-label, relationship-type, tool, UI, and audit design;
  removed backward-compatibility and property-ACL scope; fixed principal binding,
  deny precedence, durable-run identity, raw-Cypher, and implicit-retrieval gaps.
