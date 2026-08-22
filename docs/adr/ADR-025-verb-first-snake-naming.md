# ADR-025: Verb-first snake_case capability naming

**Status:** Accepted (user decision 2026-07-08)
**Supersedes:** ADR-022 (dotted `domain.subject.action` canonical form) — the dotted
canonical is retired and the ADR-022 alias mechanism is **removed entirely**. There is
exactly one name per capability, the verb-first snake_case one; no shim, no fallback.
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
it (rare) and is flagged by the lint. The wave initially produced two four-word,
scope-disambiguated names (`set_org_plugin_enabled`, `set_workspace_plugin_enabled`);
these have since been collapsed into the single `set_plugin_enabled` with a `scope`
argument (§5), so no four-word capability names remain.

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

### 4. No aliases — the rename is a hard, in-repo cutover

The ADR-022 alias mechanism is **removed**. There is no `aliases[]` field, no alias
index in the registry, no alias fallback in `getCapability`, and no alias matching in
IAM. A capability answers to exactly one name — its canonical verb-first snake_case
name — and nothing else.

This is safe because the rename is an atomic, in-repo cutover: every contract, route,
MCP tool, handler, test, and import site is renamed together on this
branch, so no in-repo caller ever references an old name. The prior alias shim existed
only to bridge a staged rollout; a single-commit-wave rename does not need it, and the
dead machinery would be pure bloat.

- The **registry** resolves `getCapability(name)` by canonical name only.
- The **kernel** dispatches, gates (IAM / billing / entitlement), and **meters** every
  call under the one canonical name.
- **IAM** matches `role_grants` rows by the exact canonical `capability_id`. Any durable
  rows written under an old dotted name are realigned by the rename mapping, not by a
  runtime alias.
- **API HTTP paths are unaffected** — they are hand-authored and
  independent of the capability name.
- **Billing is safe by construction** — revenue keys on `model` + `execution_step_id`,
  never the capability name.

The core-seven engine tools (`read_file`, `write_file`, `edit_file`, `run_command`,
`search`, `list_files`, `todo_write`) keep their exact names — they already conform
and are not registered capabilities (they live in the agent engine, outside
`packages/oxagen/src/contracts`), so the lint does not touch them.

### 5. Merges: scope-collapse vs true duplicates

- **Scope-collapse (DONE):** the former `plugin.org.set_enabled` +
  `plugin.workspace.set_enabled` are collapsed into a single `set_plugin_enabled`
  capability that takes a `scope: "org" | "workspace"` argument. The one handler
  branches on `scope` (org → toggle the org-listing flag; workspace → upsert/disable
  the workspace `agent.mcp_servers` row); output is `{ ok, workspaceServerId }`
  (`workspaceServerId` null for org scope and workspace disable). Contract, handler,
  API route (`POST /plugin/set-enabled`), MCP tool, docs, and tests are all merged;
  the two old contracts/files are deleted.
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
grandfathered name was renamed to a conforming verb-first form. A non-conforming name
is now a bug to fix, never a grandfather entry.

## Consequences

- **All 294 registered capabilities renamed** to verb-first snake_case. The authoritative
  old→new mapping is `docs/specs/adr025-naming-mapping.md`; the machine-readable source is
  `tools/scripts/adr025-name-map.mjs`.
- **Nothing breaks in-repo:** every in-repo caller, route, tool, and test is renamed in
  the same wave, external REST paths are unchanged, and metering attributes to the
  canonical name.
- **Contract/route/mcp/docs FILE names and the ~895 dotted contract-import sites are a
  separate realignment phase.** The functional rename (contract `name` + aliases) is
  complete and self-consistent; `check_manifest.mjs`'s file-path heuristic (which keys
  `apps/api/src/routes/v1/<name>.ts` and `apps/mcp/src/tools/<name>.ts` off the
  capability name) reports api/mcp gaps until those files are moved to the new names.
  That move + the import/index/app-mount/docs updates is tracked as the follow-up file
  phase.
- **Follow-ups:** (a) rename contract/route/mcp/docs files to the new names and rewrite
  import sites, clearing the manifest file-path gaps.
