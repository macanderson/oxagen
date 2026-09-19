# import_tools

**Capability:** `import_tools`
**Domain:** tool
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; versioning the registry spends nothing)

## Intent

The Appendix E `import_tools` (MC spec §6.4; ADR-072 §3, §7). Pull a registered MCP server's pinned `tools/list` into the workspace registry, or publish hand-authored declarations against that server. Every tool lands as an `agent.tools` row of source `mcp` naming the server, with an immutable `agent.tool_versions` row per changed manifest; a pulled tool's version carries `schema_origin = imported`, a declared one `declared`. A pulled tool has no declared risk grade and lands at `high`, read-only false, until an admin classifies it. The server row is stamped with the import time and a digest over the sorted checksums of its tools' active versions, so an unchanged re-import is visible as one (`published: false` on every tool).

Registers directly. The mockup's pull-request path needs a bound repository, which no capability records; it lands with the lane that binds one.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `serverId` | string | yes | `mcs_…` in this workspace |
| `tools` | string[] | no | names of pinned tools to import (1-200); omit for every pinned tool; a name with no pin is `not_found` |
| `declarations` | object[] | no | hand-authored declarations (`publish_tool_declaration`'s wire fields: `name`, `description`, `input_schema`, `read_only`, `risk_grade`, `policy_group`, `manifest`); with `tools` is `invalid_input` |

## Output

| Field | Type | Description |
|---|---|---|
| `serverId` | string | |
| `importDigest` | string | sha256 over the sorted checksums of the server's tool versions after this import |
| `tools` | object[] | `{ id (tlv_…), toolId (tol_…), slug, name, version, checksum, schemaOrigin, published }`; `slug` is `mcp.<server uuid>.<name>`, the identity per server, so the same name on two servers is two tools |

## Roles

Org Owner or Admin, or workspace Owner (`assertOrgRole`, INV-29).

## Side effects

Writes `agent.tools` and `agent.tool_versions`; stamps `mcp.mcp_servers.last_import_at` and `last_import_digest`. The contract declares the server as its audit target.

## Surfaces

- `POST /v1/{org}/{ws}/tools/import`
- MCP tool `import_tools` (an API key acts as its creator at the role gate, ADR-072 decision 8)
- App: **Tools → Registry → Import tools from an MCP server** at `/{org}/{ws}/tools`.

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or no qualifying role |
| `not_found` (404) | no such server in this workspace (`server_not_found`); a picked tool the server has no pin for (`tool_not_pinned`) |
| `invalid_input` | both `tools` and `declarations`, or an empty pick |
