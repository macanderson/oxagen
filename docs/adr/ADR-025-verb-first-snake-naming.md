# ADR-025: Verb-first snake_case capability naming

**Status:** Accepted (user decision 2026-07-08)
**Supersedes:** ADR-022 (dotted `domain.subject.action` canonical form) — the dotted
canonical is retired; every old dotted name survives only as an `aliases[]` entry.
**Related:** ADR-009 (unified capability/tool model via `surfaces`), `docs/VISION.md`

> Numbering note: the naming-standard work was scoped as "ADR-024" but that number
> was taken by ADR-024 (namespaced agent identity), which landed on `main` from a
> parallel session, so this ADR is **025**. The branch/PR retain the `adr024` slug.

## Context

ADR-022 made capability names dotted three-part strings (`domain.subject.action`,
e.g. `org.create`, `connection.list`, `agent.subagent.dispatch`). A capability name
is a load-bearing key: it joins the contract registry, the kernel handler-loader,
the IAM `role_grants.capability_id` column, the ClickHouse
`tool_invocations.capability_name` analytics column, and the model-facing tool name.

The dotted form has one decisive weakness: it is **not** the shape a model reads
best. The repo's own core engine tools — the primitives the coding agent uses every
turn — are already verb-first snake_case: `read_file`, `write_file`, `edit_file`,
`run_command`, `search`, `list_files`, `todo_write`. A model that has learned those
primitives then meets a *second*, dotted vocabulary (`org.create`,
`agent.subagent.dispatch`) for the other ~294 capabilities. Two grammars for one tool
surface makes tool selection harder and the surface less legible. The dotted form
also front-loads a taxonomy (`domain.subject`) the model does not need in order to
call the tool, and buries the verb — the one token that says what the tool *does* —
in the last position.

The user's decision: converge the **entire** capability surface onto the engine-tool
shape. One grammar, verb-first, for everything the agent can call.

## Decision

### 1. Canonical form: `verb_noun` or `verb_noun_qualifier`

Every capability name is lowercase `[a-z0-9]` words joined by `_`, with the
**imperative verb first**, then the entity it acts on, then an optional third
disambiguating word:

- `create_org`, `list_orgs`, `get_org`, `update_org`
- `list_connections`, `dispatch_subagent`, `cancel_subagent`, `send_message`
- `install_plugin`, `uninstall_plugin`, `list_sandbox_files`, `read_sandbox_file`
- `run_workflow`, `list_workflows`, `get_workflow_status`

**2–3 words.** A 4th word is allowed **only** where global uniqueness truly demands
it (rare) and is flagged by the lint. The wave produced exactly two four-word names,
both scope-disambiguated (`set_org_plugin_enabled`, `set_workspace_plugin_enabled`)
pending a handler-level merge (§5).

Dots and kebab-case are illegal. The dotted `domain.subject.action` form is retired.

### 2. Global uniqueness is mandatory

The name is a globally-unique key. No two capabilities may share a name. Where a
2-word name would collide (e.g. `list_agents` for both agent definitions and
subagents), disambiguate with a 3rd word: `list_agent_defs` vs `list_subagents`.
The lint (`tools/scripts/check-naming.mjs`) fails the build on any duplicate.

### 3. Scope is an argument, not part of the name

Org-vs-workspace (and similar) scope is carried in the call arguments, not encoded in
the name. Two old capabilities that differed **only** by scope collapse to one
canonical name whose scope moves into the input. Where such a collapse requires
consolidating two distinct handlers, it is deferred (§5) and the two names are
temporarily disambiguated by a scope word so nothing breaks meanwhile.

### 4. Aliases: nothing breaks on the rename

Renaming never orphans a caller, an IAM grant, or a pinned client. Every renamed
contract carries `aliases: [<old dotted name>, …]` (old dotted name prepended;
pre-existing aliases preserved). The ADR-022 §6 alias mechanism is unchanged and
load-bearing:

- The **registry** indexes each alias to its canonical contract; `getCapability(alias)`
  resolves to the new name.
- The **kernel** dispatches, gates (IAM / billing / entitlement), and **meters** every
  call under the canonical (new) name, whichever name the caller used.
- **IAM** matches legacy `role_grants` rows keyed by an old dotted name via the alias
  index — no data migration.
- **API HTTP paths and CLI paths are unaffected** — they are hand-authored and
  independent of the capability name.
- **Billing is safe by construction** — revenue keys on `model` + `execution_step_id`,
  never the capability name.

The core-seven engine tools (`read_file`, `write_file`, `edit_file`, `run_command`,
`search`, `list_files`, `todo_write`) keep their exact names — they already conform
and are not registered capabilities (they live in the agent engine, outside
`packages/oxagen/src/contracts`), so the lint does not touch them.

### 5. Merges: scope-collapse vs true duplicates

- **Scope-collapse (deferred):** `plugin.org.set_enabled` + `plugin.workspace.set_enabled`
  should collapse to `set_plugin_enabled(scope)`, but their handlers differ, so the
  merge is deferred (needs handler consolidation). They are named
  `set_org_plugin_enabled` / `set_workspace_plugin_enabled` for now.
- **Flagged possible-duplicates — VERIFIED DISTINCT, not merged:**
  - `budget.policy.*` is a **per-user** turn budget (domain `user`) →
    `get_user_budget` / `update_user_budget`; `workspace.budget_policy.*` is the
    **org/workspace-governed** budget → `get_budget_policy` / `update_budget_policy`.
  - `conversation.chat` is a **sync** "post a message" → `post_conversation_message`;
    `chat.message.send` is **async** and streams the reply → `send_message`.
  - `integration.*` vs `plugin.org.*` use distinct nouns already; kept separate.

### 6. Lint enforcement & the grandfather list

`tools/scripts/check-naming.mjs` (wired into `pnpm check:contracts`) enforces:
snake_case charset (no dots, no kebab), verb-first (first word in the closed verb
set), 2+ words (4+ is a non-blocking warning), and **global uniqueness** (hard fail on
any duplicate). The ADR-022 `GRANDFATHER` map is **emptied** — every previously
grandfathered name was renamed to a conforming verb-first form (each carries its old
dotted name in `aliases[]`). A non-conforming name is now a bug to fix, never a
grandfather entry.

## Consequences

- **All 294 registered capabilities renamed** to verb-first snake_case, each with the
  old dotted name (plus any prior aliases) in `aliases[]`. The authoritative old→new
  mapping is `docs/specs/adr025-naming-mapping.md`; the machine-readable source is
  `tools/scripts/adr025-name-map.mjs`.
- **Nothing breaks at runtime:** callers resolve through the alias index, IAM grants
  keep matching, external REST/CLI paths are unchanged, and metering attributes to the
  canonical name.
- **Contract/route/mcp/docs FILE names and the ~895 dotted contract-import sites are a
  separate realignment phase.** The functional rename (contract `name` + aliases) is
  complete and self-consistent; `check_manifest.mjs`'s file-path heuristic (which keys
  `apps/api/src/routes/v1/<name>.ts` and `apps/mcp/src/tools/<name>.ts` off the
  capability name) reports api/mcp gaps until those files are moved to the new names.
  That move + the import/index/app-mount/docs updates is tracked as the follow-up file
  phase.
- **Follow-ups:** (a) rename contract/route/mcp/docs files to the new names and rewrite
  import sites, clearing the manifest file-path gaps; (b) execute the deferred
  `set_plugin_enabled(scope)` handler merge; (c) retire aliases once no durable row
  references an old dotted name.
