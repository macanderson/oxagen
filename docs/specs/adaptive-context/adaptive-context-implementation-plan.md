# Adaptive Context Implementation Plan

Status: implementation draft  
Primary repository: `macanderson/stella`  
Companion specification: `stella-adaptive-context-lifecycle.md`

This plan turns the adaptive-context specification into a staged Stella
implementation. It is intentionally repository-specific. Context Graph
Protocol changes are a later interoperability layer, not a prerequisite for
local learning.

## 1. Outcomes

Stella should be able to:

1. preserve observations, knowledge, memories, directives, evidence, and
   artifact contracts without conflating their authority;
2. reconstruct what it knew and what was valid at a requested time;
3. compile a deterministic, inspectable context package for each invocation;
4. learn advisory user behavior from independent evidence;
5. promote that behavior through solo, team, or regulated governance;
6. detect objectively incomplete deliverables through reusable contracts;
7. attribute selected context to outcomes without treating correlation as
   causation;
8. suppress stale or repeatedly unhelpful advisory context reversibly;
9. remain local-first and fully functional without a server or protocol
   lifecycle provider; and
10. exchange portable lifecycle records when a provider advertises the
    relevant Context Graph Protocol capabilities.

## 2. Decisions to freeze before implementation

### 2.1 Canonical semantic families

Use these separate record families:

```text
ContextRecord
├── observation
├── knowledge
│   ├── fact
│   ├── assumption
│   └── decision
├── memory
│   ├── episode
│   └── summary
├── directive
│   ├── preference
│   ├── rule
│   ├── constraint
│   └── procedure
├── record_proposal
├── evidence
├── artifact_contract
├── contract_validation
├── outcome_assessment
├── promotion_event
├── context_use
└── context_use_feedback
```

The boundaries are normative:

| Concept | Meaning | Instruction authority |
| --- | --- | --- |
| observation | An immutable interpreted occurrence | None |
| evidence | Addressable source material | None |
| knowledge | A believed, assumed, or decided proposition | None |
| memory | A bounded historical episode or summary | None |
| directive | Normative steering for future behavior | Advisory or blocking |
| record_proposal | A possible future record | None |
| artifact_contract | Executable definition of completion | Only when selected by host policy |
| contract_validation | Result of evaluating a contract | None |
| outcome_assessment | Qualified conclusion about an outcome | None |
| promotion_event | Immutable governance history | None by itself |
| context_use | Selection, rendering, or citation telemetry | None |
| context_use_feedback | Evaluation of a prior use | None |

Do not restore `memory` or `fact` as directive kinds. Do not treat a source-code
map or active task state as a lifecycle record by default. Do not allow a
learned record to grant tool, filesystem, network, identity, or security
authorization.

Outcome truth uses two independent dimensions:

```text
completion_assessment.status: complete | incomplete | unknown
correctness_assessment.status: correct | incorrect | unknown
```

Each dimension carries its own `assessment_level`: `verified`,
`user_confirmed`, `externally_confirmed`, `inferred`, or `unknown`. A complete
artifact can be incorrect; a correct partial artifact can be incomplete.

### 2.2 Record identity and lifecycle

Use:

```text
record_id               immutable revision identity
lineage_id              conceptual identity across revisions
supersedes_record_id    immediate prior revision
record_status           active | superseded | retracted | archived
```

`expired` is derived from `valid_until`. `stale` is a derived selection-health
assessment. Neither is a canonical `record_status`.

Do not put `promotion_stage` on a directive. Governance history is represented
by immutable `promotion_event` records with these actions:

```text
proposed
auto_activated
confirmed
published
rejected
retired
reverted
```

There is no required sequence shared by every governance mode.

### 2.3 Applicability and sharing

`scope` answers where a record applies. `sharing_scope` answers who may receive
or inherit it. They are independent.

Core scope fields:

```text
user_id
organization_id
repository_id
workspace_id
environment_id
session_id
task_id
```

Core sharing values:

```text
user
repository
organization
```

The UI may render `user` as “Personal.” `workspace` is not a sharing value.
`project_id` remains a namespaced extension until Stella has a durable project
registry. A path, checkout, IDE project, or GitHub Project must not be treated
as a portable project identity.

All populated scope dimensions are conjunctive. Missing scope never widens an
inferred record.

### 2.4 Temporal vocabulary

Canonical record properties:

```text
observed_at
valid_from
valid_until
```

Canonical temporal query properties:

```text
known_at
valid_at
observed.from
observed.until
valid_overlaps.from
valid_overlaps.until
```

Intervals are half-open: `[from, until)`. `valid_until` is exclusive.
`recorded_at` and `valid_to` may be accepted as legacy input aliases but must
never be emitted by canonical writers.

### 2.5 Frame boundary

Keep four concepts separate:

```text
provider ContextFrame[]
        ↓
CompiledContextFrame
        ↓
PromptContext
        ↓
model invocation
```

- `ContextFrame` is the protocol's atomic retrieval envelope.
- `CompiledContextFrame` is Stella's complete bounded aggregate for one
  invocation.
- `PromptContext` is Stella's deterministic model-facing rendering.
- A snapshot or delta is a Stella-local cache optimization, not a replacement
  for either canonical type.

Frame representations are `full`, `compact`, and `reference`. Representation
and content fidelity are separate dimensions.

### 2.6 Existing storage remains authoritative

Use the current Stella stores rather than creating parallel files:

```text
.stella/context.db       lifecycle records, temporal links, retrieval metadata
.stella/store.db         executions, events, tool calls, operational telemetry
.stella/codegraph.db     source-code graph
.stella/rules/*.md       published repository steering
.stella/settings.json    governance, learning, retention, and sharing settings
.stella/context-snapshots/  optional derived cache, gitignored
```

Do not add `context-rules.yaml`, a second context database, or a second source
code graph. A published repository rule is canonical in Markdown; any row in
`context.db` is an indexed mirror with source identity and content hash, not an
independently editable copy.

### 2.7 Product and protocol boundary

Stella owns:

- evidence extraction and observation farming;
- proposal induction and confidence scoring;
- solo, team, and regulated governance;
- promotion thresholds and UI;
- artifact-contract execution;
- prompt compilation and token allocation;
- efficacy attribution, staleness, and pruning;
- local SQLite schema and Git publication.

Context Graph Protocol owns only portable exchange mechanisms:

- typed lifecycle records and links;
- scope, sharing, provenance, and temporal semantics;
- frame representations and reference resolution;
- capability negotiation;
- immutable append/get operations, idempotency, receipts, and typed failures.

## 3. Dependency and implementation rules

Implement in this order:

```text
domain vocabulary and compatibility contract
    ↓
internal additive events
    ↓
context.db migration and repositories
    ↓
temporal retrieval and CompiledContextFrame
    ↓
PromptContext compaction
    ↓
observation extraction
    ↓
record proposals and governance
    ↓
artifact contracts and completion gating
    ↓
repository publication and team governance
    ↓
efficacy, pruning, and Observatory
    ↓
optional protocol lifecycle adapter
```

Preserve the existing Cargo dependency graph:

- keep SQLite, Git, filesystem, terminal, and network I/O out of `stella-core`;
- do not make `stella-protocol` depend on `stella-context`;
- use stable IDs and small protocol-local payloads when importing a core type
  would create a cycle;
- do not make external Context Graph Protocol structs Stella's internal domain
  model;
- keep every new behavior behind settings until its phase gates pass;
- make event replay idempotent before enabling automated learning.

## 4. Phase 0 — Baseline, ADRs, and fixtures

### Work

1. Read repository instructions and record the current Cargo dependency graph.
2. Run and record the existing formatting, lint, test, and migration baselines.
3. Inventory current memory, fact, rule-mining, journal, event, provider, and
   context-frame code paths.
4. Capture fixture copies for every supported `context.db` and `store.db`
   schema version.
5. Capture representative `.stella/rules/*.md` files, including existing guard
   frontmatter and aliases.
6. Add ADRs for:
   - semantic taxonomy;
   - scope versus sharing;
   - bitemporal semantics;
   - record revision identity;
   - storage authority;
   - `ContextFrame` versus `CompiledContextFrame`;
   - immutable promotion history;
   - Markdown repository rules remaining canonical.
7. Add disabled settings under `.stella/settings.json`.

Suggested initial settings:

```json
{
  "context": {
    "lifecycle": {
      "enabled": false
    },
    "learning": {
      "mode": "off"
    },
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
      "inferred_directive_review_days": 180
    }
  }
}
```

Learning modes should be `off`, `record_only`, and `advisory`. Governance modes
should be `solo`, `team`, and `regulated`. Keep those dimensions separate.

### Gate

- The existing workspace passes its documented checks before feature changes.
- Legacy database and rule fixtures are committed to tests.
- New settings deserialize with defaults that preserve current behavior.
- No network or repository mutation is introduced.

## 5. Phase 1 — Domain types and internal events

### `stella-core`

Add pure domain types and validators for:

- `ContextRecordKind`;
- `KnowledgeKind`;
- `MemoryKind`;
- `DirectiveKind`;
- `ConstraintEffect`;
- `RecordStatus`;
- `RecordProposalKind` and `RecordProposalStatus`;
- `PromotionAction`;
- `DirectiveEnforcement`;
- `Scope` and `SharingScope`;
- `TemporalInterval` and `TemporalQuery`;
- `ContextUseKind` and `ContextUseEvaluation`;
- `ArtifactContract`, requirement kinds, and validation result types;
- `OutcomeAssessmentLevel`;
- `CompletionStatus` and `CorrectnessStatus`;
- frame representation, content fidelity, and minimum fidelity.

Use explicit constructors or validation functions for cross-field invariants.
Examples:

- `valid_until` must be later than `valid_from`;
- an inferred directive cannot be created with blocking enforcement;
- an inferred record must have a nonempty scope;
- a constraint effect is `require` or `forbid`, never `allow`;
- a procedure must preserve a unique ordered step sequence;
- confidence is in `0..=100`;
- a reference representation has no inline-content placeholder;
- a blocking or guarded directive requires exact minimum fidelity.

### `stella-protocol`

Add internal, replay-safe events without changing public Context Graph Protocol
wire semantics yet:

```text
ObservationRecorded
RecordProposalCreated
PromotionRecorded
ContextUseRecorded
ContextUseFeedbackRecorded
ArtifactContractSelected
ContractValidationCompleted
OutcomeAssessed
CompiledContextFrameBuilt
```

Each event carries an event ID, schema version, task/invocation identity when
applicable, `observed_at`, and only the stable IDs needed by consumers.

### Compatibility

- Accept legacy `recorded_at` as `observed_at` and `valid_to` as
  `valid_until` at ingestion boundaries.
- Emit only lowercase snake_case canonical fields.
- Preserve unknown namespaced extensions without granting them instruction
  authority.
- Keep legacy memory and fact APIs working through adapters until callers are
  migrated.

### Gate

- Exhaustive type validation tests pass.
- Serde round trips are byte-stable for canonical fixtures.
- Alias fixtures deserialize and reserialize with canonical names.
- Unknown extensions round-trip.
- No I/O is added to `stella-core`.
- Existing event consumers ignore new event variants safely.

## 6. Phase 2 — `context.db` schema and migration

### Canonical storage shape

Extend the existing migration system; do not create a replacement database.
The exact table prefix should follow current repository conventions. The
logical model needs:

```text
context_records
  record_id primary key
  lineage_id nullable for immutable event-only records
  schema_version
  record_kind
  record_status
  scope_json
  sharing_scope
  observed_at
  valid_from nullable
  valid_until nullable
  confidence nullable
  supersedes_record_id nullable
  record_hash
  payload_json
  extensions_json
  authority_kind
  authority_ref nullable

context_record_links
  source_record_id
  relation
  target_record_id

context_evidence_links
  record_id
  evidence_id
  relation

compiled_context_frames
  frame_id
  task_id
  invocation_id
  compiler_version
  known_at
  valid_at
  input_hash
  frame_hash
  budget_json
  manifest_json
  compiled_at

compiled_context_frame_items
  frame_id
  ordinal
  record_id
  use_kind
  representation
  content_fidelity
  selection_reason
  token_cost
  canonical_content_hash

context_health_projection
  record_id
  selection_health
  opportunity_count
  selected_count
  rendered_count
  cited_count
  evaluated_count
  helpful_count
  not_helpful_count
  neutral_count
  review_after nullable
  updated_at
```

`context_health_projection` is rebuildable from immutable `context_use` and
`context_use_feedback` records. It is never the source of historical truth.

Use `authority_kind` only as Stella-internal storage metadata:

```text
context_db
repository_rule_file
organization_policy
```

For `repository_rule_file`, `authority_ref` is the normalized repository path
and the database record is read-only from the lifecycle API.

### Indexes

Add indexes based on measured query plans, at minimum for:

- record kind, status, and sharing scope;
- lineage and supersession;
- `observed_at`;
- `valid_from` and `valid_until`;
- task, session, repository, and user scope projections;
- evidence and record links;
- frame task/invocation identity;
- context-use target record and time.

If scope remains JSON, maintain validated indexed projection columns for hot
dimensions. Do not rely on unindexed JSON scans in invocation compilation.

### Migration

1. Preserve current memory and fact IDs when possible.
2. Map factual memory to `knowledge/fact` only when the old row actually
   expresses a proposition; otherwise map it to `memory/episode` or
   `memory/summary`.
3. Link migrated revisions through lineage rather than mutating history.
4. Import existing `.stella/rules/*.md` as authoritative mirrors.
5. Store migration version and content hashes so reruns are no-ops.
6. Run the migration in a transaction and retain the existing backup behavior.

### Gate

- Every legacy fixture migrates transactionally.
- Record counts and content checksums reconcile.
- Existing memory/fact recall tests remain valid or have documented semantic
  replacements.
- Replaying a migration creates no duplicate records.
- SQLite integrity and foreign-key checks pass.
- Published rule mirrors cannot be edited through the database repository.

## 7. Phase 3 — Temporal retrieval and `CompiledContextFrame`

### Temporal repository API

Implement one typed query object with these semantics:

```text
known_at:
  observed_at <= known_at

valid_at:
  valid_from <= valid_at
  and (valid_until is null or valid_at < valid_until)

observed [from, until):
  from <= observed_at < until

valid_overlaps [from, until):
  valid_from < until
  and (valid_until is null or from < valid_until)
```

Reject invalid or contradictory temporal filters rather than silently
reinterpreting them. Add truth-table tests for boundary instants.

### Frame compiler

Build `CompiledContextFrame` in `stella-context` or the existing context
assembly boundary. Inputs include:

- task and current state;
- complete scope;
- `known_at` and `valid_at` cutoffs;
- governance mode;
- code-map roots;
- provider ContextFrames;
- token and latency budgets;
- compiler and selection-policy versions.

Compilation pipeline:

1. resolve scope without widening;
2. retrieve active, temporally applicable records;
3. exclude retracted, archived, expired, suppressed, and incompatible-sharing
   records;
4. apply authority and directive precedence;
5. detect contradictions and supersession;
6. select required constraints and contracts;
7. rank optional knowledge, memories, and advisory directives;
8. allocate a deterministic budget;
9. choose per-item representation and fidelity;
10. produce an immutable manifest;
11. persist the frame and ordered item list;
12. emit `ContextUse` records for actual selection and later rendering.

The manifest records every included record ID, exclusion reason, conflict,
provider query, transformation, budget decision, and compiler version.

### Precedence

Use explicit category-aware precedence, not one global confidence score:

1. system safety and current organization constraints;
2. current published repository constraints and guards;
3. explicitly confirmed user constraints;
4. selected artifact-contract requirements;
5. confirmed rules and procedures;
6. advisory preferences and inferred advisory rules;
7. current knowledge;
8. memories and observation summaries.

Confidence never overrides authority. A preference never overrides a
constraint. A memory never overrides current knowledge.

### Gate

- Identical inputs produce byte-identical ordered frames and manifests.
- Historical tests distinguish `known_at` from `valid_at`.
- Scope leakage tests pass at every dimension.
- Conflicts and exclusions are inspectable.
- Required items cannot be evicted by ranking.
- Existing provider query behavior remains functional.

## 8. Phase 4 — Compaction and prompt rendering

### Representations

Implement:

```text
representation: full | compact | reference
content_fidelity: exact | normalized | summarized | omitted
minimum_fidelity: exact | semantic | reference
```

Invariants:

- `full` requires canonical inline content;
- `compact` requires inline content, transformation identity, inline hash, and
  canonical hash;
- `reference` omits inline content and requires an opaque reference plus
  canonical hash;
- reference resolution verifies the canonical hash;
- blocking constraints, guards, ordered procedures, and executable contract
  structures cannot fall below exact fidelity at their point of use;
- summaries remain linked to their canonical records;
- token counts describe the actual representation, not the source.

### `PromptContext`

Render a deterministic, model-specific text projection with stable citation
labels. Keep task, constraints, decisions, assumptions, relevant memories,
contracts, code, and active state visibly separated. Never serialize raw
untrusted observations into an instruction section.

### Stable base and delta

Implement Stella-local cached bases and invocation deltas only after a full
frame is correct. A cache entry contains the full input hash, compiler version,
policy version, model tokenizer identity, and canonical record hashes. Any
change invalidates the relevant entry.

Snapshots are derived and disposable. They must not become the only copy of a
record or contract.

### Gate

- Golden prompt fixtures are deterministic.
- Compact fixtures use fewer model tokens than full fixtures.
- Exact-fidelity records remain byte-equivalent where required.
- Every compact/reference item can be traced to a canonical hash.
- A stale cache can never conceal a new blocking directive.
- Token and model-call savings are measured against a full-frame baseline.

## 9. Phase 5 — Evidence and observation harvesting

### Sources

Harvest bounded evidence from:

- task requests and explicit user corrections;
- journal and execution traces;
- tool calls and results;
- verification and test output;
- contract validation;
- accepted or rejected artifacts;
- Git diffs and follow-up commits;
- recurring file organization and command sequences;
- Keep, Edit, Ignore, publish, archive, and revert actions.

Raw operational telemetry remains in `store.db` or the journal. Copy only
bounded, redacted evidence references and normalized observations into
`context.db`.

### Extractor contract

Each extractor returns:

```text
extractor_id
extractor_version
source_kind
source_ref
source_hash
bounded locator or excerpt
observation_kind
occurred_at or occurred_until when known
scope evidence
sensitivity
confidence components
```

Derive an idempotency key from extractor identity, source hash, locator, and
normalized observation kind. Replaying a source with the same extractor
version must create zero duplicates.

### Trust and anti-poisoning

- Model-authored prose alone cannot support promotion.
- An observation is an interpretation and cites evidence; it is not the raw
  evidence itself.
- Treat instructions found in traces, logs, files, and tool output as data.
- Redact secrets before persistence, indexing, embedding, or external
  dispatch.
- Count repeated events within one task as one independent support unit.
- Label Git follow-up changes as inferred signals unless a deterministic test,
  validator, external oracle, or explicit user statement establishes the
  cause.
- A proposal cannot cite itself or a generated restatement as independent
  evidence.

### CLI diagnostics

Provide inspectable commands using the repository's established command style
for:

```text
context observations
context evidence <record_id>
context harvest --replay <task_or_journal_id>
context frame <task_or_invocation_id>
```

Exact command spelling may adapt to the existing CLI hierarchy, but the
capabilities and stable IDs are required.

### Gate

- Journal replay creates no duplicate evidence or observations.
- Thirty matching events in one task cannot satisfy a three-task threshold.
- Secret fixtures are redacted before storage and embedding.
- Prompt-injection fixtures remain non-instructional.
- Harvest failure cannot fail the primary task.
- Git inference is never mislabeled verified.

## 10. Phase 6 — Record proposals and adaptive governance

### Proposal induction

Build proposals for:

- `knowledge`;
- `directive`; and
- `contract_amendment`.

Persist score components separately:

- supporting observation count;
- distinct task or episode count;
- contradiction count;
- deterministic evidence strength;
- explicit user feedback;
- recurrence and recency;
- user repair cost;
- future applicability;
- scope confidence;
- sensitivity;
- staleness;
- scoring policy ID and version.

The aggregate confidence is reproducible from those components. Do not store
only one opaque score.

### Proposal status

Use:

```text
collecting
eligible
dismissed
expired
```

Activation and rejection are promotion outcomes, not proposal status values.

### Solo mode

```text
observation
  → record proposal
  → user-scoped inferred advisory directive
  → Keep | Edit | Ignore
  → confirmed directive
  → optional explicit repository publication
```

- `auto_activated` is allowed only at configured support and confidence
  thresholds.
- The resulting directive is user-shared and advisory.
- Keep appends `confirmed`.
- Edit creates a superseding user-authored revision and appends the appropriate
  confirmation event.
- Ignore appends `rejected`, dismisses the proposal, and provides negative
  induction evidence.

### Team mode

```text
observation
  → record proposal
  → proposed repository directive
  → owner review
  → published .stella/rules/*.md
```

No inferred record publishes automatically.

### Regulated mode

Require actor identity, reason, policy version, retained evidence, explicit
approval, and optional proposer/approver separation. Do not auto-archive
published policy.

### User interface

The notice should disclose the exact inferred statement, evidence count,
distinct task count, confidence, enforcement, current sharing scope, and the
effect of each action.

Example:

> I observed this in three separate tasks: you add an integration test whenever
> this route changes. I will treat it as an advisory rule for you. [Keep]
> [Edit] [Ignore]

### Gate

- Three distinct tasks can produce one eligible directive proposal.
- Repetition inside one task cannot.
- No inferred directive becomes blocking.
- No sharing scope broadens automatically.
- Keep, Edit, Ignore, and publication are replayable and auditable.
- A user-shared directive never appears in Git.
- Existing rule mining and guards remain compatible.

## 11. Phase 7 — Artifact contracts and completion truth

### Selection

Select a versioned `artifact_contract` during task triage using intent, scope,
validity, authority, and explicit user choice. Put the exact contract ID,
version, and content hash into `CompiledContextFrame` before execution.

### Validation

Run validators in this order:

1. deterministic filesystem, manifest, schema, dimension, and command checks;
2. externally verified checks;
3. semantic judges, labeled inferred.

A semantic judge cannot override a deterministic required failure. The worker
cannot pass validation by changing the selected contract because validation
uses the pre-execution ID, version, and hash.

Emit immutable `contract_validation` and `outcome_assessment` records. A
required validation failure means Stella cannot claim the artifact is complete.
Populate `completion_assessment` and `correctness_assessment` independently;
never infer correctness merely because the output is complete or infer
completion merely because the produced portion is correct.

### Brand-kit witness

Create an end-to-end fixture where a user-scoped contract requires:

- editable SVG logo, wordmark, and mark;
- required PNG variants;
- favicons;
- design tokens matching a schema;
- brand guidelines with required sections;
- a file manifest and preview sheet;
- a stable directory structure.

Witness sequence:

1. The prompt asks only for a brand kit.
2. Stella retrieves the confirmed contract.
3. The first result omits `logos/wordmark.svg`.
4. Deterministic validation fails that requirement.
5. Stella does not report completion.
6. The failure creates one idempotent observation.
7. The repaired result passes all requirements.
8. A later task retrieves the same contract even when the prompt omits the
   checklist.

### Gate

- Required deterministic failures block completion claims.
- Contract and result hashes are inspectable.
- Validation replay is idempotent.
- Personal contracts remain user-shared unless explicitly published.
- Semantic judges are qualified as inferred.

## 12. Phase 8 — Repository publication and team transition

### Repository source of truth

Extend the existing `.stella/rules/*.md` format. Do not introduce YAML as a
second rule authority.

New rule frontmatter may contain:

```text
record_id
lineage_id
record_kind
directive_kind
sharing_scope
enforcement
confidence
observed_at
valid_from
valid_until
evidence_refs
record_hash
```

Do not include `promotion_stage`. Preserve legacy guard keys as readable
aliases and emit lowercase snake_case for generated files.

Full private evidence remains in `context.db`. Git contains the reviewable
statement, safe provenance references, and hashes needed to detect drift.

Creating a file, staging, committing, pushing, or opening a pull request are
separate actions. Each requires the authority already established by the user
or existing workflow.

### Solo-to-team transition

1. Treat multiple recent Git identities as a signal, not proof.
2. Ask before changing governance mode.
3. Keep user-shared records private.
4. Offer repository-applicable proposals for explicit publication.
5. Convert existing local evidence into proposals, not enforced team policy.
6. Enable owner routing only when maintainers or code owners resolve.

The transition changes policy, not record schema or identity.

### Gate

- Legacy rule files load unchanged.
- Generated rules round-trip through the current loader and guard engine.
- Personal evidence never enters Git.
- Adding a collaborator requires no database migration.
- Repository mutation never occurs merely because a proposal is eligible.

## 13. Phase 9 — Efficacy, staleness, and pruning

### Immutable use records

Use `context_use` to distinguish:

```text
selected
rendered
cited
```

Use `context_use_feedback` to record:

```text
helpful
not_helpful
neutral
```

Every feedback record identifies the exact `context_use`, evaluation method,
attribution confidence, opportunity, evaluator, and `observed_at`. An
unsuccessful task must not mark every selected record unhelpful.

### Derived efficacy

Rebuild projections for:

- opportunity count;
- selection, rendering, and citation counts;
- evaluated use count;
- helpful, not-helpful, and neutral counts;
- validation pass rate;
- contradictions;
- repair cost;
- last confirmed use;
- review due date;
- selection health.

Recommended internal `selection_health` values:

```text
healthy
review_due
stale
suppressed
```

These values are projections, not canonical record status.

### Initial reversible policy

An advisory inferred directive becomes eligible for suppression only when:

- it had a real opportunity to influence at least five evaluated uses;
- at least 80 percent of attributable evaluations are `not_helpful`;
- attribution confidence meets the configured threshold; and
- a confidence interval or Bayesian estimate rejects ordinary noise.

The first action is `selection_health = stale`, followed by exclusion from
automatic selection and a review notice. Archive only after a grace period.
Never apply this automatically to blocking, critical, organization, pinned, or
user-confirmed directives.

Physical deletion is a separate retention/privacy workflow. Archival is
reversible and retains provenance.

### Observatory

Add views for:

- frame lineage, selections, exclusions, and conflicts;
- evidence → observation → proposal → promoted record lineage;
- context use and efficacy;
- stale, review-due, and expiring records;
- contract selection and validation;
- provider contribution and latency;
- scope and sharing transitions.

### Gate

- Aggregates rebuild exactly from immutable records.
- Negative attribution requires a relevant opportunity and method.
- Stale records remain inspectable and restorable.
- Suppressed records are excluded from automatic retrieval.
- Safety and blocking directives are never withheld for experiments.

## 14. Phase 10 — Context Graph Protocol interoperability

Do this only after the local schema passes replay evaluation and a second
provider use case validates portability.

### Stella adapter

- Map protocol `ContextRecord` values into Stella domain types through an
  adapter boundary.
- Continue operating locally when lifecycle capability is absent.
- Preserve existing query-only providers.
- Check scope, sharing, and consent before dispatch.
- Never dispatch user-shared records solely because a provider can accept
  lifecycle writes.
- Keep remote append failure isolated from primary task success.

### Expected portable capability

Consume only these mechanisms:

```text
context/query
context/records/append
context/records/get
context/resolve
```

The protocol append operation carries immutable record facts. Stella still
performs observation extraction, proposal scoring, promotion, validation,
enforcement, compaction policy, and pruning.

### Gate

- Query-only provider witnesses remain unchanged.
- Unsupported lifecycle capability is nonfatal.
- Reference resolution verifies canonical content hash.
- Repeated append is idempotent.
- Partial failures return per-item receipts and do not lose successes.
- Sharing and consent rejections are covered by negative tests.
- Legacy temporal aliases are input-only.
- A non-Stella provider fixture validates that the wire schema is general.

## 15. Crate ownership matrix

Adapt names if the repository has moved, but preserve the boundaries.

| Area | Primary responsibility |
| --- | --- |
| `stella-core` | Pure taxonomy, invariants, scoring inputs, governance decisions, contract result semantics |
| `stella-context` | `context.db`, temporal queries, record repositories, frame compilation, compaction metadata, health projections |
| `stella-store` | Raw executions, events, tool calls, journal replay inputs |
| `stella-pipeline` | Context assembly, contract selection, validation gating, outcome emission |
| `stella-protocol` | Internal additive events and external protocol adapters without storage dependencies |
| `stella-graph` | Source-code graph retrieval only; no duplicate lifecycle graph |
| `stella-cli` | Settings, diagnostics, proposal actions, explicit publication |
| `stella-tui` | Lightweight notices, Keep/Edit/Ignore, evidence and sharing disclosure |
| `stella-observatory` | Frame lineage, efficacy, contract, scope, and promotion inspection |

## 16. Required witness matrix

| Witness | Expected result |
| --- | --- |
| Feature disabled | Existing Stella behavior is unchanged |
| Legacy context database | Transactional migration with no lost memories or facts |
| Historical knowledge | `known_at` excludes records learned later |
| Historical validity | `valid_at` excludes nonapplicable records |
| Validity overlap | Any intersection with `[from, until)` matches |
| One noisy task | Cannot satisfy a three-task threshold |
| Three API tasks | Produce one eligible advisory rule proposal |
| Blocking inference | Always requires explicit confirmation |
| User preference | Never enters Git automatically |
| Existing rule files | Load and guard behavior remain unchanged |
| Prompt injection in logs | Remains untrusted evidence/observation data |
| Git follow-up edit | Is inferred, not a verified error |
| Journal replay | Creates no duplicate observation or use records |
| Compact frame | Is smaller, citable, rehydratable, and preserves exact constraints |
| Brand-kit omission | Contract fails and completion cannot be claimed |
| Brand-kit repair | All required output passes and outcome is verified |
| Negative context outcome | Becomes stale only with attributable evidence |
| Solo-to-team transition | Requires no schema migration and leaks no user data |
| Query-only provider | Operates unchanged |
| Lifecycle provider | Passes consent, sharing, idempotency, alias, and partial-failure tests |

## 17. Verification and release gates

Run repository-documented checks plus, where applicable:

```text
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Add:

- migration fixtures for every supported schema;
- canonical serialization snapshots;
- property tests for temporal intervals and scope non-widening;
- replay and idempotency tests;
- SQLite integrity checks;
- deterministic frame and prompt goldens;
- a token-efficiency benchmark;
- privacy and sharing negative tests;
- rule-frontmatter compatibility tests;
- the brand-kit end-to-end witness;
- a query-only and lifecycle-provider conformance fixture.

Roll out through:

```text
off
record_only
advisory
team_review
regulated
```

Rollback disables new selection, mining, or promotion. It never deletes
historical records.

## 18. Risk register

| Risk | Required mitigation |
| --- | --- |
| Memory and knowledge become two truth stores | Normalize into one context-record authority; treat indexes and rule mirrors as projections |
| Scope leakage | Central non-widening validator plus negative tests at storage, compiler, publication, and provider boundaries |
| Temporal semantics drift | One typed query API, half-open intervals, boundary truth tables |
| Compaction weakens a constraint | Per-item minimum fidelity, exact-content tests, canonical hash |
| User edits are called agent errors | Require deterministic, external, or explicit user evidence for verified conclusions |
| Generated prose poisons learning | Give observations no instruction authority and require independent evidence |
| One task manufactures recurrence | Count distinct task or episode IDs, not raw events |
| Rule formats diverge | Keep `.stella/rules/*.md` canonical for repository steering |
| Observation volume causes SQLite contention | Post-task batching, bounded excerpts, retention, measured indexes |
| Attribution punishes useful context | Require opportunity, method, and confidence; make suppression reversible |
| User confirmation becomes noisy | Batch notices and use advisory behavior before lightweight confirmation |
| Git identities trigger team mode incorrectly | Treat identity count as a signal and require user confirmation |
| Personal contracts leak | Default to user sharing and require explicit publication |
| New types create crate cycles | Pure core types, bounded internal event payloads, adapter boundaries |
| Deletion leaves derived private data | Track derivation edges and invalidate or rebuild projections |
| Protocol freezes Stella policy | Prove the lifecycle locally and keep governance host-side |
| Ambiguous project scope spreads | Omit `project_id` from core until a real registry exists |

## 19. Completion criteria

The implementation is complete only when:

- existing databases, rules, settings, provider queries, and code graph remain
  compatible;
- observations, evidence, knowledge, memories, directives, and contracts have
  unambiguous authority boundaries;
- every model-relevant durable record has stable identity, provenance, scope,
  sharing, and temporal meaning;
- every invocation has an inspectable deterministic `CompiledContextFrame`;
- `PromptContext` is compact without silently weakening exact semantics;
- extraction and replay are idempotent;
- inferred behavior cannot become blocking or shared automatically;
- artifact contracts prevent objectively incomplete completion claims;
- promotion and context-use histories are immutable and auditable;
- stale advisory context can be reversibly suppressed;
- solo-to-team migration changes policy, not schema;
- external lifecycle support remains optional; and
- no new account, server dependency, repository mutation, or phone-home
  behavior is introduced by default.
