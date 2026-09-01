# tool.declaration.publish

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

## Output

| Field | Type | Notes |
| --- | --- | --- |
| publicId | string | Public tool ID (`tol_…`) |
| slug | string | The workspace-unique key the row was upserted by |
| version | integer | The version number now latest |
| checksum | string | SHA-256 hex over the canonical (sorted-key) declaration JSON |
| published | boolean | false when the latest version already carried this checksum |

## Side effects

Inserts/updates `agent.tools` and inserts `agent.tool_versions`; repoints `tools.active_version_id` at the new version. Never mutates an existing version row.

## Errors

- Missing workspace scope → error (scoped capability).
- A name reserved by a soft-deleted declaration → conflict error naming the slug.
- Two concurrent publishes race safely: the loser republishes onto the winner's row.
