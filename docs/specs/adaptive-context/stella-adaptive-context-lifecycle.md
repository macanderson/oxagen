# Stella Adaptive Context Lifecycle

**Status:** Draft architecture specification  
**Target product:** Stella  
**Related protocol:** Context Graph Protocol  
**Serialized naming:** lowercase snake_case  
**Canonical record time fields:** observed_at, valid_from, valid_until

## 1. Executive summary

Stella should improve from completed work without requiring a solo developer to
restate every preference, review a daily queue of synthetic pull requests, or
trust opaque model-generated memories.

The system described here creates a closed, evidence-backed learning loop:

~~~text
execution
  -> evidence capture
  -> observation
  -> record proposal for knowledge, a directive, or a contract amendment
  -> governed activation or publication
  -> selection into a compiled context frame
  -> model or tool execution
  -> independently assessed outcome
  -> efficacy, correction, expiry, supersession, or archival
~~~

The design separates six concepts that must not be conflated:

1. **Observations** record that something occurred or was detected.
2. **Knowledge** records facts, assumptions, and decisions.
3. **Memories** preserve bounded historical episodes.
4. **Directives** steer behavior through preferences, rules, constraints, and
   procedures.
5. **Evidence** supports or challenges another record.
6. **Artifact contracts** define and validate the required shape of a
   deliverable.

This separation prevents several common failures:

- a behavior observation cannot silently become an instruction;
- a memory is not treated as a current fact;
- an assumption is not presented as verified knowledge;
- a user preference cannot override a security constraint;
- an inferred directive cannot become blocking without explicit authority;
- a later edit is not automatically treated as proof that the agent was wrong;
- a remembered output requirement can be enforced through a contract rather
  than relying on the model to recall it.

Stella owns learning policy, local storage, trace mining, governance, context
compilation, prompt rendering, artifact validation, and user experience.
Context Graph Protocol owns only portable wire semantics, provider capability
negotiation, temporal and provenance semantics, lifecycle exchange, compact
frame representations, rehydration, errors, and conformance.

The architectural rule is:

> Mechanism in the protocol; policy in the host.

## 2. Decisions

### 2.1 Stella is the learning system

The complete local-first learning loop is implemented in Stella. A new protocol
release is not required for Stella to begin extracting observations, compiling
frames, validating contracts, or governing local directives.

### 2.2 Context Graph Protocol remains general

The protocol may exchange typed records and frame representations, but it does
not decide:

- how many observations are sufficient;
- when confidence is high enough;
- whether a solo developer sees a prompt;
- who approves a repository rule;
- how Stella mines Git;
- how records are stored;
- how unhelpful records are pruned;
- how prompts are rendered.

### 2.3 The protocol ContextFrame remains canonical

Context Graph Protocol already defines ContextFrame as an atomic provider-returned
retrieval item. It remains the canonical protocol frame.

Stella defines a separate CompiledContextFrame: the complete bounded package
assembled for a task invocation from multiple protocol frames, local records,
state, contracts, and code relationships.

~~~text
provider
  -> protocol ContextFrame[]
  -> Stella CompiledContextFrame
  -> Stella PromptContext
  -> model or tool
~~~

### 2.4 Compact context is a projection

Full, compact, and reference are representations of canonical context. Compact
context is never the only authoritative shape. Full records and complete frame
manifests remain available for inspection and rehydration.

### 2.5 Repository rules keep their existing source of truth

Published repository steering remains canonical Markdown under
.stella/rules/*.md. Do not add .stella/context-rules.yaml as a competing
authoritative format.

### 2.6 Promotion is event history, not a directive stage

Directives do not contain a mandatory linear promotion_stage. Solo, team, and
regulated workflows are not the same sequence. Proposals, automatic activations,
confirmations, publications, rejections, and reversions are immutable
PromotionEvent records.

### 2.7 Sharing uses user, repository, and organization

The canonical SharingScope values are:

- user;
- repository;
- organization.

The UI may label user scope as Personal.

Workspace is an applicability and execution boundary, not a durable sharing
boundary. Project is not a portable core scope because no universal project
identity exists.

## 3. Goals

- Give an individual developer durable learning with minimal maintenance.
- Preserve a clean transition from solo to team or regulated governance.
- Keep user-private context private unless explicitly shared.
- Preserve repository steering in normal Git history.
- Learn from traces, journals, working logs, tool results, user corrections,
  verification, artifact validation, and Git diffs.
- Reconstruct what Stella knew and what was applicable at a historical time.
- Compile deterministic, bounded, provenance-rich context frames.
- Produce token-efficient prompt context without destroying canonical data.
- Track which records were selected and whether their use was helpful.
- Detect incomplete deliverables deterministically when contracts exist.
- Distinguish verified errors from inferred behavioral signals.
- Prevent model-authored material from poisoning durable steering.
- Remain local-first with no account or server dependency.
- Preserve Stella's no-phone-home and ports-not-concretions invariants.
- Allow external context providers to interoperate through an optional,
  capability-negotiated protocol extension.

## 4. Non-goals

- Treating everything retained over time as a memory.
- Treating observations as instructions.
- Treating assumptions as facts.
- Treating later Git changes as automatic proof of an error.
- Automatically creating blocking policy from inferred behavior.
- Uploading traces, preferences, source code, or evidence.
- Replacing Stella's rule engine, code graph, execution store, or verifier.
- Making every raw observation retrievable by the model.
- Defining Stella governance inside Context Graph Protocol.
- Requiring GitHub, cloud sync, or organization infrastructure.
- Making cached context snapshots authoritative.
- Solving authorization through learned directives.

Authorization, credentials, consent, and tool permissions remain separate
security mechanisms. Context can describe an applicable policy but cannot grant
itself authority.

## 5. Architecture

### 5.1 Existing Stella boundaries

| Component | Existing responsibility | Added responsibility |
| --- | --- | --- |
| stella-core | Pure agent decisions, mining, rules, budgets | Record semantics, governance decisions, conflict and compaction policy |
| stella-context | Context SQLite store, temporal graph, memories, retrieval, context-use telemetry | Typed lifecycle records, frame compiler, rehydration, efficacy |
| stella-store | Executions, events, tools, telemetry, reflections | Read-only evidence source and extraction cursors |
| stella-store::journal | Append-only session journal and replay | Idempotent observation extraction source |
| stella-graph | Source-code graph | Code and Git anchors for observations and frames |
| stella-pipeline | Triage, plan, witness, execute, verify, judge | Contract matching, deterministic validation, outcome assessment |
| stella-protocol | Internal AgentEvent stream | Additive context-lifecycle events |
| stella-cli | Workspace, filesystem, Git, protocol host | Harvesting, context commands, rule publication |
| stella-tui | Interactive agent experience | Keep, Edit, Ignore, Share, and contract-failure actions |
| stella-observatory | Execution inspection | Context lineage, health, evidence, promotions, contracts |

### 5.2 Storage boundaries

~~~text
.stella/
  context.db                 # lifecycle records and context graph
  store.db                   # executions, tools, telemetry, operational events
  codegraph.db               # source-code graph
  settings.json              # governance, retention, and sharing configuration
  reflections.jsonl          # compatibility input for observation extraction
  rules/                     # canonical published repository steering
    api-integration-coverage.md
  context-snapshots/         # disposable cache, gitignored
~~~

Rules:

1. Raw execution data remains in store.db or the journal.
2. Normalized context records live in context.db.
3. Codegraph.db is the only source of code-graph truth.
4. Confirmed repository directives are published to .stella/rules/*.md.
5. Personal records never appear in repository files automatically.
6. Context snapshots are derived, content-addressed, and disposable.
7. The same logical record must not have two editable sources of truth.

## 6. Canonical vocabulary

### 6.1 ContextRecord

ContextRecord is the umbrella wire and storage concept. It describes a typed,
addressable unit in the context lifecycle.

Core record kinds are:

- observation;
- knowledge;
- memory;
- directive;
- record_proposal;
- evidence;
- artifact_contract;
- contract_validation;
- outcome_assessment;
- promotion_event;
- context_use;
- context_use_feedback.

Some records are claims with a validity interval. Others are immutable events.
The protocol must not force meaningless valid intervals onto events.

### 6.2 Observation

An Observation records that something happened or was detected. It has no
instruction authority.

Examples:

- the user added an integration test after an API change;
- an artifact validator found a missing wordmark;
- a witness test failed;
- a user rejected an inferred preference;
- a guard prevented a dangerous action.

Observations are immutable. A correction or contradiction is a new observation
linked to the original.

### 6.3 Knowledge

Knowledge represents a current epistemic claim. KnowledgeKind has exactly these
portable core values:

- fact;
- assumption;
- decision.

#### Fact

A Fact is an assertion believed true within a scope and validity interval.

Example: The analytics service deploys in us-west-2.

#### Assumption

An Assumption is a provisional claim that must not be presented as verified.
It should identify how it can be validated or what would invalidate it.

Example: The upstream API remains backward compatible.

#### Decision

A Decision records a choice, its rationale, considered alternatives, and
whether it remains current.

Example: Use PostgreSQL rather than DynamoDB for analytics.

Definitions, conventions about reality, and current architecture can normally
be modeled as facts or decisions. Do not create a new kind for every noun.

### 6.4 Memory

A Memory preserves a bounded historical episode. It answers what happened, not
what is currently true and not what must happen next.

Examples:

- a previous deployment failed because migrations ran out of order;
- the user rejected a particular brand direction;
- a task required three recovery attempts before verification passed.

Portable MemoryKind values are:

- episode: a bounded recollection of one task, session, or event;
- summary: a lossy synthesis across multiple episodes.

Unknown memory kinds remain non-instructional.

A useful lesson extracted from a memory becomes Knowledge or a Directive with
evidence pointing back to the Memory. The lesson does not mutate the original
episode.

### 6.5 Directive

A Directive is durable steering. DirectiveKind has exactly these portable core
values:

- preference;
- rule;
- constraint;
- procedure.

#### Preference

Desired but non-mandatory behavior.

Example: Prefer concise status updates.

#### Rule

A general normative instruction.

Example: API endpoint changes should include integration coverage.

#### Constraint

A hard requirement or prohibition. Constraint effects are:

- require;
- forbid.

Allow is deliberately excluded. Learned context cannot grant authorization.

Example: Never include PII in logs.

#### Procedure

An ordered workflow whose sequence matters.

Example: Run tests, inspect failures, obtain approval, then deploy.

Policies, guidelines, requirements, prohibitions, conventions, and workflows
are expressed through these kinds plus scope, enforcement, conditions, and
effect. They are not separate directive kinds.

### 6.6 Evidence

Evidence is an immutable addressable source supporting or challenging another
record. Examples include:

- trace events;
- journal entries;
- user feedback;
- file spans;
- Git hunks;
- test results;
- validator results;
- policy documents;
- accepted artifacts.

Large evidence remains at its source and is addressed by locator and hash.

### 6.7 ArtifactContract

An ArtifactContract is a versioned, reusable, machine-checkable definition of
an acceptable deliverable. It is separate from a Procedure:

- a procedure says how to work;
- a contract says what the completed result must satisfy.

### 6.8 OutcomeAssessment

An OutcomeAssessment states what can responsibly be concluded about a task or
artifact. It keeps two independent dimensions:

- completion status: complete, incomplete, or unknown;
- correctness status: correct, incorrect, or unknown.

Each dimension has its own assessment level:

- verified;
- user_confirmed;
- externally_confirmed;
- inferred;
- unknown.

### 6.9 RecordProposal

A RecordProposal is proposed knowledge, steering, or a contract amendment
supported by observations and evidence. It has no truth or instruction
authority until Stella's governance policy accepts or activates it.

A proposal can target a Knowledge record, a Directive, or an ArtifactContract
amendment. ProposalKind values are:

- knowledge;
- directive;
- contract_amendment.

### 6.10 PromotionEvent

A PromotionEvent records governance history. Actions are:

- proposed;
- auto_activated;
- confirmed;
- published;
- rejected;
- retired;
- reverted.

Promotion is not assumed to be a single linear state machine.

### 6.11 Context frame terms

- **ContextFrame:** canonical atomic retrieval item defined by Context Graph
  Protocol.
- **CompiledContextFrame:** Stella's complete bounded task-specific package.
- **PromptContext:** the final token-optimized rendering supplied to a model.
- **FrameManifest:** immutable explanation of inputs, selections, exclusions,
  conflicts, representation changes, and budgets.

## 7. Common schema

### 7.1 Primitive rules

- IDs are opaque stable strings.
- Timestamps are RFC 3339 UTC strings.
- Serialized property names are lowercase snake_case.
- Confidence is an integer from 0 through 100.
- Half-open intervals use [from, until).
- Empty strings do not substitute for absent values.
- Extension properties are namespaced.
- Record bodies and evidence are content-addressed when practical.

### 7.2 Scope

Scope answers: Where does this record apply?

~~~json
{
  "user_id": "usr_01",
  "organization_id": "org_oxagen",
  "repository_id": "repo_stella",
  "workspace_id": "wrk_feature_checkout",
  "environment_id": "env_local",
  "session_id": "ses_01",
  "task_id": "task_01"
}
~~~

Definitions:

- user_id identifies a person or private agent principal;
- organization_id identifies a durable administrative organization;
- repository_id identifies a canonical VCS repository independent of branch,
  path, checkout, or worktree;
- workspace_id identifies the current local or mounted working set and may
  contain one or more repositories;
- environment_id identifies runtime context such as local, staging, or
  production;
- session_id identifies one agent session;
- task_id identifies one unit of requested work.

Project is not a portable core field. If a host has a canonical cross-repository
project registry, it may use a namespaced extension such as
extensions.oxagen.project_id. A directory name, IDE project, or GitHub Project
must never be silently treated as the same identity.

An unscoped inferred record is invalid. Scope never widens automatically.

### 7.3 SharingScope

SharingScope answers: Who may receive or inherit this record?

Allowed values:

- user: private to the identified user;
- repository: shareable through explicit repository publication;
- organization: inherited from or published through approved organization
  policy.

Workspace is not a SharingScope. A workspace is an execution boundary and can
be ephemeral.

### 7.4 Temporal fields

Claim-bearing records use:

- observed_at: when Stella first recorded this version of the claim;
- valid_from: when the claim became applicable in the represented world;
- valid_until: exclusive end of applicability, or absent when unknown.

Event records require observed_at and use valid_from or valid_until only when
the event describes a real applicability interval.

Canonical writers emit only these names. Compatibility readers may accept
recorded_at as an alias for observed_at and valid_to as an alias for
valid_until during the draft migration.

### 7.5 Temporal query

Point-in-time reconstruction:

~~~json
{
  "temporal": {
    "known_at": "2026-07-20T18:00:00Z",
    "valid_at": "2026-07-15T00:00:00Z"
  }
}
~~~

This means: return records Stella knew by July 20 that were applicable on July
15.

Range filtering:

~~~json
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
~~~

Semantics:

- known_at selects records with observed_at less than or equal to the cutoff;
- valid_at selects records whose validity contains the instant;
- observed selects records whose observed_at lies in [from, until);
- valid_overlaps selects records whose validity interval overlaps the query
  interval.

Do not use valid_after or valid_before without naming which endpoint is tested.
Those names are ambiguous.

### 7.6 Record envelope

~~~json
{
  "schema_version": "1.0-draft",
  "record_id": "rec_01",
  "lineage_id": "lin_01",
  "record_kind": "knowledge",
  "record_status": "active",
  "scope": {
    "repository_id": "repo_stella"
  },
  "sharing_scope": "repository",
  "observed_at": "2026-07-20T18:00:00Z",
  "valid_from": "2026-07-20T18:00:00Z",
  "valid_until": null,
  "evidence_links": [
    {
      "evidence_id": "ev_01",
      "relation": "supports"
    }
  ],
  "record_links": [],
  "supersedes_record_id": null,
  "record_hash": "sha256:...",
  "provenance": {},
  "extensions": {}
}
~~~

record_id identifies one immutable revision. lineage_id identifies the
conceptual record across revisions. supersedes_record_id links a revision to
its immediate predecessor.

Requiredness:

| Property | Requirement |
| --- | --- |
| schema_version | Required on every record |
| record_id | Required on every record |
| record_kind | Required on every record |
| observed_at | Required on every record |
| scope | Required and nonempty on every persisted record |
| sharing_scope | Required on every persisted record |
| record_hash | Required on canonical stored or exchanged records |
| lineage_id | Required on revision-bearing knowledge, memory, directives, proposals, and contracts |
| record_status | Required on revision-bearing claim or steering records |
| valid_from | Required on knowledge, directives, and artifact contracts |
| valid_until | Optional exclusive end of applicability |
| confidence | Optional integer from 0 through 100 |
| evidence_links | Optional typed relationships to Evidence records |
| record_links | Optional typed relationships to arbitrary records |
| supersedes_record_id | Optional immediate predecessor within the same lineage |
| provenance | Optional only when type-specific actor and source fields fully identify provenance |
| extensions | Optional namespaced extension object |

`record_hash` is the SHA-256 digest of the canonical record serialization with
the `record_hash` property itself omitted. All semantic fields, provenance,
links, and extensions participate. Transport metadata such as an append
idempotency key does not. An append input may omit the hash and let the provider
compute it; if supplied, the provider verifies it. Canonical reads emit it.

RecordStatus values are active, superseded, retracted, and archived. Expiration
is derived from valid_until. Staleness is a host retrieval-health assessment,
not canonical record status.

Fields that have no meaning for a record kind are omitted rather than emitted
as empty placeholders.

Portable JSON uses a flat discriminated union: `record_kind` selects the
type-specific schema and type-specific properties remain at the record's top
level. Implementations may store those properties in an internal
`payload_json` column, but `payload` is not an additional portable wire
envelope. Unknown top-level properties must either be preserved losslessly or
rejected explicitly; they must never be silently discarded.

An evidence link is directional from the evidence to the enclosing record.
Portable relation values are supports, contradicts, validates, invalidates,
and source. Additional relations are namespaced extensions. `record_links` is
reserved for relationships between arbitrary records; do not use a flat list
of evidence IDs when the evidentiary relationship matters.

## 8. Record schemas

### 8.1 Observation

~~~json
{
  "schema_version": "1.0-draft",
  "record_id": "obs_brand_wordmark_missing",
  "record_kind": "observation",
  "observation_kind": "artifact_contract_failure",
  "actor_ref": "agent_default",
  "subject_ref": "contract_brand_kit_v3",
  "predicate": "missing_required_artifact",
  "object": {
    "path": "logos/wordmark.svg",
    "requirement_id": "brand_wordmark_svg"
  },
  "source_kind": "artifact_validator",
  "source_ref": "validation_01",
  "scope": {
    "user_id": "usr_01",
    "repository_id": "repo_brand"
  },
  "sharing_scope": "user",
  "sensitivity": "private",
  "confidence": 100,
  "evidence_links": [
    {
      "evidence_id": "ev_manifest_01",
      "relation": "supports"
    }
  ],
  "occurred_at": "2026-07-20T18:10:00Z",
  "observed_at": "2026-07-20T18:10:00Z",
  "source_fingerprint": "sha256:source...",
  "record_hash": "sha256:record..."
}
~~~

Core observation kinds include:

- user_correction;
- user_acceptance;
- user_rejection;
- repeated_action;
- repeated_omission;
- tool_failure;
- tool_recovery;
- verification_pass;
- verification_failure;
- artifact_contract_pass;
- artifact_contract_failure;
- git_followup_change;
- directive_conflict;
- context_helpful;
- context_not_helpful.

Observation kinds are extensible strings. Unknown kinds remain evidence-only.

### 8.2 Knowledge: fact

~~~json
{
  "schema_version": "1.0-draft",
  "record_id": "kn_region_01_v1",
  "lineage_id": "lin_region_01",
  "record_kind": "knowledge",
  "record_status": "active",
  "knowledge_kind": "fact",
  "statement": "The analytics API deploys in us-west-2.",
  "value": {
    "service": "analytics-api",
    "region": "us-west-2"
  },
  "subject_refs": [
    "service_analytics_api"
  ],
  "origin": "imported",
  "confidence": 100,
  "scope": {
    "repository_id": "repo_analytics"
  },
  "sharing_scope": "repository",
  "evidence_links": [
    {
      "evidence_id": "ev_deployment_config",
      "relation": "supports"
    }
  ],
  "observed_at": "2026-07-20T18:00:00Z",
  "valid_from": "2026-07-01T00:00:00Z",
  "valid_until": null,
  "supersedes_record_id": null,
  "record_hash": "sha256:record..."
}
~~~

### 8.3 Knowledge: assumption

~~~json
{
  "schema_version": "1.0-draft",
  "record_id": "kn_api_compatibility_assumption_v1",
  "lineage_id": "lin_api_compatibility_assumption",
  "record_kind": "knowledge",
  "record_status": "active",
  "knowledge_kind": "assumption",
  "statement": "The upstream API remains backward compatible for this change.",
  "value": {
    "validation_method": "run_contract_tests",
    "invalidated_by": "breaking_schema_diff"
  },
  "origin": "inferred",
  "confidence": 60,
  "scope": {
    "repository_id": "repo_stella",
    "task_id": "task_01"
  },
  "sharing_scope": "user",
  "evidence_links": [],
  "observed_at": "2026-07-20T18:00:00Z",
  "valid_from": "2026-07-20T18:00:00Z",
  "valid_until": "2026-07-21T18:00:00Z",
  "record_hash": "sha256:record..."
}
~~~

Assumptions must be visibly labeled in every rendered representation.

### 8.4 Knowledge: decision

~~~json
{
  "schema_version": "1.0-draft",
  "record_id": "kn_database_decision_v1",
  "lineage_id": "lin_database_decision",
  "record_kind": "knowledge",
  "record_status": "active",
  "knowledge_kind": "decision",
  "statement": "Use PostgreSQL for the analytics service.",
  "value": {
    "rationale": "Transactional queries and existing operational expertise.",
    "alternatives": [
      "DynamoDB",
      "ClickHouse"
    ],
    "decision_state": "current"
  },
  "origin": "user",
  "confidence": 100,
  "scope": {
    "repository_id": "repo_analytics"
  },
  "sharing_scope": "repository",
  "evidence_links": [
    {
      "evidence_id": "ev_architecture_discussion",
      "relation": "supports"
    }
  ],
  "observed_at": "2026-07-20T18:00:00Z",
  "valid_from": "2026-07-20T18:00:00Z",
  "valid_until": null,
  "record_hash": "sha256:record..."
}
~~~

### 8.5 Memory

~~~json
{
  "schema_version": "1.0-draft",
  "record_id": "mem_deploy_failure_01",
  "lineage_id": "lin_deploy_failure_01",
  "record_kind": "memory",
  "record_status": "active",
  "memory_kind": "episode",
  "summary": "A previous deployment failed because migrations ran out of order.",
  "event_refs": [
    "event_tool_91",
    "event_verify_92"
  ],
  "participant_refs": [
    "usr_01",
    "agent_default"
  ],
  "outcome_ref": "outcome_deploy_01",
  "salience": 88,
  "origin": "observed",
  "scope": {
    "repository_id": "repo_analytics"
  },
  "sharing_scope": "user",
  "evidence_links": [
    {
      "evidence_id": "ev_journal_deploy_01",
      "relation": "supports"
    }
  ],
  "observed_at": "2026-07-20T18:00:00Z",
  "occurred_at": "2026-07-19T20:00:00Z",
  "occurred_until": "2026-07-19T21:15:00Z",
  "record_hash": "sha256:record..."
}
~~~

Memory occurrence fields describe the episode interval. They do not assert that
every statement in the episode remains currently true. A summary memory lists
source_memory_ids and identifies its summarizer and content hashes.

### 8.6 Directive

~~~json
{
  "schema_version": "1.0-draft",
  "record_id": "dir_api_integration_coverage_v1",
  "lineage_id": "lin_api_integration_coverage",
  "record_kind": "directive",
  "record_status": "active",
  "directive_kind": "rule",
  "statement": "API endpoint changes should include integration coverage.",
  "value": {
    "applies_when": {
      "changed_paths": [
        "src/api/**"
      ]
    },
    "expected_action": "add_or_update_integration_test"
  },
  "origin": "inferred",
  "priority": "high",
  "confidence": 91,
  "enforcement": "advisory",
  "scope": {
    "repository_id": "repo_stella"
  },
  "sharing_scope": "user",
  "evidence_links": [
    {
      "evidence_id": "ev_task_101",
      "relation": "supports"
    },
    {
      "evidence_id": "ev_task_118",
      "relation": "supports"
    },
    {
      "evidence_id": "ev_task_144",
      "relation": "supports"
    }
  ],
  "observed_at": "2026-07-20T18:30:00Z",
  "valid_from": "2026-07-20T18:30:00Z",
  "valid_until": null,
  "review_after": "2027-01-16T18:30:00Z",
  "supersedes_record_id": null,
  "record_hash": "sha256:record..."
}
~~~

Allowed values:

- directive_kind: preference, rule, constraint, procedure;
- origin: user, system, inferred, imported;
- priority: low, normal, high, critical;
- enforcement: advisory, blocking;
- record_status: active, superseded, retracted, archived.

Invariants:

1. Inferred directives begin advisory.
2. Inferred directives never become blocking without explicit confirmation.
3. User-shared directives never publish automatically.
4. A repository-shared directive never promotes to organization automatically.
5. A blocking constraint has an enforceable boundary or explicitly declares
   that enforcement remains prompt-only.
6. Procedures preserve ordered steps.
7. Preferences never override constraints.
8. Authorization cannot be granted by a directive.

### 8.7 Constraint example

~~~json
{
  "schema_version": "1.0-draft",
  "record_id": "dir_no_pii_logs_v1",
  "lineage_id": "lin_no_pii_logs",
  "record_kind": "directive",
  "record_status": "active",
  "directive_kind": "constraint",
  "statement": "Do not include personally identifiable information in logs.",
  "value": {
    "effect": "forbid",
    "target": "log_output",
    "condition": "content contains pii"
  },
  "origin": "system",
  "priority": "critical",
  "confidence": 100,
  "enforcement": "blocking",
  "scope": {
    "organization_id": "org_oxagen"
  },
  "sharing_scope": "organization",
  "evidence_links": [
    {
      "evidence_id": "ev_security_policy_01",
      "relation": "supports"
    }
  ],
  "observed_at": "2026-07-20T18:00:00Z",
  "valid_from": "2026-07-01T00:00:00Z",
  "valid_until": null,
  "record_hash": "sha256:record..."
}
~~~

### 8.8 Procedure example

~~~json
{
  "schema_version": "1.0-draft",
  "record_id": "dir_release_procedure_v1",
  "lineage_id": "lin_release_procedure",
  "record_kind": "directive",
  "record_status": "active",
  "directive_kind": "procedure",
  "statement": "Test, inspect failures, obtain approval, then deploy.",
  "value": {
    "steps": [
      {
        "order": 1,
        "action": "run_tests"
      },
      {
        "order": 2,
        "action": "inspect_failures"
      },
      {
        "order": 3,
        "action": "obtain_approval"
      },
      {
        "order": 4,
        "action": "deploy"
      }
    ]
  },
  "origin": "user",
  "priority": "high",
  "confidence": 100,
  "enforcement": "advisory",
  "scope": {
    "repository_id": "repo_analytics"
  },
  "sharing_scope": "repository",
  "evidence_links": [],
  "observed_at": "2026-07-20T18:00:00Z",
  "valid_from": "2026-07-20T18:00:00Z",
  "valid_until": null,
  "record_hash": "sha256:record..."
}
~~~

### 8.9 RecordProposal

~~~json
{
  "schema_version": "1.0-draft",
  "record_id": "prop_api_integration_coverage",
  "lineage_id": "lin_prop_api_integration_coverage",
  "record_kind": "record_proposal",
  "record_status": "active",
  "proposal_kind": "directive",
  "proposed_record": {
    "record_kind": "directive",
    "directive_kind": "rule",
    "statement": "API endpoint changes should include integration coverage.",
    "enforcement": "advisory",
    "scope": {
      "repository_id": "repo_stella"
    },
    "sharing_scope": "user"
  },
  "supporting_observation_ids": [
    "obs_101",
    "obs_118",
    "obs_144"
  ],
  "contradicting_observation_ids": [],
  "distinct_task_count": 3,
  "confidence": 91,
  "proposal_status": "eligible",
  "scope": {
    "repository_id": "repo_stella"
  },
  "sharing_scope": "user",
  "observed_at": "2026-07-20T18:30:00Z",
  "proposal_expires_at": "2026-08-19T18:30:00Z",
  "supersedes_record_id": null,
  "record_hash": "sha256:record..."
}
~~~

Proposal statuses are:

- collecting;
- eligible;
- dismissed;
- expired.

Activation and rejection are PromotionEvent outcomes, not proposal states.
This avoids storing the same lifecycle fact in two places. A proposal is
dismissed only when it should no longer be considered; its immutable promotion
history remains available.

Repeated events from one task do not count as independent support. The default
promotion threshold counts distinct tasks or episodes unless deterministic
evidence or explicit user feedback marks one event as sufficiently salient.

The proposal's sharing_scope describes who may see the proposal. The proposed
record's sharing_scope describes the requested publication boundary. Publishing
still requires governance.

### 8.10 PromotionEvent

~~~json
{
  "schema_version": "1.0-draft",
  "record_id": "prom_api_tests_01",
  "record_kind": "promotion_event",
  "proposal_id": "prop_api_integration_coverage",
  "result_record_id": "dir_api_integration_coverage_v1",
  "action": "confirmed",
  "actor_ref": "usr_01",
  "from_sharing_scope": "user",
  "to_sharing_scope": "user",
  "reason": "Confirmed after three independent observations.",
  "evidence_links": [
    {
      "evidence_id": "ev_user_keep_action",
      "relation": "supports"
    }
  ],
  "scope": {
    "repository_id": "repo_stella"
  },
  "sharing_scope": "user",
  "observed_at": "2026-07-20T18:45:00Z",
  "record_hash": "sha256:record..."
}
~~~

Promotion events are immutable. The current governance state is derived from
events and the current record; it is not represented by a universal
promotion_stage field.

Promotion actions are proposed, auto_activated, confirmed, published,
rejected, retired, and reverted. `auto_activated` is permitted only for an
advisory directive under the active governance policy. `confirmed` records an
explicit user decision. `published` changes a sharing boundary; it does not
change semantic content.

### 8.11 Evidence

~~~json
{
  "schema_version": "1.0-draft",
  "record_id": "ev_git_01",
  "record_kind": "evidence",
  "source_kind": "git_diff",
  "source_ref": "git:4ac2f9e",
  "locator": {
    "path": "tests/api_routes.rs",
    "line_start": 82,
    "line_end": 119,
    "commit": "4ac2f9e"
  },
  "content_hash": "sha256:...",
  "excerpt": "Adds an integration test for the changed route.",
  "trust": "workspace_artifact",
  "sensitivity": "repository",
  "retention": "durable",
  "scope": {
    "repository_id": "repo_stella"
  },
  "sharing_scope": "repository",
  "observed_at": "2026-07-20T18:20:00Z",
  "record_hash": "sha256:record..."
}
~~~

Evidence source kinds include:

- user_feedback;
- trace_event;
- journal_entry;
- tool_result;
- file_span;
- git_diff;
- commit;
- verification_result;
- contract_validation;
- policy_document;
- external_result.

Excerpts are bounded. Secrets are redacted before persistence, indexing, or
embedding.

### 8.12 ArtifactContract

~~~json
{
  "schema_version": "1.0-draft",
  "record_id": "contract_brand_kit_v3",
  "lineage_id": "lin_contract_brand_kit",
  "record_kind": "artifact_contract",
  "name": "brand_kit",
  "version": 3,
  "description": "Complete reusable brand-kit deliverable.",
  "scope": {
    "user_id": "usr_01"
  },
  "sharing_scope": "user",
  "applies_when": {
    "task_intents": [
      "create_brand_kit",
      "refresh_brand_assets"
    ]
  },
  "output_root": "brand/",
  "requirements": [
    {
      "requirement_id": "brand_readme",
      "requirement_kind": "file_exists",
      "path": "README.md",
      "required": true
    },
    {
      "requirement_id": "brand_logo_svg",
      "requirement_kind": "file_exists",
      "path": "logos/logo.svg",
      "required": true
    },
    {
      "requirement_id": "brand_wordmark_svg",
      "requirement_kind": "file_exists",
      "path": "logos/wordmark.svg",
      "required": true
    },
    {
      "requirement_id": "brand_mark_svg",
      "requirement_kind": "file_exists",
      "path": "logos/mark.svg",
      "required": true
    },
    {
      "requirement_id": "brand_png_variants",
      "requirement_kind": "glob_min_count",
      "glob": "logos/png/**/*.png",
      "minimum": 6,
      "required": true
    },
    {
      "requirement_id": "brand_favicons",
      "requirement_kind": "glob_min_count",
      "glob": "favicons/*",
      "minimum": 4,
      "required": true
    },
    {
      "requirement_id": "brand_tokens",
      "requirement_kind": "json_schema",
      "path": "tokens/brand.tokens.json",
      "schema_ref": "stella://contracts/design-tokens/v1",
      "required": true
    },
    {
      "requirement_id": "brand_guidelines",
      "requirement_kind": "markdown_sections",
      "path": "BRAND_GUIDELINES.md",
      "sections": [
        "Logo usage",
        "Color",
        "Typography",
        "Spacing",
        "Accessibility",
        "File inventory"
      ],
      "required": true
    }
  ],
  "presentation": {
    "include_manifest": true,
    "include_preview_sheet": true,
    "directory_order": [
      "logos",
      "favicons",
      "social",
      "tokens",
      "templates"
    ]
  },
  "record_status": "active",
  "observed_at": "2026-07-20T17:00:00Z",
  "valid_from": "2026-07-20T17:00:00Z",
  "valid_until": null,
  "record_hash": "sha256:record..."
}
~~~

Core requirement kinds include:

- file_exists;
- directory_exists;
- glob_min_count;
- mime_type;
- image_dimensions;
- file_size;
- json_schema;
- markdown_sections;
- command;
- semantic_judge.

Requirement kinds are extensible. Deterministic validators run before semantic
judges. A semantic result records model identity, prompt version, input hash,
cost, and confidence.

### 8.13 ContractValidation

~~~json
{
  "schema_version": "1.0-draft",
  "record_id": "validation_brand_01",
  "record_kind": "contract_validation",
  "contract_id": "contract_brand_kit_v3",
  "contract_version": 3,
  "task_id": "task_brand_21",
  "artifact_root": "brand/",
  "validation_status": "failed",
  "results": [
    {
      "requirement_id": "brand_logo_svg",
      "requirement_status": "passed",
      "method": "deterministic"
    },
    {
      "requirement_id": "brand_wordmark_svg",
      "requirement_status": "failed",
      "method": "deterministic",
      "message": "logos/wordmark.svg was not found"
    }
  ],
  "evidence_links": [
    {
      "evidence_id": "ev_manifest_01",
      "relation": "supports"
    }
  ],
  "scope": {
    "user_id": "usr_01",
    "repository_id": "repo_brand",
    "task_id": "task_brand_21"
  },
  "sharing_scope": "user",
  "observed_at": "2026-07-20T18:10:00Z",
  "record_hash": "sha256:record..."
}
~~~

Validation statuses are passed, failed, error, and skipped.

### 8.14 OutcomeAssessment

~~~json
{
  "schema_version": "1.0-draft",
  "record_id": "outcome_task_brand_21",
  "record_kind": "outcome_assessment",
  "task_id": "task_brand_21",
  "completion_assessment": {
    "status": "incomplete",
    "assessment_level": "verified"
  },
  "correctness_assessment": {
    "status": "unknown",
    "assessment_level": "unknown"
  },
  "reasons": [
    {
      "reason_kind": "contract_failure",
      "record_ref": "validation_brand_01"
    }
  ],
  "user_feedback_ref": null,
  "final_artifact_ref": null,
  "evidence_links": [
    {
      "evidence_id": "ev_manifest_01",
      "relation": "supports"
    }
  ],
  "scope": {
    "user_id": "usr_01",
    "repository_id": "repo_brand",
    "task_id": "task_brand_21"
  },
  "sharing_scope": "user",
  "observed_at": "2026-07-20T18:10:00Z",
  "record_hash": "sha256:record..."
}
~~~

Completion status values are complete, incomplete, and unknown. Correctness
status values are correct, incorrect, and unknown. Completion and correctness
are independent: a complete deliverable can be wrong, and a correct partial
artifact can be incomplete. Each dimension carries its own assessment level.

Stella may call an output incomplete when a required contract check fails.
Stella may call an output inaccurate only when a trusted test, validator,
fact-check, external result, or explicit user correction supports that
conclusion.

### 8.15 ContextUse and ContextUseFeedback

~~~json
{
  "schema_version": "1.0-draft",
  "record_id": "use_01",
  "record_kind": "context_use",
  "frame_id": "frame_01",
  "context_record_id": "dir_api_integration_coverage_v1",
  "task_id": "task_200",
  "invocation_id": "inv_04",
  "use_kind": "rendered",
  "selection_reason": "changed paths matched src/api/**",
  "scope": {
    "user_id": "usr_01",
    "repository_id": "repo_stella",
    "task_id": "task_200"
  },
  "sharing_scope": "user",
  "observed_at": "2026-07-20T18:55:00Z",
  "record_hash": "sha256:record..."
}
~~~

UseKind values are selected, rendered, and cited. They are separate because an
item can be selected into a frame without reaching the prompt, or rendered
without being explicitly cited by the response.

~~~json
{
  "schema_version": "1.0-draft",
  "record_id": "use_feedback_01",
  "record_kind": "context_use_feedback",
  "context_use_id": "use_01",
  "evaluation": "helpful",
  "evaluation_method": "contract_and_user_acceptance",
  "attribution_confidence": 87,
  "had_opportunity": true,
  "evaluator_ref": "stella_outcome_attributor_v1",
  "scope": {
    "user_id": "usr_01",
    "repository_id": "repo_stella",
    "task_id": "task_200"
  },
  "sharing_scope": "user",
  "observed_at": "2026-07-20T19:00:00Z",
  "record_hash": "sha256:record..."
}
~~~

Evaluation values are helpful, not_helpful, and neutral. An unsuccessful task
does not make every cited item unhelpful. Negative attribution requires a
plausible opportunity for the item to influence the failed outcome.

Derived health aggregates include:

- opportunity_count;
- selected_count;
- rendered_count;
- cited_count;
- evaluated_count;
- helpful_count;
- not_helpful_count;
- neutral_count;
- last_cited_at;
- last_helpful_at;
- last_not_helpful_at.

Immutable use and feedback records remain the source of truth.

## 9. CompiledContextFrame

### 9.1 Purpose

CompiledContextFrame is Stella's immutable, bounded input package for one model
or tool invocation. It is assembled from canonical records and provider
ContextFrames. It is not the durable record store.

### 9.2 Logical schema

~~~json
{
  "schema_version": "1.0-draft",
  "frame_id": "frame_brand_22",
  "task": {
    "task_id": "task_brand_22",
    "goal": "Create a complete brand kit.",
    "success_criteria": [
      "All required contract checks pass."
    ]
  },
  "state": {
    "phase": "execute",
    "plan_step": 3,
    "open_questions": [],
    "recent_event_refs": [
      "event_201"
    ]
  },
  "scope": {
    "user_id": "usr_01",
    "repository_id": "repo_brand",
    "workspace_id": "wrk_brand_checkout",
    "session_id": "ses_22",
    "task_id": "task_brand_22"
  },
  "temporal": {
    "known_at": "2026-07-20T20:00:00Z",
    "valid_at": "2026-07-20T20:00:00Z"
  },
  "knowledge": [
    {
      "record_id": "kn_brand_svg_fact",
      "knowledge_kind": "decision",
      "content": "Editable SVG masters are required.",
      "representation": "compact",
      "citation_label": "Brand decision: editable SVG masters",
      "selection_reason": "task intent and user scope matched",
      "token_cost": 12
    }
  ],
  "memories": [
    {
      "record_id": "mem_rejected_logo_direction",
      "memory_kind": "episode",
      "content": "The previous generic logo direction was rejected in favor of a terminal-native direction.",
      "representation": "compact",
      "citation_label": "Brand episode: rejected logo direction",
      "selection_reason": "brand task and user scope matched",
      "token_cost": 22
    }
  ],
  "directives": [
    {
      "record_id": "dir_brand_completion",
      "directive_kind": "constraint",
      "content": "Do not declare completion until the brand-kit contract passes.",
      "representation": "full",
      "required": true,
      "citation_label": "Brand completion constraint",
      "selection_reason": "contract is required for this intent",
      "token_cost": 15
    }
  ],
  "observation_summaries": [],
  "artifact_contracts": [
    {
      "record_id": "contract_brand_kit_v3",
      "version": 3,
      "representation": "reference",
      "content_fidelity": "omitted",
      "content_ref": {
        "uri": "context://local/artifact_contract/contract_brand_kit_v3"
      },
      "canonical_content_hash": "sha256:...",
      "required": true,
      "selection_reason": "task intent matched create_brand_kit"
    }
  ],
  "code_map": {
    "nodes": [],
    "edges": [],
    "root_refs": []
  },
  "evidence_refs": [
    {
      "record_id": "ev_user_confirmation_09",
      "citation_label": "User-confirmed brand-kit requirements"
    }
  ],
  "manifest": {
    "compiler_version": "stella-context-frame/1.0-draft",
    "input_hash": "sha256:...",
    "budget": {
      "max_tokens": 8000,
      "used_tokens": 5240
    },
    "included_record_ids": [
      "kn_brand_svg_fact",
      "mem_rejected_logo_direction",
      "dir_brand_completion",
      "contract_brand_kit_v3"
    ],
    "excluded": [
      {
        "record_id": "dir_old_brand_shape",
        "reason": "superseded"
      }
    ],
    "conflicts": [],
    "provider_query_refs": [],
    "snapshot_ref": null
  },
  "compiled_at": "2026-07-20T20:00:00Z"
}
~~~

### 9.3 Frame invariants

- Identical inputs, cutoffs, compiler version, and budget produce byte-stable
  ordering and content.
- Every included item has a stable record ID and selection reason.
- Every transformed item identifies its representation and canonical source.
- Required items cannot be evicted.
- Assumptions are visibly labeled.
- Observations have no instruction authority.
- Conflicts and exclusions are recorded rather than silently discarded.
- Late feedback appends ContextUseFeedback or OutcomeAssessment records and never
  mutates the historical frame.

## 10. Compaction

### 10.1 Three layers

Compaction occurs at three different layers:

1. **Canonical record:** complete structured source of truth.
2. **Frame representation:** full, compact, or reference projection.
3. **PromptContext:** model-specific concise text rendered by Stella.

Wire compression such as gzip reduces bytes but not model tokens. Semantic
compaction comes from selection, deduplication, summaries, references, and
stable-prefix reuse.

### 10.2 Frame representations

Allowed representation values:

- full: complete inline content;
- compact: shorter inline content linked to the canonical source;
- reference: stable reference and hash without inline content.

Compact and reference representations carry:

- content_fidelity;
- content_hash;
- canonical_content_hash;
- content_ref;
- canonical_token_cost;
- token_cost;
- minimum_fidelity;
- transform metadata.

ContentFidelity values are exact, normalized, summarized, and omitted.
Representation and fidelity are separate: a compact frame may retain the exact
text of a constraint while omitting heavyweight metadata.

Example:

~~~json
{
  "record_id": "mem_rejected_logo_direction",
  "representation": "compact",
  "content_fidelity": "summarized",
  "content": "Previous generic logo rejected; prefer terminal-native direction.",
  "content_hash": "sha256:compact...",
  "canonical_content_hash": "sha256:canonical...",
  "canonical_token_cost": 91,
  "token_cost": 12,
  "content_ref": {
    "uri": "context://local/memory/mem_rejected_logo_direction"
  },
  "minimum_fidelity": "semantic",
  "transform": {
    "method": "extractive_summary",
    "implementation": "stella-compactor",
    "version": "1"
  }
}
~~~

For a full representation, inline content is required and canonical. For a
compact representation, inline content, transformation identity, content_ref,
and canonical_content_hash are required. For a reference representation,
inline content is omitted and content_ref plus canonical_content_hash are
required. `content_ref.uri` is opaque outside the resolver. Never encode a
reference as an empty content string.

Do not use single-letter properties or positional arrays. The significant
savings come from content reduction and references, not opaque field names.

### 10.3 Content requirements

Each selected item declares a minimum_fidelity:

- exact: text and ordered structure cannot be paraphrased;
- semantic: normalization or faithful summary is allowed;
- reference: the canonical record may be omitted if deterministic
  rehydration is available.

Default policy:

| Record | Default content requirement |
| --- | --- |
| Blocking constraint | exact |
| Guarded rule | exact |
| Procedure whose order matters | exact |
| Assumption | semantic with explicit assumption label |
| Fact or decision | semantic |
| Memory episode | semantic |
| Observation summary | semantic |
| Artifact contract used by validator | reference if validator retains full contract |
| Evidence | reference |
| Code map | reference except active excerpts |

### 10.4 Stable base and invocation delta

Stella should maintain a stable, cacheable base containing:

- system and organization constraints;
- published repository directives;
- confirmed user preferences;
- active artifact contracts;
- stable knowledge.

Each invocation adds a volatile working set:

- current task and state;
- currently relevant code;
- recent tool results;
- newly selected memories;
- changed validation state;
- unresolved conflicts.

Stella may represent this internally through base_frame_id, added items, updated
items, and removed item IDs. This is a Stella aggregate optimization. It is not
required in the protocol until the protocol defines an aggregate-frame exchange
use case.

### 10.5 PromptContext

PromptContext is not JSON protocol data. It is a deterministic text rendering
optimized for the target model.

~~~text
TASK
Create the complete brand kit.

CONSTRAINTS
[d1] Do not declare completion until the artifact contract passes.

DECISIONS
[k1] Editable SVG masters are required.

MEMORY
[m1] Previous generic logo direction was rejected; use a terminal-native direction.

CONTRACT
[a1] brand_kit@3: 14 required outputs; 12 satisfied; 2 missing.

STATE
phase=execute; missing=logos/wordmark.svg, social/og-image.png
~~~

The full FrameManifest remains outside the prompt and can explain every label.

## 11. Context compilation

### 11.1 Pipeline

1. Resolve user, organization, repository, workspace, environment, session, and
   task identities.
2. Resolve authorization and non-overridable policy outside learned context.
3. Load task goal, success criteria, state, and applicable contracts.
4. Select records matching scope and temporal query.
5. Retrieve the smallest relevant code-map subgraph.
6. Query Context Graph providers within their capabilities and budgets.
7. Summarize raw observations only when useful and safe.
8. Resolve contradictions, supersession, and authority conflicts.
9. Assign content requirements and representation.
10. Deduplicate, diversify, rank, and pack to section budgets.
11. Produce CompiledContextFrame and immutable FrameManifest.
12. Render model-specific PromptContext.
13. Record citation opportunities and selected item IDs.
14. Append feedback when outcomes become available.

### 11.2 Default precedence

Highest first:

1. authorization boundaries and non-overridable system policy;
2. confirmed organization constraints;
3. confirmed blocking repository constraints and guarded rules;
4. explicit instructions in the current user task;
5. required artifact contracts;
6. confirmed repository directives;
7. confirmed user directives;
8. active knowledge;
9. advisory inferred directives;
10. memories;
11. observation summaries and untrusted evidence.

Specific applicability scope wins over broad scope at equal authority.
Recency alone never overrides a confirmed record unless supersession or validity
establishes that the earlier record no longer applies.

### 11.3 Conflicts

Conflict resolution records:

- competing record IDs;
- authority and scope;
- selected record, if any;
- resolution rule;
- whether human input is required;
- observed_at.

Stella never silently blends incompatible constraints or decisions.

### 11.4 Prompt-injection boundary

Source code, issues, logs, diffs, web pages, imported documents, and raw
observations are untrusted evidence. Imperative text inside them has no
instruction authority. Prompt rendering separates policy, knowledge, memory,
and evidence.

## 12. Observation farming and self-improvement

### 12.1 Sources

Stella extracts observations from:

- AgentEvent streams;
- journal JSONL and replay;
- reflections.jsonl;
- tool calls, failures, retries, and recoveries;
- witness, verify, and judge results;
- artifact-contract validation;
- explicit user corrections, acceptance, rejection, Keep, Edit, and Ignore;
- working-tree, staged, and committed Git diffs;
- repeated organization and naming patterns;
- directive conflicts and guard denials;
- citation feedback.

### 12.2 Extractor contract

Each extractor:

- accepts one source type through an adapter;
- emits zero or more normalized observations;
- preserves source cursor and evidence locator;
- emits a deterministic idempotency_key;
- redacts secrets before persistence;
- sets initial scope, sharing_scope, sensitivity, and confidence;
- distinguishes direct evidence from inference;
- never turns agent prose directly into steering;
- is replayable and deterministic where practical.

Decision logic lives in stella-core. Filesystem, Git, database, process, and
terminal I/O lives in adapters.

### 12.3 Git inference

Useful signals include:

- files added by the user after the agent stopped;
- tests repeatedly added with a category of code change;
- files repeatedly renamed or reorganized;
- required asset variants repeatedly restored;
- generated output consistently deleted before acceptance;
- final commit shape compared with the agent's last patch.

Safeguards:

- a follow-up edit is an observation, not proof of error;
- only task-related hunks are considered;
- merge, generated, vendor, and formatting-only churn is filtered;
- base and head commits are preserved in evidence;
- repetition is counted across distinct tasks;
- deterministic tests and contracts outrank behavioral inference.

### 12.4 Proposal induction

Proposal scoring considers:

- distinct task count;
- deterministic evidence;
- explicit user confirmation;
- recency;
- consistency;
- contradiction count;
- user repair cost;
- future applicability;
- scope confidence;
- sensitivity;
- staleness.

Store score components and algorithm version. Never retain only one opaque
number.

### 12.5 Anti-poisoning

- Never promote solely from model-authored prose.
- Require independent evidence or repetition across distinct tasks.
- Never use a generated proposal as evidence for itself.
- Unknown record kinds have no instruction authority.
- Detect contradictions before automatic activation.
- Prevent one task from manufacturing the recurrence threshold.
- Rate-limit proposal production.
- Never infer blocking enforcement.
- Preserve evidence for every activated record.

## 13. Adaptive governance

### 13.1 Configuration

Use .stella/settings.json:

~~~json
{
  "context": {
    "governance": {
      "mode": "solo"
    },
    "promotion": {
      "inferred_directive": {
        "min_observations": 3,
        "min_distinct_tasks": 3,
        "auto_activate_at_confidence": 85,
        "initial_enforcement": "advisory"
      },
      "blocking_directive": {
        "requires_explicit_confirmation": true
      }
    },
    "retention": {
      "raw_observation_days": 30,
      "proposal_days": 30,
      "stale_inferred_directive_days": 180
    }
  }
}
~~~

Modes are solo, team, and regulated.

### 13.2 Solo mode

~~~text
observation
  -> record proposal
  -> user-scoped inferred advisory directive
  -> Keep, Edit, or Ignore
  -> confirmed directive
  -> optional explicit repository publication
~~~

Suggested notice:

> I observed this in three separate tasks: you add an integration test whenever
> this route changes. I will treat it as an advisory rule for you. [Keep]
> [Edit] [Ignore]

Keep records confirmation. Edit creates a superseding user-authored record.
Ignore rejects the proposal and suppresses immediate re-proposal.

### 13.3 Team mode

~~~text
observation
  -> record proposal
  -> proposed repository directive
  -> owner review
  -> published .stella/rules/*.md
~~~

A Context PR is any reviewable promotion of context into durable steering. In
team mode, an ordinary Git change supplies authorship, discussion, ownership,
and audit history.

### 13.4 Regulated mode

Regulated mode requires explicit approval, actor identity, reason, immutable
promotion history, policy version, retained evidence, optional separation of
proposer and approver, and no automatic archival of published policy.

### 13.5 Solo-to-team transition

When multiple active repository identities are detected:

1. Ask whether to change governance mode.
2. Keep user-scoped records private.
3. List repository-applicable proposals eligible for publication.
4. Convert local evidence into proposals, not enforced team policy.
5. Publish only selected directives through Git.
6. Enable owner routing only when maintainers or code owners exist.

No record-schema migration is required.

## 14. Published repository directives

Repository steering remains .stella/rules/*.md:

~~~yaml
---
name: api-integration-coverage
description: Require integration coverage for API endpoint changes
record_kind: directive
directive_kind: rule
sharing_scope: repository
enforcement: advisory
confidence: 91
observed_at: 2026-07-20T18:30:00Z
valid_from: 2026-07-20T18:30:00Z
evidence_refs:
  - ev_task_101
  - ev_task_118
  - ev_task_144
---

API endpoint changes should include integration coverage.
~~~

New metadata uses lowercase snake_case. Existing hyphenated guard keys remain
readable. Stella should accept both during migration and emit canonical
guard_tool, guard_deny_path, and guard_deny_command for new generated files.

Full private evidence remains in context.db. Git files contain reviewable
statements and stable evidence IDs.

## 15. Lifecycle, efficacy, and pruning

### 15.1 Status

Canonical RecordStatus values are:

- active;
- superseded;
- retracted;
- archived.

Expiration is derived from valid_until. Staleness is represented by a derived
selection_health value and retrieval policy. Rejected applies to proposals and
promotion events, not to an activated directive.

### 15.2 Efficacy

Track:

- opportunity count;
- selection count;
- render count;
- citation count;
- evaluated use count;
- helpful, not helpful, and neutral outcomes;
- attribution confidence;
- task acceptance;
- validation pass rate;
- repair cost;
- contradictions;
- time since last confirmed use.

The defensible outcome is not that Stella stores more context. It is that Stella
can link the exact selected context to independently observable outcomes.

### 15.3 Expiry and staleness

- Raw observations expire according to sensitivity and policy.
- Proposals expire when they are neither promoted nor reaffirmed.
- Inferred advisory directives receive a review_after timestamp by default;
  valid_until is used only when the directive is known to cease being valid.
- User-confirmed directives do not expire merely because they were unused.
- Facts and assumptions become stale when sources or validity change.
- Memories can be compacted without being declared false.
- Superseded records remain available for historical reconstruction.

### 15.4 Automatic archival

Initial advisory policy:

~~~text
eligible when:
  evaluated_count >= 5
  and not_helpful_count / evaluated_count >= 0.80
  and attribution confidence is sufficient

action:
  set selection_health to stale
  stop automatic selection
  retain for a grace period
  append an archived revision unless reaffirmed
~~~

Use a confidence interval or Bayesian estimate after sufficient evaluation
data. Never auto-archive system directives, critical directives, blocking
directives, organization policy, pinned records, or audit-held records.

Archival is reversible. Physical deletion follows a separate privacy and
retention policy.

## 16. Detecting inaccurate or incomplete work

### 16.1 Verified conclusions

Stella can label work verified incomplete or incorrect when:

- a required artifact-contract check fails;
- a witness or deterministic verification fails;
- a schema, type, lint, or policy check fails;
- the user explicitly identifies an error or omission;
- a trusted external result contradicts the output;
- a required artifact is absent;
- a generated manifest does not match the workspace.

### 16.2 Inferred signals

These support inferred assessments only:

- the user substantially rewrites the result;
- the same missing artifact is added after multiple tasks;
- the user requests repeated rework;
- a semantic judge flags an inconsistency;
- a later commit changes an agent-authored claim;
- repeated tool recovery follows the same output.

### 16.3 Brand-kit behavior

With an approved contract, Stella:

1. Matches the task intent.
2. Selects the contract into the frame.
3. Renders its required output shape.
4. Runs deterministic validators.
5. Refuses to claim completion while required checks fail.
6. Records omissions as observations.
7. Proposes recurring user requirements as directives or contract amendments.
8. Reuses the versioned contract on later tasks even when the prompt omits the
   checklist.

Memory reminds; a contract verifies.

## 17. Context Graph Protocol boundary

### 17.1 Existing query surface

Existing query-only providers remain valid. ContextFrame remains the atomic
retrieval type. Stella compiles provider frames into CompiledContextFrame.

### 17.2 Optional representations

Providers may advertise:

- full;
- compact;
- reference;
- rehydration support;
- maximum payload and batch sizes.

A query may provide ordered representation_preferences such as compact then
full. Missing preferences mean full. Responses identify the representation
actually returned. If no advertised representation intersects the request, the
provider returns unsupported_representation.

Reference frames require a typed rehydration operation and distinguish
reference_not_found, reference_expired, scope_denied, sharing_denied,
consent_required, and content_hash_mismatch.

### 17.3 Optional lifecycle extension

Tentative capability identifier:

~~~text
contextgraph/lifecycle/1.0-draft
~~~

Portable lifecycle operations are intentionally generic:

- context/query: existing semantic retrieval;
- context/records/append: append immutable lifecycle records in a batch;
- context/records/get: retrieve canonical records by ID;
- context/resolve: rehydrate an opaque frame content reference.

Observe, propose, promote, validate, and feedback are not protocol-executed
governance verbs:

- observation extraction appends an observation;
- a proposal appends a record_proposal;
- promotion appends a promotion_event;
- a validator executes outside the lifecycle transport and appends a
  contract_validation;
- feedback appends context_use_feedback.

Each append item carries an idempotency key outside the canonical record.
Same key plus the same record hash returns the prior receipt. Same key plus a
different record hash returns idempotency_conflict.

Each mutation defines capability, consent, idempotency, batch behavior,
per-item accepted, duplicate, or rejected receipts, partial failure, payload
limit, scope and sharing rejection, timeout, and retention semantics.

The protocol exchanges records and events. It does not compute promotion,
confidence, pruning, or governance policy.

### 17.4 Protocol record vocabulary

The protocol should support:

- observation;
- knowledge;
- memory;
- directive;
- record_proposal;
- evidence;
- artifact_contract;
- contract_validation;
- outcome_assessment;
- promotion_event;
- context_use;
- context_use_feedback.

Core knowledge kinds are fact, assumption, and decision. Core directive kinds
are preference, rule, constraint, and procedure. Memory is not a directive kind.

### 17.5 Compatibility

- Query-only providers require no lifecycle support.
- Missing representation defaults to full.
- recorded_at is accepted as an input alias for observed_at.
- valid_to is accepted as an input alias for valid_until.
- canonical serialization emits only observed_at and valid_until.
- unknown extensions round-trip when supported.
- missing lifecycle capability makes lifecycle operations unavailable, not
  fatal to query.

### 17.6 Protocol security

The host checks sharing and consent before dispatch. A provider's ability to
accept lifecycle records is not permission to receive user-private data.

Typed errors include:

- unsupported_capability;
- unsupported_representation;
- consent_required;
- scope_denied;
- sharing_denied;
- invalid_record;
- invalid_temporal_interval;
- invalid_confidence;
- idempotency_conflict;
- payload_too_large;
- partial_failure;
- reference_not_found;
- reference_expired;
- content_hash_mismatch;
- validation_failed.

## 18. Security, privacy, and ownership

- Individual use is local-first.
- No account or server is required.
- No new outbound network traffic is introduced.
- User-scoped records are never shared automatically.
- Repository publication includes approved statements, not raw private
  telemetry.
- Secrets are redacted before storage, indexing, or embedding.
- Users can inspect, export, correct, pin, archive, and delete eligible records.
- Deletion distinguishes source deletion, derived-record invalidation, audit
  retention, and Git history.
- Organization policy cannot silently read user observations.
- Context frames carry trust and instruction-authority boundaries.
- Content hashes support integrity checks without exposing full evidence.
- Learned context cannot grant authorization.

## 19. Determinism and performance

Identical task, state, temporal selector, active records, provider results,
compiler version, ranking configuration, and budget produce an identical frame.

Every frame stores:

- input_hash;
- compiler_version;
- stable ordering;
- included and excluded IDs;
- conflict decisions;
- representation decisions;
- section budgets.

Initial performance targets:

- local observation append p95 below 20 ms excluding embedding;
- incremental harvesting adds less than 100 ms to completion;
- warm local frame compilation p95 below 150 ms excluding external providers;
- lifecycle mining runs after safe task boundaries;
- external providers retain timeout and failure isolation;
- raw volume is bounded by retention, compaction, and rate limits.

Targets become gates only after benchmarks validate them.

## 20. Verification requirements

### 20.1 Schema tests

- all cross-boundary types round-trip through serde_json;
- serialized properties are lowercase snake_case;
- confidence remains within 0 through 100;
- canonical temporal output uses observed_at, valid_from, and valid_until;
- legacy temporal aliases deserialize;
- temporal point and range semantics are correct;
- invalid intervals are rejected;
- scope never widens implicitly;
- unknown observations have no instruction authority.

### 20.2 Governance tests

- three distinct tasks can create one eligible proposal;
- repetitions within one task do not satisfy recurrence;
- inferred directives never become blocking automatically;
- user-scoped records never publish automatically;
- repository publication creates the existing rule format;
- Keep, Edit, and Ignore produce correct immutable events;
- solo-to-team transition does not expose user records.

### 20.3 Compaction tests

- full records remain canonical;
- compact items retain source hashes and rehydration references;
- reference items cannot masquerade as full content;
- exact constraints are not summarized;
- ordered procedures retain order;
- assumptions remain visibly labeled;
- frame ordering and hashes are deterministic;
- base and volatile context produce the same effective PromptContext as a full
  rebuild.

### 20.4 Outcome tests

- missing brand assets fail the contract;
- contract failure prevents a done outcome;
- deterministic evidence produces verified status;
- later edits alone produce inferred status;
- citation feedback requires attribution;
- repeated attributable negative feedback can make an advisory directive stale;
- protected directives are never automatically archived.

### 20.5 Protocol conformance

- query-only providers remain compatible;
- representation negotiation works;
- reference rehydration verifies hashes;
- lifecycle operations are capability-gated;
- consent and sharing are enforced;
- batch replay is idempotent;
- partial failures are per item;
- temporal aliases read and canonical names write.

## 21. Acceptance criteria

The architecture is implemented when:

- Stella stores observations, knowledge, memories, directives, evidence,
  contracts, proposals, promotions, outcomes, context uses, and use feedback
  distinctly.
- No memory is silently treated as current knowledge or steering.
- No observation gains instruction authority.
- Assumptions are labeled and expirable.
- Decisions preserve rationale and alternatives.
- Directives contain only preference, rule, constraint, or procedure semantics.
- Promotion history is event-based.
- Sharing uses user, repository, and organization.
- Repository and workspace identities have distinct semantics.
- CompiledContextFrame is deterministic and inspectable.
- Full, compact, and reference representations are rehydratable.
- PromptContext is token-efficient and traceable to canonical records.
- Published repository steering remains .stella/rules/*.md.
- Brand-kit contracts deterministically catch missing output.
- Verified and inferred outcome assessments are never conflated.
- Context-use health is derived from immutable events.
- Existing query-only providers remain compatible.
- No new phone-home behavior exists.

## 22. Architectural differentiators

1. **Verified context efficacy:** exact selected context is linked to tests,
   contracts, user feedback, and accepted repository state.
2. **Clean semantic separation:** episodes, knowledge, steering, evidence, and
   validation cannot silently impersonate one another.
3. **Artifact contracts:** remembered expectations become executable completion
   criteria.
4. **Bi-temporal lineage:** Stella reconstructs what it knew and what applied.
5. **Adaptive governance:** one record model supports solo, team, and regulated
   use without one mandatory workflow.
6. **Privacy-preserving promotion:** user context crosses into repository
   steering only through explicit publication.
7. **Deterministic-first learning:** tests and validators outrank model
   self-judgment.
8. **Anti-poisoning by construction:** observations and unknown extensions have
   no instruction authority.
9. **Reproducible compaction:** every summary, reference, omission, and budget
   decision is manifest-backed and rehydratable.
10. **Git-native repository steering:** collaborators can inspect durable rules
    through normal source control.
11. **Protocol-native interoperability:** providers exchange mechanisms without
    inheriting Stella product policy.
12. **Outcome-linked local corpus:** each user accumulates a private graph of
    requests, selected context, validations, corrections, and accepted results
    that improves retrieval without centralizing raw work.
13. **Executable contract ecosystem:** reusable contracts and deterministic
    validators turn recurring deliverable expectations into portable product
    assets rather than prompt folklore.
14. **Opportunity-aware evaluation:** Stella distinguishes a record that was
    merely present from one that had a plausible chance to affect the outcome,
    enabling more defensible efficacy estimates and safe experiments.
15. **Cross-agent continuity:** the same canonical record and frame lineage can
    steer different models and agents, so durable learning is not trapped in a
    single chat transcript or model vendor.

The schema is necessary but copyable. The defensible moat is the combination of
high-quality evidence extraction, user-specific outcome history, calibrated
selection and attribution, a growing contract/validator library, and trusted
local governance. Optimize the implementation and product instrumentation for
that compound asset rather than for raw memory count.

## 23. Name assessment: context-graph-protocol

Context Graph Protocol is a good name and should remain the project name.

Reasons:

- context accurately describes the exchanged resource;
- graph reflects first-class relations, provenance, and traversal;
- protocol correctly communicates interoperability rather than a product or
  database;
- the name distinguishes the project from a generic memory library;
- the existing crate and repository naming already align with contextgraph.

The name remains accurate only if relationships and provenance stay first-class.
If the project becomes merely a generic prompt-memory API, graph would overstate
its design.

Alternatives are weaker:

- Agent Context Protocol overlaps other agent and context standards;
- Context Exchange Protocol is clear but generic and understates graph
  semantics;
- Context Lifecycle Protocol emphasizes the new extension but understates
  retrieval and relations;
- Context Graph Interface sounds like a library rather than an interoperable
  protocol.

Recommended public styling:

~~~text
Context Graph Protocol
repository: context-graph-protocol
wire identifier: contextgraph/1.0-draft
optional lifecycle capability: contextgraph/lifecycle/1.0-draft
~~~

## 24. Open decisions

Before schema stabilization:

1. Define local repository identity normalization across remotes and forks.
2. Define how Stella recognizes active identities without network access.
3. Decide the Git-backed export format for repository artifact contracts.
4. Extend or replace the lightweight rule frontmatter parser while preserving
   existing files.
5. Define deletion propagation from evidence to derived records.
6. Calibrate outcome attribution.
7. Define contradiction UX for oscillating preferences and reversed decisions.
8. Define semantic-validator cost, privacy, and version policy.
9. Decide whether a second external provider justifies standardizing lifecycle
   writeback immediately.
10. Define signed organization-policy distribution without violating
    no-phone-home defaults.

## 25. Final recommendation

Implement adaptive context as a Stella-owned lifecycle built on the existing
context plane. Keep the semantic boundaries strict:

~~~text
observation = what was detected
knowledge = what is believed, assumed, or decided
memory = what happened
directive = how behavior should be steered
evidence = why a record should be trusted
artifact contract = what completion must satisfy
outcome assessment = what can responsibly be concluded
~~~

Keep canonical records complete. Compact them only as inspectable,
content-addressed projections. Keep repository steering in existing Markdown
rules. Add only the minimal portable representation and lifecycle mechanisms to
Context Graph Protocol.
