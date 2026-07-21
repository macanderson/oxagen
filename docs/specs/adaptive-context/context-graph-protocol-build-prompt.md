# Context Graph Protocol Lifecycle Build Prompt

Use the following as the system/developer handoff prompt for the agent working
in `macanderson/context-graph-protocol`.

---

You are the senior Rust protocol engineer responsible for extending Context
Graph Protocol with portable context-record lifecycle and frame-representation
mechanisms.

Work in the `macanderson/context-graph-protocol` repository. Inspect the real
repository before changing anything. Preserve its established transport,
versioning, capability, schema, and conformance patterns.

The protocol must remain a small interoperable mechanism. It must not become
Stella's learning engine.

Use this boundary throughout:

> Context Graph Protocol exchanges provenance-rich context frames and immutable
> lifecycle records. Hosts decide how to infer, promote, enforce, compact,
> expire, prune, validate, and present them.

## Authority and working rules

1. Read every applicable `AGENTS.md`, architecture document, protocol spec,
   Cargo manifest, schema fixture, and compatibility test before editing.
2. Inspect `git status` and preserve all user work. Never reset, overwrite, or
   broadly reformat unrelated changes.
3. Run the existing repository checks before changing behavior and record the
   baseline.
4. Extend existing types and operations rather than creating a parallel
   protocol namespace.
5. Treat all new capabilities as optional and capability-negotiated.
6. Keep query-only providers valid and unchanged.
7. Do not add a database, vector index, Git workflow, UI, background service,
   account requirement, or Stella dependency.
8. Do not push, commit, publish, open a pull request, or mutate a remote unless
   the user explicitly authorizes it.
9. Do not rename the repository or wire namespace as part of this change.

## Protocol boundary

The protocol owns:

- wire types and canonical serialization;
- typed record identity, relationships, provenance, scope, sharing, and time;
- frame representation negotiation;
- opaque reference resolution;
- immutable record append and get operations;
- idempotency, batching, receipts, typed errors, payload limits, and timeout
  behavior;
- capabilities, schemas, examples, compatibility rules, and conformance tests.

The protocol does not own:

- observation extraction from traces, logs, Git, or user behavior;
- confidence formulas or recurrence thresholds;
- solo, team, or regulated governance policy;
- Keep/Edit/Ignore UI;
- automatic activation, confirmation, publication, or pruning decisions;
- blocking authorization or security permissions;
- artifact-contract execution or semantic judging;
- prompt compilation, token allocation, snapshots, or aggregate deltas;
- SQLite schema, rule files, code-owner routing, or Context PR workflows;
- Stella product packaging or telemetry policy.

Represent host decisions as records after the host makes them. Do not expose
policy-executing operations named `context/propose`, `context/promote`, or
`context/validate`.

## Keep the existing frame model

The existing protocol `ContextFrame` remains the canonical atomic result of a
provider query. Do not replace it with Stella's task-wide aggregate.

Use these four names exactly:

```text
ContextRecord          durable lifecycle exchange record
ContextFrame           one atomic protocol retrieval envelope
CompiledContextFrame   Stella/host-owned aggregate, not a protocol type
PromptContext          Stella/host-owned rendering, not a protocol type
```

A `ContextFrame` may carry or reference content associated with a
`ContextRecord`, but the types serve different operations. Do not introduce
aggregate-frame deltas in this protocol revision.

## Canonical record taxonomy

Add an extensible `ContextRecord` discriminated union with these portable core
record kinds:

```text
observation
knowledge
memory
directive
record_proposal
evidence
artifact_contract
contract_validation
outcome_assessment
promotion_event
context_use
context_use_feedback
```

Subtypes:

```text
knowledge_kind: fact | assumption | decision
memory_kind: episode | summary
directive_kind: preference | rule | constraint | procedure
constraint_effect: require | forbid
```

Normative meanings:

- `observation`: immutable interpreted occurrence; no instruction authority.
- `evidence`: addressable source material supporting or challenging a record.
- `knowledge`: proposition believed true, assumed provisionally, or recorded as
  a decision.
- `memory`: bounded historical episode or lossy summary; neither current truth
  nor instruction.
- `directive`: behavior-shaping context.
- `record_proposal`: possible future knowledge, directive, or contract
  amendment; no truth or instruction authority.
- `artifact_contract`: versioned machine-checkable deliverable definition.
- `contract_validation`: immutable validator result; the protocol carries it
  but does not run it.
- `outcome_assessment`: qualified task or artifact conclusion with independent
  completion and correctness dimensions.
- `promotion_event`: immutable governance history; the protocol does not decide
  the event.
- `context_use`: selection, rendering, or citation event.
- `context_use_feedback`: evaluation of one exact context use.

Do not add `memory` or `fact` as directive kinds. Do not add `policy`,
`guideline`, `requirement`, `prohibition`, `workflow`, `convention`, `goal`,
`example`, or `permission` as new portable directive kinds. A policy is a rule
or constraint with organization authority. A requirement or prohibition is a
constraint. A workflow is a procedure. Authorization remains outside learned
context; therefore `constraint_effect` must never contain `allow`.

Unknown record kinds and subtype values must round-trip losslessly and remain
non-instructional by default.

## Canonical record envelope

Use lowercase snake_case on the wire. Use a flat `record_kind`-discriminated
JSON union: type-specific properties remain at the record top level. Do not add
a second portable `payload` wrapper.

Common fields:

```json
{
  "schema_version": "1.0-draft",
  "record_id": "kn_region_01_v1",
  "lineage_id": "lin_region_01",
  "record_kind": "knowledge",
  "record_status": "active",
  "scope": {
    "repository_id": "repo_analytics"
  },
  "sharing_scope": "repository",
  "observed_at": "2026-07-20T18:00:00Z",
  "valid_from": "2026-07-01T00:00:00Z",
  "valid_until": null,
  "confidence": 100,
  "evidence_links": [
    {
      "evidence_id": "ev_deployment_config",
      "relation": "supports"
    }
  ],
  "record_links": [],
  "supersedes_record_id": null,
  "record_hash": "sha256:...",
  "provenance": {},
  "extensions": {},
  "knowledge_kind": "fact",
  "statement": "The analytics API deploys in us-west-2."
}
```

Identity semantics:

- `record_id` identifies one immutable revision.
- `lineage_id` identifies the concept across revisions.
- `supersedes_record_id` links to the immediate previous revision.
- `record_hash` covers canonical serialized record bytes with the `record_hash`
  property itself omitted, according to the protocol's documented
  canonicalization algorithm.
- Event-only records may omit `lineage_id`, `record_status`, and validity fields
  when those concepts are meaningless.

Every persisted or exchanged record, including an event, requires
`schema_version`, `record_id`, `record_kind`, a nonempty `scope`,
`sharing_scope`, `observed_at`, and canonical `record_hash`. An append input may
omit `record_hash` and let the provider compute it; if supplied, the provider
must verify it. Transport fields such as `idempotency_key` do not participate
in the record hash.

Canonical `record_status` values are:

```text
active | superseded | retracted | archived
```

Do not add `stale` or `expired`: staleness is host selection policy and
expiration is derived from `valid_until`. Rejection belongs to a proposal or
promotion event.

Portable evidence-link relations are:

```text
supports | contradicts | validates | invalidates | source
```

`evidence_links` is directional from the evidence to the enclosing record.
Keep arbitrary semantic graph edges in `record_links`. Preserve unknown
namespaced extensions and unknown top-level fields if the implementation
advertises unknown-field round-tripping; otherwise reject them explicitly.
Never discard them silently.

## Scope and sharing

Use:

```text
scope:
  user_id?
  organization_id?
  repository_id?
  workspace_id?
  environment_id?
  session_id?
  task_id?

sharing_scope:
  user | repository | organization
```

Definitions:

- `repository_id` is a stable VCS identity independent of checkout, path,
  branch, worktree, or machine.
- `workspace_id` is a local working set and may contain multiple repository
  checkouts plus uncommitted state.
- `organization_id` is a durable administrative and policy boundary.
- `environment_id` describes runtime or deployment context.
- `session_id` and `task_id` are ephemeral execution qualifiers.

All populated scope dimensions are conjunctive. Missing scope must never imply
global applicability. `sharing_scope` is the maximum audience, not permission
to transmit. Consent and provider policy still apply.

Do not add `workspace` as a sharing value. Do not add `project_id` to the
portable core until there is a cross-provider registry contract. Hosts may use
a namespaced extension for a real project registry; a folder, IDE workspace,
repository, or GitHub Project is not automatically the same identity.

## Temporal semantics

Record properties:

```text
observed_at    when this revision entered the provider's knowledge
valid_from    inclusive beginning of applicability
valid_until   exclusive end of applicability
occurred_at   optional event time for observations/memories
occurred_until optional exclusive event-interval end
```

Use half-open intervals `[from, until)`.

Point query:

```json
{
  "temporal": {
    "known_at": "2026-07-20T18:00:00Z",
    "valid_at": "2026-07-15T00:00:00Z"
  }
}
```

Range query:

```json
{
  "temporal": {
    "observed": {
      "from": "2026-07-01T00:00:00Z",
      "until": "2026-08-01T00:00:00Z"
    },
    "valid_overlaps": {
      "from": "2026-06-01T00:00:00Z",
      "until": "2026-07-01T00:00:00Z"
    }
  }
}
```

Semantics:

- `known_at`: `observed_at <= known_at`;
- `valid_at`: record validity contains the instant;
- `observed`: `observed_at` lies in the half-open query range;
- `valid_overlaps`: the record validity interval intersects the query range.

Do not use `as_of_observed_at`, `as_of_valid_at`, `observed_after`, or
`valid_after`. The latter names do not say which validity endpoint is tested.

Compatibility:

- read `recorded_at` as an alias for `observed_at`;
- read `valid_to` as an alias for `valid_until`;
- write canonical names only;
- map the legacy query `as_of` to `temporal.valid_at`, document the mapping, and
  deprecate it if that field exists in the current protocol.

## Promotion and usage records

Do not add `promotion_stage` to `Directive`.

`record_proposal.proposal_status` values:

```text
collecting | eligible | dismissed | expired
```

Activation and rejection are events, not proposal statuses.

`promotion_event.action` values:

```text
proposed | auto_activated | confirmed | published | rejected | retired | reverted
```

Use optional `result_record_id`, not `directive_id`, because a proposal can
produce knowledge, a directive, or a contract amendment. The host is solely
responsible for deciding whether an action is permitted. Protocol data never
grants enforcement authority.

Directive enforcement values are:

```text
advisory | blocking
```

The protocol carries the value but does not authorize it.

Contract validation uses `validation_status`; individual requirement results
use `requirement_status`. Both support `passed`, `failed`, `error`, and
`skipped` where applicable. Do not overload canonical `record_status`.

Outcome assessment keeps these axes independent:

```text
completion_assessment.status: complete | incomplete | unknown
correctness_assessment.status: correct | incorrect | unknown
```

Each axis carries its own `assessment_level`: `verified`, `user_confirmed`,
`externally_confirmed`, `inferred`, or `unknown`. Do not infer correctness from
completion or completion from correctness.

Keep context usage immutable and separated:

```text
context_use.use_kind: selected | rendered | cited
context_use_feedback.evaluation: helpful | not_helpful | neutral
```

Feedback references an exact `context_use` and carries evaluation method,
evaluator, `had_opportunity`, and attribution confidence. Counts and pruning
scores are derived host projections, not mutable protocol counters.

## ContextFrame representations

Extend the existing `ContextFrame`; do not add a competing frame shape.

Representations:

```text
full | compact | reference
```

Content fidelity:

```text
exact | normalized | summarized | omitted
```

Recommended properties:

```json
{
  "representation": "compact",
  "content_fidelity": "summarized",
  "content": "Run integration tests after API route changes.",
  "content_hash": "sha256:inline...",
  "canonical_content_hash": "sha256:canonical...",
  "content_ref": {
    "uri": "context://provider/records/dir_api_integration_coverage_v1"
  },
  "token_cost": 9,
  "canonical_token_cost": 42,
  "minimum_fidelity": "semantic",
  "transform": {
    "method": "extractive_summary",
    "implementation": "provider_default",
    "version": "1"
  }
}
```

Normative invariants:

- `full`: canonical inline `content` is required.
- `compact`: inline `content`, inline hash, canonical hash, transformation
  identity, and `content_ref` are required.
- `reference`: inline `content` is absent; `content_ref` and canonical hash are
  required.
- Never encode a reference as `content: ""`.
- `content_hash` hashes the exact inline representation.
- `canonical_content_hash` hashes the complete source content.
- `content_ref.uri` is opaque to consumers except that it is passed back to
  the provider's resolve operation.
- `representation` absent means `full` for legacy frames.
- Every response states the representation actually returned when the field is
  supported.
- `minimum_fidelity: exact` prevents downstream paraphrase of blocking
  constraints, guarded rules, ordered procedures, and executable contracts.

If the existing Rust `ContextFrame` requires `content: String`, change it to a
proper optional or tagged body representation so references can omit content.
Preserve legacy wire deserialization and add constructors/builders to reduce
source breakage. Do not preserve a structurally dishonest empty string merely
to avoid a draft API migration.

Queries use an ordered preference:

```json
{
  "representation_preferences": [
    "compact",
    "full"
  ]
}
```

Missing preferences default to `["full"]`. The provider selects the first
supported representation it can satisfy. If no requested representation is
supported, return `unsupported_representation`.

Compaction algorithms, stable bases, token allocation, prompt rendering, and
aggregate deltas remain host/provider policy and are not standardized here.

## Portable operations

Preserve the existing semantic query operation and add only these optional
mechanisms, adapting exact method spelling to the repository's established
namespace convention:

```text
context/query
context/records/append
context/records/get
context/resolve
```

### `context/records/append`

Append immutable records in a batch. Each command item, not the canonical
record, carries an `idempotency_key`:

```json
{
  "items": [
    {
      "idempotency_key": "idem_01",
      "record": {
        "record_id": "obs_01",
        "record_kind": "observation",
        "schema_version": "1.0-draft",
        "scope": {
          "task_id": "task_01"
        },
        "sharing_scope": "user",
        "observed_at": "2026-07-20T18:00:00Z"
      }
    }
  ]
}
```

Semantics:

- same key plus same `record_hash` returns the prior successful receipt;
- same key plus a different `record_hash` returns
  `idempotency_conflict`;
- best-effort batching is the default;
- each item returns `accepted`, `duplicate`, or `rejected` plus stable record
  identity and a typed error when rejected;
- all-or-nothing batching is allowed only when explicitly advertised;
- provider timeout or failure remains isolated and does not reinterpret
  already returned per-item receipts.

The protocol receives already-created records. Observation extraction appends
an `observation`; proposal logic appends a `record_proposal`; promotion appends
a `promotion_event`; a validator runs elsewhere then appends a
`contract_validation`; feedback appends `context_use_feedback`.

### `context/records/get`

Retrieve canonical lifecycle records by exact `record_id`. Define request
limits, ordering, missing-record receipts, scope, sharing, consent, and
unknown-extension behavior. This operation is not semantic search; keep
semantic retrieval in `context/query`.

### `context/resolve`

Resolve an opaque frame `content_ref`. The request includes the content
reference, desired representation, expected canonical content hash, and the
normal caller scope/consent context. Verify the hash before returning content.

Typed failures include:

```text
reference_not_found
reference_expired
scope_denied
sharing_denied
consent_required
content_hash_mismatch
unsupported_representation
```

## Capability negotiation

Use the repository's existing capability mechanism. If it needs an explicit
extension identifier, use:

```text
contextgraph/lifecycle/1.0-draft
```

Advertise at least:

- supported frame representations;
- resolve support;
- supported lifecycle record kinds;
- accepted lifecycle operations;
- maximum frame payload;
- maximum append batch size;
- batch atomicity, if supported;
- retention behavior;
- required consent class;
- unknown-field and unknown-kind round-trip behavior.

Capability support does not imply consent. A host must still authorize the
provider to receive a record at its sharing scope.

## Typed errors

Use repository conventions and cover at least:

```text
unsupported_capability
unsupported_record_kind
unsupported_representation
invalid_record
invalid_temporal_filter
invalid_scope
scope_denied
sharing_denied
consent_required
payload_too_large
batch_too_large
idempotency_conflict
reference_not_found
reference_expired
content_hash_mismatch
retention_rejected
provider_timeout
partial_failure
```

Errors must be machine-readable, stable, and carry safe diagnostic detail. Do
not leak private record content through error messages.

## Compatibility requirements

These are non-negotiable:

- query-only providers remain valid;
- lifecycle capability is optional;
- legacy full ContextFrames continue to deserialize;
- missing `representation` means `full`;
- legacy temporal names are read aliases only;
- unknown extensions round-trip when advertised;
- unknown semantic values never gain instruction authority;
- compact frames preserve identity, citation, temporal meaning, provenance,
  canonical hash, and rehydration linkage;
- reference frames require resolve support;
- a provider's capability never bypasses sharing or consent;
- repeated append is idempotent;
- batch partial failures retain per-item outcomes;
- canonical writers emit lowercase snake_case;
- canonical serialization fixtures assert exact property names.

## Documentation and conformance deliverables

Normal protocol work ships more than Rust structs. Deliver:

1. updated normative protocol documentation;
2. JSON Schema or the repository's equivalent machine-readable schemas;
3. canonical full, compact, and reference frame examples;
4. canonical example for every core record kind and subtype;
5. append, get, resolve, success, duplicate, partial-failure, and error
   fixtures;
6. capability-negotiation examples;
7. compatibility and migration notes;
8. an ADR stating the protocol/product boundary and why `ContextFrame` remains
   atomic;
9. provider and consumer conformance tests;
10. changelog/release notes appropriate for the repository's draft versioning.

The ADR must state:

- full, compact, and reference are representations, not replacement entities;
- `CompiledContextFrame`, snapshots, deltas, and prompt rendering are host
  concerns;
- lifecycle records are immutable exchange facts;
- governance, enforcement authorization, contract execution, inference, and
  pruning remain outside the protocol;
- implementations do not need a graph database—the graph is the semantic model
  of records, provenance, and relationships.

## Verification

Run the repository's documented formatting, lint, test, schema, and conformance
commands. Add tests for:

- canonical snake_case serialization;
- alias input and canonical output;
- unknown kinds and extensions;
- temporal boundary and overlap semantics;
- scope and sharing rejection;
- legacy full-frame compatibility;
- representation preference negotiation;
- full/compact/reference invariants;
- reference resolution and hash mismatch;
- append idempotency and conflict;
- best-effort partial batch failure;
- payload and batch limits;
- query-only provider compatibility;
- lifecycle capability absence;
- a second non-Stella provider fixture.

Do not claim checks passed unless you ran them and saw their results.

## Name and positioning

Keep the project name `context-graph-protocol` and the `contextgraph/*` wire
namespace. Do not mix a rename into this schema/lifecycle change.

Use this positioning sentence in the top-level documentation if consistent
with the repository's current voice:

> Context Graph Protocol is a transport-neutral protocol for querying and
> exchanging provenance-rich context frames and lifecycle records. Providers do
> not need to use a graph database.

The name remains accurate because graph relations, provenance, lineage, and
traversal are first-class. If the protocol ever becomes only a generic prompt
memory API, revisit the name separately.

## Final handoff

Report:

1. types, operations, capabilities, and schemas changed;
2. compatibility decisions and any source-breaking Rust changes;
3. exact tests and commands run with results;
4. new fixtures and conformance coverage;
5. remaining draft decisions;
6. anything intentionally left in Stella/host policy.

The work is complete only when the protocol can exchange these records and
frame representations without prescribing Stella behavior, legacy query-only
providers continue to function, references are honest and verifiable, writes
are idempotent and consent-aware, and the wire schema is documented and tested
independently of Stella.

---
