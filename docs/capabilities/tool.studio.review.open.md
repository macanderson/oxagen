# open_studio_review

**Capability:** `open_studio_review`
**Domain:** tool
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`, opening a steering PR spends no model tokens)

## Intent

You have staged edits to one server folder in Studio and saved them as a draft. Review turns that draft into one steering PR on the branch `tools/<server>`. The PR writes server.toml, tools.toml, tools.lock.json, the vendored definition, and `tests/calls.jsonl` under `tools/servers/<server>/`. Its body lists every imported, removed, and reclassified tool, the definition token total against the budget, and the tool checks' findings.

Review refuses while a tool the draft imports has no risk, side effect, or egress, and while the folder does not compile or lock. A second Review adds a commit to the steering PR already open on the branch. The decision record is ADR-224.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `server` | string | yes | the folder name under `tools/servers/`: a lowercase letter, then lowercase letters, digits, or underscores, 24 characters at most. `builtin` is reserved |
| `revision` | integer | no | the draft revision you reviewed, 1 or more. A stored draft at another revision is refused with `conflict` |

## Output

| Field | Type | Description |
|---|---|---|
| `number` | integer | the steering PR's number |
| `url` | string | the steering PR's URL |
| `branch` | string | `tools/<server>` |
| `headSha` | string | the commit the PR's branch points at after this Review |
| `imported` | string[] | tool keys the PR adds to tools.toml |
| `removed` | string[] | tool keys the PR takes out of tools.toml |
| `reclassified` | object[] | `{ tool, before, after }` for each tool whose risk, side effect, egress, or impacts the PR changes. `before` and `after` are `{ risk, sideEffect, egress, impacts }` |
| `tokens` | object | `{ definitions, budget }`: every imported tool's definition together, and server.toml's `definition_budget` or the default |
| `findings` | object[] | `{ rule, level, tool, field, message, fix }` for each tool check finding. `level` is `error`, `warning`, or `info`. `tool` and `field` can be null |

## Roles

Org Owner or Admin, or workspace Owner. The handler checks the role with `assertOrgRole` (INV-29). An API key acts as the person who created it. An agent call needs approval (`requiresApproval: true`, risk `high`).

## Side effects

1. The handler reads the draft and refuses a stale revision.
2. It reads the folder's managed files on the production branch, and the names of the workspace's credentials.
3. It imports the draft's source again, so the PR is built from inputs rather than from Studio's view.
4. It builds the folder and runs the tool checks.
5. It opens the steering PR through the tools steering PR path. When a PR is already open on `tools/<server>`, it adds one commit to that PR instead.
6. It records the PR on the draft in `mcp.studio_drafts`.

The commit holds only the files that differ from the branch it lands on. The contract declares the server folder (`tool_server_folder`) as its audit target.

## Surfaces

- `POST /v1/{org}/{ws}/tools/studio/review`
- MCP tool `open_studio_review`

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or no qualifying role |
| `not_found` (404) | `draft_not_found`: the server folder has no draft |
| `conflict` (409) | `draft_revision_stale`: the stored draft is at another revision. Reload it, then Review |
| `conflict` (409) | `draft_unchanged`: the open PR or the production branch already holds every edit |
| `conflict` (409) | `tools_unclassified`: an imported tool has no risk, side effect, or egress |
| `conflict` (409) | `folder_invalid` or `definition_path_invalid`: the folder does not validate or lock, or the definition names a file outside the folder |
| `conflict` (409) | `server_toml_missing`, `server_toml_invalid`, or `server_name_mismatch`: server.toml is absent, does not parse, or names another server |
| `conflict` (409) | `source_required`, `source_invalid`, or `importer_not_built`: Review needs the source, the source does not import, or its importer has not shipped |
| `conflict` (409) | `tool_not_offered`, `tool_not_found`, or `tool_key_collision`: the source does not offer an imported tool, an edit names a tool neither tools.toml nor the source holds, or two tools derive one key |
| `conflict` (409) | `draft_unreadable`: the stored draft no longer matches the draft format |
| `invalid_input` (400) | `server` is malformed or `builtin`, `revision` is below 1, or the input carries another field |
