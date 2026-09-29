# list_studio_findings

**Capability:** `list_studio_findings`
**Domain:** tool
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`, compiling and linting a folder spends no model tokens)

## Intent

Studio's findings panel shows what the tool checks say about one server folder before you open a Review. This capability builds the folder the way [open_studio_review](tool.studio.review.open.md) builds it, from the saved draft, or from the production branch when the server has no draft. It compiles the folder, locks it, runs the tool checks, and returns each finding. It writes nothing. Because the panel and Review share one build, the findings match the ones Review writes into the steering PR's body.

One difference from Review: an imported tool with no risk, side effect, or egress comes back as a `missing_classification` error with a null `field`, where Review refuses the draft with `tools_unclassified`. The build fills that tool's classification with Studio's suggestion so the other checks can run.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `server` | string | yes | the folder name under `tools/servers/`: a lowercase letter, then lowercase letters, digits, or underscores, 24 characters at most. `builtin` is reserved |

## Output

| Field | Type | Description |
|---|---|---|
| `server` | string | the folder checked |
| `basis` | `draft` or `published` | `draft` when the saved draft was checked, `published` when the production folder was |
| `revision` | integer or null | the draft revision checked, or null for the production folder |
| `tokens` | object | `{ definitions, budget }`: every imported tool's definition together, and server.toml's `definition_budget` or the default |
| `findings` | object[] | `{ rule, level, tool, field, message, fix }` for each tool check finding, errors first, then warnings, then infos. `level` is `error`, `warning`, or `info`. `tool` and `field` can be null |

A folder over its definition budget in direct mode gets an `over_definition_budget` warning with `field` set to `exposure.mode` and a null `tool`.

## Roles

Org Owner or Admin, or workspace Owner. The handler checks the role against the contract's roles before it reads anything. An API key acts as the person who created it.

## Side effects

None. The handler reads the draft, resolves the production branch to one commit, reads the folder's managed files at that commit, reads the names of the workspace's credentials, and imports the draft's source again when the draft has one.

## Limits

- A folder that does not compile or lock is refused with `conflict`, as Review refuses it, because the tool checks read a compiled folder.
- A gRPC server with no draft is refused with `source_required`, because its descriptors live only in a draft's source.
- A production folder with no `tools.lock.json` and no draft is refused with `source_required`.

## Surfaces

- `POST /v1/{org}/{ws}/tools/studio/findings`
- MCP tool `list_studio_findings`

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or no qualifying role |
| `not_found` (404) | `folder_not_found`: the server has no draft, and the production branch has no `server.toml` for it |
| `conflict` (409) | `production_branch_missing`: the steering repo has no production branch |
| `conflict` (409) | `folder_invalid` or `definition_path_invalid`: the folder does not validate or lock, or the definition names a file outside the folder |
| `conflict` (409) | `server_toml_missing`, `server_toml_invalid`, or `server_name_mismatch`: server.toml is absent, does not parse, or names another server |
| `conflict` (409) | `source_required`, `source_invalid`, `source_commit_missing`, or `importer_not_built`: the check needs the source, the source does not import or names no commit, or its importer has not shipped |
| `conflict` (409) | `tool_not_offered`, `tool_not_found`, or `tool_key_collision`: the source does not offer an imported tool, an edit names a tool neither tools.toml nor the source holds, or two tools derive one key |
| `conflict` (409) | `draft_unreadable`: the stored draft no longer matches the draft format |
| `invalid_input` (400) | `server` is missing, malformed, or `builtin`, or the input carries another field |
