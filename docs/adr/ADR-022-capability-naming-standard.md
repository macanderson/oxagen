# ADR-022: Capability & tool naming standard

**Status:** Accepted (2026-07-06)
**Related:** ADR-009 (unified capability/tool model via `surfaces`), ADR-021 §3 (structured tools over generic execution), `docs/VISION.md`

## Context

Oxagen exposes ~286 capabilities, each a single contract that fans out to an API route, an MCP tool, and (for agent-surface capabilities) a model-facing tool (ADR-009). A capability's **name** is not cosmetic: it is a load-bearing string key. It joins the contract registry, the kernel's handler-loader map, the IAM `role_grants.capability_id` column, the ClickHouse `tool_invocations.capability_name` analytics column, the MCP tool name a model sees, and — by filename convention — the contract/route/tool/test/docs files on disk.

Names had drifted. Some ran to four segments (`agent.file.lock.acquire`, `agent.task.background.start`), some used inconsistent domains (`organization.create` vs the `org.*` family, `documents.*` vs `document.*`), some pluralised segments (`graph.node.labels.get`), and one used kebab-case (`eval-schema`). Without a written standard and a lint, drift is the steady state, and drift makes the model pick the wrong tool (ADR-021 §3: overlapping/vaguely-named tools are a tool-registry defect), makes capabilities hard to discover, and makes the manifest an unreliable index.

## Decision

### 1. Canonical form: `domain.subject.action`

Every capability's canonical name is **exactly three segments**, `domain.subject.action`:

- **domain** — the top-level area (`agent`, `graph`, `billing`, `org`, `schema`, …). One domain per area; no synonyms (`org`, never `organization`; `document`, never `documents`).
- **subject** — the entity the action operates on.
- **action** — a verb from the closed vocabulary (§4).

Segments are **lowercase** `[a-z0-9]` words. A compound concept is written **snake_case inside a single segment**, never as an extra dotted segment: `agent.file_lock.acquire`, not `agent.file.lock.acquire`; `workspace.model_settings.read`, not `workspace.model.settings.read`. Kebab-case is illegal everywhere.

Subject and domain segments are **singular nouns** (`node_label`, not `node_labels`) — a capability that returns many rows still names its subject in the singular, exactly as `connection.list` lists connections. A short allowlist covers genuinely-plural entities; forced, awkward singularisations are not required.

### 2. The subject-elision rule (legal 2-segment names)

A **2-segment** `domain.action` is legal **when the implied subject is the domain's root entity** — `connection.list` = "list connections", `workflow.run` = "run the workflow". The ~100 existing 2-segment names stay.

A 2-segment name may also be `domain.subject` for a **read with an implied `get`** — `workflow.status` = "get the workflow's status", `billing.usage` = "the billing usage". Both readings are blessed, so the final segment of a 2-segment name is unconstrained by the action vocabulary. Only **3-segment** names must end in a closed-vocabulary verb.

### 3. Model-facing tool names (dot → underscore)

The MCP/Anthropic tool-name charset excludes `.`. The **model-facing** tool name is therefore the canonical name with dots replaced by underscores: `agent.file_lock.acquire` → `agent_file_lock_acquire`. The canonical dotted name remains the identity everywhere else (contract, IAM, metering, docs).

**Exception — the core-seven engine tools.** The coding agent's primitive tools (`read_file`, `write_file`, `edit_file`, `run_command`, `search`, `list_files`, `todo_write` and their kin) keep their established, already-underscore model-facing names. They are not renamed to a dotted canonical; they predate and underpin the capability system.

> Current state: MCP tools today expose the **dotted** canonical name directly (xmcp permits it). Migrating the whole tool surface to the underscore form is a mechanical follow-up tracked separately; this ADR fixes the standard, and the ADR-022 rename wave keeps names dotted-but-3-segment.

### 4. Closed action vocabulary

The final segment of every 3-segment name comes from one closed, verb-only set, maintained in `tools/scripts/check-naming.mjs` (`ACTIONS`). It was seeded by auditing every terminal verb in use and keeping the clear, distinct ones — read/list (`list`, `get`, `read`, `query`, `search`, …), create/write (`create`, `update`, `upsert`, `write`, `add`, `generate`, …), delete/lifecycle (`delete`, `remove`, `start`, `stop`, `run`, `cancel`, `acquire`, `release`, …), config/auth (`set`, `enable`, `disable`, `rotate`, `revoke`, `sync`, `approve`, …). snake_case **compound actions** (`set_enabled`, `import_env`, `from_traces`) count as single verbs. The set is deliberately minimal: add a verb only when a real capability needs one no existing verb covers — a near-synonym (`change` vs `update`) is a smell, not a new entry.

### 5. Standard argument shapes (new tools only)

New tools adopt shared argument conventions so the model learns them once:

- **Scope** — an exactly-one-of `{ package?, files?, all? }` selector for repo-scoped tools.
- **verbosity** — `minimal | standard | verbose`, default `minimal` (raw output never floods context — ADR-021 §3).
- **limit** — a numeric cap on returned rows where a tool can return many.

These apply to **new** contracts; existing contract input schemas are **not** retrofitted in the ADR-022 wave.

### 6. Aliases & deprecation (nothing breaks on a rename)

Renaming a name would orphan every call site, every existing IAM grant row, and every MCP client pinned to the old name. So a rename never drops the old name — it **demotes it to an alias**:

- A contract carries `aliases: [<oldName>, …]` alongside its canonical `name` (a serializable `string[]`; it survives the registry signature and the JSON manifest).
- The **registry** (`packages/oxagen/src/registry.ts`) indexes each alias to its canonical name. `getCapability(alias)` resolves to the canonical contract and reports the hit through an injectable deprecation sink (one telemetry counter per alias, not per call; a single dev-console warn when no sink is wired). `resolveCanonicalName()` and `namesForCapability()` expose the mapping.
- The **kernel** dispatches, gates (IAM / billing / entitlement), and **meters** every call under the canonical name — a call made via an alias is attributed to the canonical name in ClickHouse and audit.
- **IAM** matches legacy rows without a data migration: `fetch-authz` queries `role_grants` for the canonical name **and** all aliases (`inArray`), and the pure resolver matches any of them. An existing grant keyed by the old string keeps granting access.
- **API HTTP paths are unaffected** — they are hand-authored and independent of the capability name, so the external REST surface stays byte-stable across a rename; only the contract file moves.
- **Billing is safe by construction**: the revenue path (`token_usage`, `consumeCredits`) keys on `model` + `execution_step_id`, never the capability name, so a rename cannot mis-attribute revenue.

An alias is a permanent shim until deliberately retired; retiring one is a breaking change that needs its own migration of any durable rows still keyed by the old name.

### 7. Lint enforcement & grandfathering

`tools/scripts/check-naming.mjs` (wired into `pnpm check:contracts`, also `pnpm check:naming`) validates every **real** capability — a contract file that calls `registerCapability()`; shared schema modules co-located in `contracts/` are ignored (the same `registerCapability()` guard was added to `check_manifest.mjs`, dropping five phantom entries from the manifest). It enforces the charset, the 2–3 segment count, and the closed action vocabulary for 3-segment names.

A name that cannot be validated **and was deliberately not renamed** goes into an explicit `GRANDFATHER` map **in the lint config**, each with the conforming form named — so the remaining debt is visible and ratcheting (you remove an entry only by fixing the name, never to silence the lint). The ADR-022 wave renamed the 4-segment names and the domain-dedupe set; it grandfathered 12 pre-standard **3-segment noun-terminal reads** (`eval.run.status`, `billing.usage.breakdown`, `schema.validate.node`, …) for a follow-up wave.

## Consequences

- **Renames in this wave** (all with alias shims): 29 four-segment collapses (`agent.file.lock.* → agent.file_lock.*`, `agent.task.background.* → agent.background_task.*`, `graph.node.label(s).* → graph.node_label.*`, `workspace.model.settings.* → workspace.model_settings.*`, `workspace.budget.policy.* → workspace.budget_policy.*`, …), one semantic fix (`agent.memory.promotion.candidates → agent.memory_promotion.list`), and the domain dedupe (`organization.create → org.create`, `documents.* → document.*`, `notifications.* → notification.*`, with the `domain` field normalised to the first segment).
- **Nothing breaks**: internal callers resolve through the alias index, existing IAM grants keep working, external REST paths are unchanged, and metering stays correct.
- **Drift is now caught in CI** on every PR, and the grandfather list is the running ledger of naming debt.
- **Follow-ups**: (a) migrate MCP tool names to the underscore form (§3); (b) fix the 12 grandfathered noun-terminal reads; (c) retire aliases once no durable row references an old name.
