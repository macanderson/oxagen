# TOML Agent Artifacts and Deterministic Lifecycle Driver Design

**Status:** Approved design

**Date:** 2026-07-21

## Summary

Oxagen will replace Markdown files with YAML frontmatter for agents, skills, and
slash commands with versioned TOML artifacts. TOML becomes the only executable
artifact format. Markdown remains valid prose inside multiline TOML strings and
as a skill sidecar/reference format, but it is no longer a manifest format.

Oxagen will also ship an import engine for Claude Code, Codex, and Cursor. The
engine discovers foreign artifacts, parses them through platform-specific
adapters, converts them into Oxagen-owned TOML, maps foreign tool names to
canonical Oxagen tool identifiers, and records unresolved mappings for explicit
review. Imported artifacts are independent regular files; Oxagen does not rely
on symlinks or foreign runtime directories after import.

Agent TOML gains a deterministic lifecycle driver. It invokes required Oxagen
capabilities outside model discretion at declared lifecycle events, validates
typed turn input and output, supports small structured prompt patches before
intelligence receives the prompt, and emits receipts proving what ran.

## Goals

1. Make TOML the only executable format for Oxagen agents, skills, and slash
   commands.
2. Preserve skill bundles and their scripts, references, examples, templates,
   and other sidecar assets.
3. Import Claude Code, Codex, and Cursor artifacts without retaining a runtime
   dependency on those tools.
4. Translate foreign tool names into identifiers that exist in Oxagen's live
   tool catalog.
5. Fail safely on unknown or ambiguous tool mappings without losing the source
   information needed for review.
6. Let customers declare deterministic capability invocations around a turn,
   model call, or model-selected tool call.
7. Let customers contract agent input and output using portable JSON Schema.
8. Let pre-intelligence capabilities return bounded, typed prompt patches.
9. Route every lifecycle capability through the existing `invoke()` kernel so
   IAM, tenancy, entitlements, billing, metering, and lineage remain centralized.
10. Produce durable, replayable evidence for lifecycle execution and prompt
    mutation.

## Non-goals

- Oxagen will not become a general content-moderation or model-safety engine.
  Model providers retain their safety boundary; Oxagen enforces the platform
  boundaries it controls.
- Version 1 will not support arbitrary code in TOML or arbitrary prompt
  replacement.
- Version 1 will not infer authorization mappings from semantic similarity.
- Version 1 will not delete or rewrite foreign Claude Code, Codex, or Cursor
  source files.
- Version 1 will not convert Oxagen rules, memories, prompts, MCP configuration,
  or convention files. The scope is agents, skills, and slash commands.
- The normal runtime will not dual-read legacy Markdown.
- The importer will not require a model. A future assistant may explain
  diagnostics or suggest mappings, but suggestions cannot grant access.

## Design principles

### Canonical ownership by storage plane

For filesystem artifacts, the TOML document is canonical. For workspace-managed
artifacts, an immutable version row stores the canonical TOML source while
indexed relational columns are projections updated transactionally with that
version. UI edits create a new canonical version and its projections in one
transaction; they never update a projection without regenerating the TOML.

In-memory types, generated indexes, and rendered prompts are projections. A
foreign source is import input, not a continuing source of truth after import.

### Model choice and runtime guarantees are different contracts

`tools` declares what intelligence may choose. `driver.invocations` declares
what the Oxagen runtime must execute. Required lifecycle work is never enforced
by prompt wording or left to model discretion.

### Conversion is compatibility; runtime is not

Foreign and legacy parsers exist only inside import adapters. After conversion,
the ordinary loader reads Oxagen TOML directories only.

### Authorization mappings must be exact

Tool mapping can only authorize a known target through an exact, versioned
registry entry or an explicit user choice. An ambiguous name remains unresolved.

### Receipts are part of the feature

A deterministic call without durable evidence is not a useful enterprise
guarantee. Every lifecycle attempt and prompt mutation contributes to the turn
receipt.

## Canonical artifact module

A shared, dependency-light module will own:

- Zod schemas for all three artifact kinds.
- TOML parsing and deterministic serialization.
- `schema_version` dispatch.
- Artifact validation and normalized error formatting.
- Safe relative-path resolution for sidecar files and JSON schemas.
- Lifecycle invocation and prompt-patch schemas.
- Lifecycle eligibility metadata used by capability contracts.
- Runtime-ready versus needs-review classification.
- Import candidate and receipt types shared by the import adapters and tests.
- The foreign-tool mapping registry format and target validation.
- Canonical hashing helpers for TOML documents and structured receipt values.

Every server, handler, code generator, and seeder consumes these shared
types. Oxagen must not retain separate parsers with subtly different behavior.

## Canonical TOML formats

### Agent

Project agents live at `.oxagen/agents/<slug>.toml`. User agents live in the
canonical Oxagen user configuration directory under `agents/<slug>.toml`.

```toml
schema_version = 1
kind = "agent"

name = "support-agent"
description = "Handles customer support cases"
model = "balanced"

developer_instructions = """
Resolve the customer issue using verified workspace context.
"""

tools = [
  "read_file",
  "grep",
  "recall_memory",
]

skills = ["support-policy"]
unresolved_tools = []

[input]
schema = "./schemas/support-turn-input.schema.json"

[output]
schema = "./schemas/support-turn-output.schema.json"

[driver]
delivery = "buffered"

[[driver.invocations]]
id = "hydrate-context"
event = "before_intelligence"
capability = "build_support_prompt_patch"
required = true
apply_as = "prompt_patch"
timeout_ms = 5000
on_error = "block"

[driver.invocations.input]
query = { from = "/turn/input/question", required = true }
customer_id = { from = "/turn/input/customer_id", required = true }

[[driver.invocations]]
id = "authorize-tool"
event = "before_tool_call"
capability = "authorize_support_tool"
required = true
timeout_ms = 2000
on_error = "block"

[[driver.invocations]]
id = "record-lineage"
event = "before_finalize"
when = "always"
capability = "record_support_lineage"
required = true
timeout_ms = 5000
on_error = "retry"
max_attempts = 3
```

Agent semantics:

- `schema_version` is required and is the compatibility gate.
- `kind` must be `"agent"`.
- `name` is a kebab-case portable artifact slug.
- `developer_instructions` is the full agent instruction text. It may contain
  Markdown syntax as prose.
- `model` is an Oxagen model alias or model identifier accepted by the model
  resolver, not a foreign platform alias copied blindly.
- `tools` contains canonical identifiers from Oxagen's live tool catalog.
- `skills` contains canonical skill slugs.
- A non-empty `unresolved_tools` list makes the artifact `needs_review` and
  excludes it from execution.
- `input.schema` and `output.schema` are paths relative to the agent TOML file.
  Version 1 accepts local JSON Schema files only.
- A contracted agent uses buffered delivery so output is not released before
  post-intelligence processing and final output validation complete.
- `build_support_prompt_patch`, `authorize_support_tool`, and
  `record_support_lineage` are illustrative customer/plugin capability slugs.
  They must be registered in Oxagen with compatible contracts before this
  example can activate; lifecycle configuration never creates a capability by
  naming it.

### Skill

Skills remain directory bundles. The manifest lives at
`.oxagen/skills/<slug>/skill.toml`; sidecar assets keep their relative layout.

```toml
schema_version = 1
kind = "skill"

name = "support-policy"
description = "Applies the approved customer-support policy."

instructions = """
# Support policy

Follow the escalation and disclosure rules in this skill.
"""

references = [
  "references/escalation-matrix.md",
  "templates/customer-response.txt",
]

[metadata]
weight = "high"
category = "support"
```

Skill semantics:

- `kind` must be `"skill"`.
- `instructions` replaces the Markdown manifest body but may contain Markdown
  prose.
- `references` is explicit; the loader no longer scrapes a prose heading to
  discover files.
- Reference paths must be relative, must resolve inside the skill directory,
  and must not traverse symlinks outside the bundle.
- Scripts and other assets can remain sidecars. Their presence does not make
  them executable without a separate governed capability or sandbox policy.

### Slash command

Commands live at `.oxagen/commands/<slug>.toml`.

```toml
schema_version = 1
kind = "command"

name = "escalate-case"
description = "Escalate a customer case with the required evidence."
argument_hint = "<case-id> [reason]"

prompt = """
Escalate case $1.

Reason supplied by the operator:
$ARGUMENTS
"""
```

Command semantics:

- `kind` must be `"command"`.
- `prompt` replaces the Markdown body.
- Existing `$ARGUMENTS` and `$1` through `$9` expansion behavior remains.
- Commands may select an agent or model only through canonical Oxagen fields
  added to the shared schema; foreign provider aliases are normalized during
  import.

## Tool identifiers

Oxagen currently has two legitimate tool identity classes:

1. Stable local/core tool identifiers such as `read_file`, `edit_file`, `grep`,
   and `bash`.
2. Governed platform capability names registered under ADR-025's verb-first
   snake-case convention, such as `create_issue`.

Both classes can appear in an agent's `tools` list only when the live tool
catalog confirms them. Lifecycle invocations are stricter: their `capability`
must resolve through the capability registry and always execute through
`invoke()`.

The design does not create another permanent naming layer. Provider-facing
names are adapter inputs; canonical Oxagen identifiers are stored in TOML.

Foreign permissions are not assumed to be one-to-one with tools. A source
permission class may map to an explicit ordered set of Oxagen identifiers when
that set preserves the source semantics. For example, a broad foreign read
permission may intentionally cover `read_file`, `list_dir`, `glob`, and `grep`.
The mapping registry stores the complete set and its rationale; runtime access
is still the intersection of that set, the agent allowlist, installed tools,
entitlements, and IAM grants.

## Lifecycle capability eligibility

Naming a registered capability in agent TOML is not sufficient to make it a
lifecycle capability. Capability contracts opt in with metadata equivalent to:

```ts
interface CapabilityLifecycleMetadata {
  allowedEvents: LifecycleEvent[];
  effect: "read" | "mutation";
  idempotency: "none" | "supported" | "required";
  outputKinds: Array<"opaque" | "prompt_patch" | "decision">;
}
```

Agent activation compiles every invocation against the live registry and fails
closed when:

- The capability has no lifecycle metadata.
- The event is not allowed.
- `apply_as` is incompatible with the declared output kind.
- Retry is configured for a mutating capability without idempotency support.
- A deployment output schema is missing, unsafe, or cannot be compiled. The
  kernel contract always validates first, so the additional schema can reject
  more values but can never widen what the capability returns.

Lifecycle execution remains inside `invoke()`, but the kernel receives an
internal execution kind and lifecycle event instead of pretending the runner is
an external `agent` surface. The kernel checks lifecycle metadata independently
from API/MCP/agent exposure and records `ctx.surface = "runner"` in audit and
metering data.

## Deterministic lifecycle driver

### RunSpec V2 principal requirement

The lifecycle driver cannot ship on the current principal-less durable run
shape. RunSpec V2 records the originating principal reference and delegation
context needed to re-resolve authorization at execution time:

```ts
interface RunPrincipalRefV1 {
  kind: "user" | "api_key" | "service" | "agent";
  id: string;
  userId?: string;
  apiKeyId?: string;
  delegatedByPrincipalId?: string;
  delegationGrantId?: string;
}
```

The run stores identity references, not a copied grant snapshot. At claim time,
the driver re-resolves the principal and current grants, then applies the same
human/agent/service and delegation intersections as synchronous execution. A
deleted, disabled, expired, or unresolvable principal fails closed before any
lifecycle capability or model call.

### Event model

The canonical term is **lifecycle invocation**. A hook is an implementation
mechanism; an invocation is an execution contract.

| Event | Cadence and timing |
|---|---|
| `before_turn` | Once after the agent input schema creates a typed turn envelope |
| `before_intelligence` | Once before intelligence receives the effective prompt |
| `before_model_call` | Before every model call in an agentic loop |
| `after_model_call` | After every model response in an agentic loop |
| `before_tool_call` | Before each model-selected tool executes |
| `after_tool_call` | After each model-selected tool succeeds or fails |
| `after_intelligence` | Once after candidate final output and before final output validation |
| `before_finalize` | Once while the turn is in `finalizing`, before terminal commit and output release |
| `after_turn` | Durable observer scheduled atomically with terminal commit; cannot change the committed outcome |

Invocations execute sequentially in TOML declaration order in version 1. This
makes ordering visible and replayable. Parallel lifecycle execution is outside
the first release.

### Typed turn envelope

Every invocation receives a runtime-owned event envelope. Fields unavailable at
a particular event are absent rather than `null` guesses.

```ts
interface LifecycleEventEnvelope {
  schemaVersion: 1;
  event: LifecycleEvent;
  invocationId: string;
  idempotencyKey: string;
  turn: {
    id: string;
    input: unknown;
    metadata: Record<string, unknown>;
    status: "running" | "succeeded" | "rejected" | "failed" | "cancelled";
  };
  agent: {
    name: string;
    artifactHash: string;
  };
  principal: {
    orgId: string;
    workspaceId: string;
    kind: "user" | "api_key" | "service" | "agent";
    principalId: string;
    delegatedByPrincipalId?: string;
    delegationGrantId?: string;
  };
  prompt?: {
    effectiveHash: string;
  };
  modelCall?: {
    index: number;
    modelId: string;
  };
  toolCall?: {
    id: string;
    name: string;
    input: unknown;
    outcome?: "success" | "failure" | "denied";
  };
  candidateOutput?: unknown;
  error?: {
    code: string;
    message: string;
  };
}
```

The envelope carries identifiers and typed data required for policy and
lineage. It must not expose secrets merely because they exist in surface-local
state.

### Configurable invocation input

`driver.invocations.input` maps capability input fields from the event envelope
using JSON Pointer. Each entry uses either `from` or `literal`, never both.

```toml
[driver.invocations.input]
case_id = { from = "/turn/input/case_id", required = true }
phase = { literal = "preflight" }
```

The driver builds the capability input, then `invoke()` validates it against the
registered capability contract. A missing required pointer is
`lifecycle_invalid_input`; it is not passed to the handler.

The mapping language intentionally has no expressions, shell interpolation, or
embedded code in version 1.

### Configurable output contracts

The agent's final output is validated against `output.schema`. A lifecycle
capability's normal output is already validated by its registered capability
contract. An invocation may additionally name a local JSON Schema when the
customer wants a narrower deployment-specific projection.

```toml
[[driver.invocations]]
id = "validate-response"
event = "after_intelligence"
capability = "validate_support_response"
required = true
output_schema = "./schemas/approved-response.schema.json"
on_error = "block"
```

The narrower schema can reject output but cannot broaden the capability's
registered output contract.

### Failure semantics

`on_error` accepts:

- `block`: stop advancement and terminate the turn as failed or rejected.
- `retry`: retry up to `max_attempts`, then block when `required = true` or
  continue when `required = false`.
- `continue`: record the failure and continue; valid only for
  `required = false`.

Retries use one stable idempotency key for the logical invocation. The kernel
adds it to `CheckedContext`; it is not injected into raw capability input where
strict schemas could reject it. Contract lifecycle metadata declares whether a
handler supports or requires idempotency, and activation rejects unsafe retry
configurations. Oxagen guarantees ordered attempt and result handling; it cannot
guarantee that an unavailable external MCP server succeeds.

`when` accepts `success`, `failure`, or `always` on finalization and terminal
events. A `before_finalize` invocation can block terminal commit and buffered
output. An `after_turn` invocation runs from the durable outbox after terminal
commit; it is retried and dead-lettered according to policy but cannot rewrite
the committed turn outcome.

Timeouts compose with the turn abort signal. A timeout never leaves the driver
waiting indefinitely. Required failures before terminal commit prevent buffered
output release. Customers that require an external side effect to succeed before
delivery configure it at `before_finalize`, not `after_turn`.

### Prompt patches

Only `before_intelligence` and `before_model_call` invocations may use
`apply_as = "prompt_patch"` in version 1.

The patch result contains an ordered list drawn from a small operation set:

- `prepend_system_context`
- `append_system_context`
- `prepend_user_context`
- `append_user_context`
- `redact_input_path`
- `replace_input_path`
- `add_metadata`
- `reject_turn`

Each operation has a bounded payload and an explicit target. Patches cannot
replace the complete prompt, execute code, change the principal, add tools,
raise a risk ceiling, bypass approval, or alter lifecycle configuration.

The driver validates the patch, applies operations in order, and records the
input prompt hash, patch hash, and output prompt hash. Full prompt contents are
not placed into telemetry by default.

### Delivery contract

An agent with typed output or required post-intelligence lifecycle work uses
`driver.delivery = "buffered"`. Intelligence may stream internally for latency
and telemetry, but no candidate output is released to the caller until:

1. `after_intelligence` invocations succeed.
2. The final output passes the agent output schema.
3. Required `before_finalize` work succeeds.

Chunk-level output policy and irreversible provisional streaming are outside
version 1 because they weaken the stated contract.

### Kernel integration

The existing durable turn driver remains the owner of tenant scope and turn
execution. Lifecycle invocations call the capability kernel with the same
`CapabilityContext` and principal attribution as the turn.

This preserves the existing enforcement sequence:

```text
registry and contract
  -> tenant and principal scope
  -> IAM
  -> billing admission
  -> plugin entitlement
  -> handler
  -> output validation
  -> audit, metering, and lineage
```

Direct handler calls and raw MCP calls are forbidden in lifecycle execution. An
MCP-backed lifecycle operation is exposed through a canonical Oxagen capability
whose handler delegates to the entitled server.

Lifecycle invocations never recursively emit model tool lifecycle events.
`before_tool_call` and `after_tool_call` apply only to tool calls selected by
intelligence. Kernel calls made by lifecycle handlers, and nested capability
calls made by ordinary handlers, retain trace lineage but do not re-enter the
lifecycle event dispatcher. The driver carries an execution-origin/depth marker
and fails closed on an attempted lifecycle cycle.

### Finalization state machine

The turn state machine is:

```text
running
  -> finalizing
  -> succeeded | rejected | failed | cancelled
```

The driver enters `finalizing` after candidate-output processing. It executes
matching `before_finalize` invocations, validates the final output, and commits
the terminal state plus all `after_turn` outbox obligations atomically. Buffered
output is released only after that commit. Outbox workers execute `after_turn`
obligations at least once with stable idempotency keys and durable receipts.

This separates a blocking pre-commit guarantee from a durable post-commit
observer and prevents an `after_turn` failure from leaving a logically terminal
turn stuck indefinitely.

## Lifecycle receipts

The driver emits an append-only receipt for each logical invocation:

```ts
interface LifecycleInvocationReceipt {
  schemaVersion: 1;
  turnId: string;
  invocationId: string;
  event: LifecycleEvent;
  capability: string;
  idempotencyKey: string;
  attempts: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: "succeeded" | "continued" | "blocked" | "cancelled";
  inputHash: string;
  outputHash?: string;
  promptBeforeHash?: string;
  patchHash?: string;
  promptAfterHash?: string;
  errorCode?: string;
}
```

Receipts join the existing append-only run event and lineage model. They contain
hashes and safe metadata by default, not raw sensitive inputs or prompts.

Artifact hashes use SHA-256 over UTF-8 deterministic TOML with LF line endings.
Structured input, output, patch, and receipt hashes use RFC 8785 JSON
Canonicalization Scheme bytes before SHA-256. Values that cannot be represented
under the canonical JSON rules are rejected before hashing rather than coerced.

## Import and conversion engine

### Architecture

The importer uses one normalized pipeline:

```text
discover
  -> source adapter parse
  -> normalized ImportCandidate
  -> tool mapping
  -> canonical validation
  -> preview and conflict resolution
  -> staged write
  -> atomic activation
  -> import receipt
```

Each platform adapter owns only discovery and source parsing. Shared stages own
normalization, validation, conflict handling, serialization, and writes.

### Supported source platforms

Version 1 supports Claude Code, Codex, and Cursor at user and workspace scope.
Adapters scan the platforms' documented agent, skill, and command locations,
plus configured source directories already recognized by Oxagen's indexer.

The scanner deduplicates shared paths such as `.agents/skills` by resolved file
identity and content hash. One physical source never produces duplicate
candidates merely because more than one platform recognizes its location.

### Import candidate

```ts
interface ImportCandidate {
  kind: "agent" | "skill" | "command";
  platform: "claude" | "codex" | "cursor";
  scope: "user" | "workspace";
  sourcePath: string;
  sourceHash: string;
  slug: string;
  normalizedDefinition: unknown;
  mappedTools: string[];
  unresolvedTools: string[];
  diagnostics: ImportDiagnostic[];
}
```

Parsing is side-effect-free. A candidate is not an installed artifact.

### Tool mapping registry

Mappings are versioned and source-specific. A mapping records:

- Source platform.
- Exact foreign identifier.
- One or more canonical Oxagen target identifiers, preserving the foreign
  permission's actual breadth without widening it.
- Mapping-registry version.
- Optional source-version constraints.
- Rationale and tests.

Automatic mappings require an exact registry entry and a live target in the
Oxagen catalog. For example, Claude's `Read` can map to the appropriate stable
Oxagen read tool identifiers according to the source semantics; the importer
must not silently widen one narrow foreign permission into every read-like
capability.

Foreign MCP names resolve by exact server identity plus tool identity. The
importer maps to an installed Oxagen capability only when that binding is
provable. Similar names remain unresolved.

Unresolved tool entries are preserved in `unresolved_tools`, produce a visible
diagnostic, and make the artifact `needs_review`. They are never treated as
wildcards and never cause Oxagen to grant all tools.

### User experience

Import runs against a chosen set of source platforms and scopes, with dry-run
and JSON output modes, and a conflict policy of skip, rename, or overwrite.

Interactive conflicts are resolved per item with:

- Import/replace.
- Rename.
- Map unresolved tool.
- Skip.
- View normalized diff.

Non-interactive mode skips conflicts by default. Overwrite and rename require
explicit flags. JSON output is stable and contains no interactive prose.

### Artifact states

- `ready`: canonical TOML with no unresolved execution fields.
- `needs_review`: safely serialized for review but excluded from runtime
  discovery.
- `rejected`: malformed, unsafe, unsupported, or schema-invalid; nothing is
  installed.

Needs-review files are written to a review staging area rather than an active
runtime directory. Promoting one requires successful canonical validation.

### Ownership, symlinks, and assets

- Foreign sources remain untouched.
- Imported destinations are regular files owned by Oxagen.
- The scanner can read a symlink as a source candidate, but validates the
  resolved source against allowed scan roots.
- Replacing an existing `.oxagen` symlink requires explicit confirmation.
- The writer stages the full destination and atomically renames it into place.
- Skill sidecar assets are copied with path-containment and symlink checks.
- A failed copy or validation leaves the existing destination unchanged.

After success, the active Oxagen artifact has no filesystem dependency on the
foreign source.

### Idempotency and import receipts

Import receipts record:

- Source platform, normalized source path, and source hash.
- Destination path and canonical artifact hash.
- Artifact kind and slug.
- Mapping-registry version.
- Applied and unresolved mappings.
- Conflict decision.
- Import timestamp and result.

Receipts are local operational metadata and do not add machine-specific paths
to the canonical TOML. Re-importing an unchanged source reports `unchanged` and
does not rewrite the artifact.

## Platform-wide cutover

The same release converts and updates:

- Local agent, skill, and command loaders.
- Configuration indexing.
- Bundled skills under `packages/skills` and their code generator.
- Skill authoring, drafting, editing, revision, version upload, version get, and
  export handlers.
- Capability contracts and MCP/API descriptions that currently name
  `.skill.md`, YAML frontmatter, `skillMd`, or parsed frontmatter.
- Workspace/database skill version content.
- Seeders and generated built-in skill data.
- Agent-builder generation prompts and artifact downloads.
- Documentation, examples, and focused inventory specifications.

An immutable managed-artifact version stores the canonical TOML source.
Relational columns used for lookup, filtering, and joins are projections and are
written in the same transaction as the version. Format-specific API fields
become `content` or `skillToml`; parsed metadata becomes a canonical parsed
artifact projection rather than `frontmatter`.

The importer remains able to read legacy Oxagen Markdown as a source dialect so
customers can convert after upgrading. That parser is not reachable from normal
artifact loading or execution.

## Stable errors

The shared module and driver expose stable codes:

- `unsupported_schema_version`
- `invalid_toml`
- `invalid_artifact`
- `invalid_reference_path`
- `unresolved_tool`
- `unknown_capability`
- `conflict`
- `unsafe_symlink`
- `principal_unresolved`
- `lifecycle_ineligible`
- `lifecycle_invalid_input`
- `lifecycle_timeout`
- `lifecycle_invalid_output`
- `lifecycle_blocked`
- `lifecycle_cycle`
- `finalization_failed`
- `prompt_patch_rejected`

Errors flow through Oxagen's typed error conventions. Required runtime failures
fail closed. Import errors remain non-destructive and item-scoped so one corrupt
foreign artifact does not hide other valid candidates.

## Security boundaries

- TOML and foreign source files are untrusted input.
- Parsers never execute embedded instructions, scripts, or shell expressions.
- JSON Schema references and skill assets must remain within their owning
  artifact directory.
- Import scanning uses explicit roots and bounded traversal.
- Symlinks are resolved and containment-checked before reads or copies.
- Tool mapping cannot broaden permissions through fuzzy matching.
- Durable runs re-resolve the stored principal and current grant intersections
  before model or lifecycle execution.
- Lifecycle invocations cannot bypass the kernel.
- Capability lifecycle eligibility is checked at agent activation and again at
  invocation.
- Prompt patches cannot add tools, identities, permissions, or lifecycle work.
- Receipts redact raw sensitive values by default.
- Required invocation output is validated before it can affect the turn.

## Test strategy

### Canonical format

- Parse and serialize round trips for agents, skills, and commands.
- Deterministic serialization and artifact hashes.
- RFC 8785 structured hashing and rejection of non-canonical values.
- Required fields, unknown fields, kind mismatches, and schema-version behavior.
- JSON Schema reference containment and validation.
- Skill reference containment, missing assets, and unsafe symlinks.
- Non-empty `unresolved_tools` produces `needs_review` and never executes.

### Import adapters

- Representative Claude Code agent, skill, and command fixtures.
- Representative Codex agent and skill/workflow fixtures.
- Representative Cursor agent, skill, and command fixtures.
- Shared-path deduplication.
- Known exact tool mappings.
- Exact one-to-many permission mappings preserve, but never widen, source
  semantics.
- Unknown and ambiguous mappings remain unresolved.
- Exact MCP server/tool resolution.
- Interactive conflict decisions and non-interactive skip defaults.
- Dry-run performs no writes.
- Source originals remain byte-identical.
- Symlink replacement creates independent regular files only after confirmation.
- Skill bundle copying rejects traversal and out-of-root symlinks.
- Re-import by source hash is idempotent.
- A failed staged write preserves the previous destination.

### Runtime loaders and platform cutover

- Normal loaders read only canonical Oxagen TOML directories.
- Normal loaders ignore Markdown and foreign directories.
- Every bundled artifact parses and validates.
- Generated built-in data matches canonical source artifacts.
- Skill create/edit/version/export round trips through TOML.
- API and MCP contracts expose format-neutral or TOML-specific fields only.

### Lifecycle driver

- Input is validated before `before_turn`.
- RunSpec V2 principal references are re-resolved and missing/expired principals
  fail closed.
- Agent activation rejects capabilities or events without compatible lifecycle
  metadata.
- Events fire at their declared cadence.
- Invocations run in declaration order.
- Input mappings resolve JSON Pointers and literals correctly.
- Missing required mappings fail before kernel invocation.
- Every lifecycle capability uses `invoke()` with tenant and principal context.
- Required failure blocks advancement and buffered delivery.
- Optional continue records the failure and advances.
- Retry count, stable idempotency key, timeout, and abort behavior.
- Retry on a mutating non-idempotent capability is rejected at activation.
- `before_finalize` blocks terminal commit and delivery when required work
  fails.
- Terminal state and `after_turn` outbox obligations commit atomically.
- `after_turn` with `when = "always"` is delivered at least once for success,
  rejection, failure, and cancellation without rewriting terminal outcome.
- Lifecycle and nested kernel calls do not recursively emit model-tool events;
  cycles fail closed.
- Capability output and optional deployment schema both validate.
- Prompt patches validate, apply in order, and cannot broaden authority.
- Prompt before/patch/after hashes appear in receipts.
- Final output is not released before post-intelligence and output validation.
- Receipts contain complete outcomes without raw sensitive payloads.

Tests remain co-located and are run through narrow package/file commands during
implementation, consistent with repository policy.

## Documentation and migration experience

Documentation will include:

- Canonical schemas and annotated examples for all artifact kinds.
- Lifecycle event cadence and envelope fields.
- Prompt-patch operations and limitations.
- Import source locations for each supported platform.
- Tool mapping and unresolved-review guidance.
- Conflict and symlink behavior.
- A migration guide for existing `.oxagen` Markdown artifacts and bundled
  skills.

Scaffolding creates TOML only. Error messages that encounter a legacy file
point directly to the import engine.

## Implementation decomposition

The approved product design spans three dependent delivery tracks and should be
planned and reviewed along those boundaries:

1. **Canonical TOML and hard cutover:** shared schemas, parser/serializer,
   bundled artifact conversion, local loaders, database/API skill content, and
   documentation.
2. **Import and conversion engine:** Claude Code, Codex, Cursor, and legacy
   Oxagen adapters; tool mapping; interactive review; atomic writes; receipts.
3. **Deterministic lifecycle driver:** typed turn envelope, JSON Schema
   contracts, event execution, prompt patches, failure semantics, buffered
   delivery, and lifecycle receipts.

Track 1 establishes the types consumed by tracks 2 and 3. Track 2 must be
available in the same customer-facing release as track 1's hard loader cutover.
Track 3 can be implemented behind the versioned agent schema after track 1 and
must not introduce a second artifact or invocation path.

## Rollout constraints

1. The shared canonical schema and parser land before any consumer switches.
2. The import engine and legacy adapters are available in the cutover release.
3. Repository-owned artifacts are converted using the same engine customers use.
4. All normal loaders switch atomically to TOML-only behavior.
5. Server capability contracts, handlers, generated data, and
   documentation move together so no supported surface advertises Markdown.
6. The lifecycle driver ships behind canonical schema validation; invalid
   lifecycle configuration prevents agent activation.
7. Vision, contract, manifest, and UI-parity checks remain required for the
   implementation diff.

## Success criteria

The feature is complete when:

- No normal agent, skill, or slash-command loader parses Markdown frontmatter.
- Repository-bundled skills and examples are TOML manifests.
- The import engine discovers Claude Code, Codex, Cursor, and legacy Oxagen
  artifacts.
- Imported artifacts are independent from their sources and symlinks.
- Foreign tools are either mapped to verified Oxagen identifiers or visibly
  unresolved and non-executable.
- Contracted agent inputs and outputs validate against customer JSON Schemas.
- Required lifecycle capabilities execute outside the model loop at every
  configured event and through the capability kernel.
- Durable runs execute lifecycle work under a re-resolved originating principal
  and current grant intersection.
- Structured prompt patches can mutate bounded prompt/input slots before
  intelligence receives them, with hashes and provenance.
- Required pre-finalization failures block output release according to declared
  policy, while post-turn observers use durable outbox delivery.
- Receipts prove execution order, attempts, outcomes, and prompt mutations.
- Focused tests cover conversion, safety, ordering, retries, contracts, and
  cutover behavior.
