# save_studio_draft

**Capability:** `save_studio_draft`
**Domain:** tool
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`, a draft spends no model tokens)

## Intent

You stage edits to one server folder in Studio before you open a steering PR. This capability saves those edits as a draft, so they survive a reload and a second tab. A save replaces the stored edits. It replaces server.toml and the source only when the input carries them. `open_studio_review` reads the draft and opens the steering PR from it.

The draft holds no credential. server.toml names a credential by reference, and a saved test keeps the request as Studio built it before the gateway added the credential. The decision record is [ADR-224](../adr/ADR-224-studio-keeps-a-draft-and-review-opens-a-steering-pr-for-one-server-folder.md).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `server` | string | yes | the folder name under `tools/servers/`: a lowercase letter, then lowercase letters, digits, or underscores, 24 characters at most. `builtin` is reserved |
| `serverId` | string | no | `mcs_…` of the registered server, 1 to 64 characters. Omit it for a server you have not registered |
| `ops` | object[] | yes | every staged edit, 2,000 at most and 8 MiB at most as UTF-8 JSON. The list replaces the stored one. See Edits |
| `serverToml` | string | no | server.toml as Studio wrote it, 256 KiB at most in UTF-8 bytes. Omit it to keep the stored one |
| `source` | object | no | what the draft imports from, 25 MiB at most as UTF-8 JSON. See Sources. Omit it to keep the stored one |
| `revision` | integer | no | the revision this save builds on. `0` starts a new draft. Omit it to save over any revision |

The API reads a request body of 36 MiB at most. It answers a larger body with 413 before it parses it.

## Edits

Each entry in `ops` names its `kind` and the `tool` it changes.

| Kind | Fields |
|---|---|
| `import` | `tool` |
| `remove` | `tool` |
| `classify` | `tool`, `risk` (`low`, `medium`, `high`, or `critical`), `sideEffect` (`read`, `write`, or `irreversible`), `egress` (`local`, `org_tenant`, or `third_party`), and `impacts` (32 snake_case ids at most) |
| `describe` | `tool` and `description` (1 to 1,024 characters) |
| `test` | `tool`, `environment`, `args`, `request`, `raw`, and `shaped`. The last four are JSON strings. `request` is the request before the gateway adds the credential |

## Sources

| Type | Fields |
|---|---|
| `mcp` | `lockSource` (the source block of tools.lock.json) and `tools` (the server's `tools/list` result, 2,000 at most) |
| `openapi` | `files` (1 to 500 `{ path, text }` entries), `entry` (the root document's path), and an optional `overlay` and `commit` |
| `graphql` | `sdl` with an optional `commit`, or `introspection` (the data of an introspection query) |
| `grpc` | `files` (1 to 500 .proto files) with an optional `commit`, or `reflection` (base64 FileDescriptorProto messages from server reflection) |

A `commit` is 40 or 64 lowercase hex characters.

## Output

The saved draft.

| Field | Type | Description |
|---|---|---|
| `server` | string | the folder name |
| `serverId` | string or null | `mcs_…` of the registered server, or null |
| `ops` | object[] | the stored edits |
| `serverToml` | string or null | null keeps the production server.toml |
| `source` | object or null | `{ type, bytes }`. The source comes back as its type and size, never its text |
| `revision` | integer | starts at 1 and rises by one on every save |
| `pr` | object or null | `{ number, url, branch }` of the steering PR Review opened, or null before Review |
| `updatedAt` | string | ISO 8601 time of the last save |

## Roles

Org Owner or Admin, or workspace Owner. The handler checks the role with `assertOrgRole` (INV-29). An API key acts as the person who created it.

## Side effects

The handler writes one live `mcp.studio_drafts` row per server folder. It runs every check before the write, so a refused save stores nothing. The contract declares the server folder (`tool_server_folder`) as its audit target.

## Surfaces

- `POST /v1/{org}/{ws}/tools/studio/draft`
- MCP tool `save_studio_draft`

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or no qualifying role |
| `not_found` (404) | `serverId` names no server in this workspace (`server_not_found`) |
| `conflict` (409) | `draft_revision_stale`: `revision` is `0` while a draft exists, or it differs from the stored revision |
| `conflict` (409) | `test_holds_credential`: a saved test carries a credential header |
| `conflict` (409) | `test_invalid`: a saved test does not make one recorded exchange |
| `conflict` (409) | `server_toml_invalid` or `server_name_mismatch`: server.toml does not parse, or it names another server |
| `invalid_input` (400) | the input fails the contract, including a source over 25 MiB, edits over 8 MiB, or a server.toml over 256 KiB |
| 413 | the request body is over 36 MiB |
