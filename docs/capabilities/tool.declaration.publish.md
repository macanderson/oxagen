# publish_tool_declaration

**Domain:** tool
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api
**Risk level:** high (requires approval on the agent surface)
**Billing gate:** none (noBillingGate: true)

## Intent

Publish a tool declaration into the workspace agent-asset registry. Upserts the `agent.tools` row by (workspace, name) and creates a new immutable `agent.tool_versions` row when the canonical manifest changed. Publishing the same declaration twice is idempotent (`published: false`). This is how a Stella agent's tool surface (built-ins, custom script tools, MCP tools, foundry tools) is aggregated into the workspace, mirroring how skills are stored.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| name | string | Tool name (snake_case identifier, e.g. `read_file`) — the workspace-unique key; lowercased into the slug |
| description | string | What the tool does |
| input_schema | object | JSON Schema for the tool's input parameters |
| read_only | boolean (default false) | True when the tool mutates nothing |
| risk_grade | `low` \| `medium` \| `high` \| `critical` | Declared risk grade of invoking this tool |
| policy_group | string (optional) | Policy group the tool's per-tool toggles key on |
| source | `builtin` \| `custom` \| `mcp` \| `foundry` | Where the declaration came from |
| manifest | object | The full declared manifest body, verbatim |
| consequence_tags | string[] (default `[]`) | Safety classification (MC spec §6.9 part 1, ADR-059): the consequences invoking this tool can cause — `moves_money`, `destroys_data`, `alters_production`, `communicates_externally`, `changes_access`, `changes_entitlement`, or a workspace-defined tag. A tagged tool is mandate-gated for agent principals |
| measures | Record<name, { path, type: amount \| count \| text, unit, scale? }> (default `{}`) | How a mandate's limits and targets are read from the call's input; `scale` is the number of decimal places an amount uses (default 2). An `amount`-typed measure's `unit` must be an ISO 4217 currency code (ADR-111), refused here before anything is written, rather than reaching a mandate page and failing to map. A `count`-typed measure's `unit` is unconstrained and may legitimately be a currency code (a count of dollar bills, not an amount of dollars) |
| effect_id_path | string (optional) | Dot path into the tool's output carrying the external effect id a mandate settlement records |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| publicId | string | Public tool ID (`tol_…`) |
| slug | string | The workspace-unique key the row was upserted by |
| version | integer | The version number now latest |
| checksum | string | SHA-256 hex over the canonical (sorted-key) declaration JSON |
| published | boolean | false when the latest version already carried this checksum |

## Roles

Org Owner or Admin, or workspace Owner or Admin, checked by the handler (`assertOrgRole`, INV-29). `consequence_tags`, `measures` and `effect_id_path` are what the mandate gate reads, so a publish whose classification differs from the active version's (or a new tool that declares one) also needs an org role the workspace's consequence roles name for every tag before and after the change (`assertConsequenceRole`): moving money is the Owner's or Billing's to add, drop or re-measure by default.

## Side effects

Inserts/updates `agent.tools` and inserts `agent.tool_versions`; repoints `tools.active_version_id` at the new version. Never mutates an existing version row.

## Errors

- Missing workspace scope → error (scoped capability).
- A name reserved by a soft-deleted declaration → conflict error naming the slug.
- Two concurrent publishes race safely: the loser republishes onto the winner's row.
- A caller outside the roles above → `forbidden` / `org_role_required` (403), before anything is read or written.
- `consequence_tags`, `measures` or `effect_id_path` on a declaration whose name is no registered capability → `conflict` / `consequence_not_gated` (409), before anything is read or written. The mandate gate runs inside `invoke()`, so it never sees calls to such a tool (an external MCP tool, a Stella built-in).
- A classification change no single org role is accountable for → `forbidden` / `no_role_covers_all_tags` (403).
- An `amount`-typed measure whose `unit` is not an ISO 4217 currency code → schema validation error naming the `unit` field (ADR-111), before anything is read or written.


## Tool changes and disabled rules

Tool classification and publication recheck matching enabled approval rules in
the same transaction as the tool write (ADR-119). A rule whose recorded author
no longer has authority is disabled. A changed measure path, type, unit, or
scale used by the rule, or a newly matching tool, requires explicit review.
The tool change itself is not refused because an existing rule fails that check.

`disabledReason` carries `code` (`classification_changed`, `measure_changed`, or
`tool_scope_changed`), `tool` (`slug@version`), `at`, and `detail`. API and MCP
reads return it, and Tools shows the reason. Switching off preserves it. Saving
or switching on reruns the authoring checks and clears it. The security event
`approval_rule.invalidated` names the rule, tool, actor, and before/after facts.
