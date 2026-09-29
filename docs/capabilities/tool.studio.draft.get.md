# get_studio_draft

**Capability:** `get_studio_draft`
**Domain:** tool
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`, a read spends no model tokens)

## Intent

Studio reads your draft for one server folder when a page opens, and again after a save is refused as stale. This capability returns the edits `save_studio_draft` stored, or null when the folder has no draft. The source comes back as its type and size, never its text. The decision record is ADR-224.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `server` | string | yes | the folder name under `tools/servers/`: a lowercase letter, then lowercase letters, digits, or underscores, 24 characters at most. `builtin` is reserved |

## Output

| Field | Type | Description |
|---|---|---|
| `draft` | object or null | the draft `save_studio_draft` returns, or null when the folder has none |

A draft carries `server`, `serverId`, `ops`, `serverToml`, `source` (`{ type, bytes }`), `revision`, `pr` (`{ number, url, branch }` or null), and `updatedAt`. [save_studio_draft](tool.studio.draft.save.md) describes each field.

## Roles

Org Owner or Admin, or workspace Owner. The handler checks the role with `assertOrgRole` (INV-29). An API key acts as the person who created it.

## Side effects

None. The handler reads one `mcp.studio_drafts` row.

## Surfaces

- `POST /v1/{org}/{ws}/tools/studio/draft/get`
- MCP tool `get_studio_draft`

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or no qualifying role |
| `conflict` (409) | `draft_unreadable`: the stored draft no longer matches the draft format. Save it again from Studio |
| `invalid_input` (400) | `server` is missing, malformed, or `builtin`, or the input carries another field |
