# start_studio_listing

**Capability:** `start_studio_listing`
**Domain:** tool
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`, a listing reads a server's tool list and spends no model tokens)

## Intent

You are adding a server that runs on machines: a local command, or a registry package with `source.machines`. Studio cannot show its tools until a machine starts it, and Review cannot write its folder without them. This capability asks one machine in the draft's `source.machines` to start the server and answer tools/list, before Review ([ADR-233](../adr/ADR-233-a-machine-run-server-is-pinned-before-it-first-runs.md)).

The machine only ever checks a digest. It never supplies one. So Oxagen pins the server first:

- A local command pins the version and SHA-256 you name: the executable the command resolves to on the machine.
- A registry package pins the SHA-256 Oxagen reads from the public registry, for npm and NuGet. An OCI image and a PyPI release are refused with `needs_digest`, as discovery refuses them.

The listing waits for a machine. When one polls, the MCP process that holds its poll asks it for tools/list. The machine checks the pin before it starts anything. The tools it lists become the draft's source, with the pin as the lock source, and the draft's revision rises by one. Read the progress with [get_studio_listing](tool.studio.listing.get.md).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `server` | string | yes | the folder name under `tools/servers/`, with a saved draft whose `server.toml` names the server |
| `revision` | integer | yes | the draft revision you read, 1 or more. A draft saved since then is refused |
| `pin` | object | for a local command | `version` (1 to 64 characters) and `digest` (`sha256:` then 64 lowercase hex characters). Omit it for a registry package |

## Output

| Field | Type | Description |
|---|---|---|
| `listing` | object | the listing, as [get_studio_listing](tool.studio.listing.get.md) describes it. It reads `waiting_for_machine` |

## Roles

Org Owner or Admin, or workspace Owner: the roles that save a draft. A listing starts a program on a machine before any review, so the contract is high sensitivity, and it runs only on a machine the person who asked enrolled. No one can use it to start a program on another person's machine. The contract names no agent surface, so an in-app agent cannot call it. The handler checks the role with `assertOrgRole` (INV-29).

## Side effects

- The handler writes the draft's one `mcp.studio_listings` row as `waiting_for_machine`, replacing any earlier listing of the draft, with the pin, the machine groups, the draft revision, and you as the requester.
- For a registry package it reads the catalog entry and the package's digest from the public registry.
- When a machine in the groups polls, the MCP process claims the listing, and the machine starts the pinned server. A claim older than five minutes is open again, so a process that stopped mid-listing does not hold it.
- A listing that succeeds saves the draft's source and raises its revision by one, in the same transaction that finishes the listing. It writes nothing when the draft was saved after the listing was asked.

The contract declares the server folder (`tool_server_folder`) as its audit target.

## Surfaces

- `POST /v1/{org}/{ws}/tools/studio/listing/start`
- MCP tool `start_studio_listing`

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or no qualifying role |
| `not_found` (404) | `draft_not_found`: the server has no draft |
| `conflict` (409) | `draft_revision_stale`: the draft is at another revision |
| `conflict` (409) | `server_toml_missing` or `server_toml_invalid`: the draft holds no `server.toml`, or it does not read |
| `conflict` (409) | `listing_not_machine_run`: the server runs remotely, so Studio imports its tools with Connect |
| `conflict` (409) | `machines_required`: `source.machines` names no group |
| `conflict` (409) | `machine_not_yours`: you enrolled no machine in the server's groups, and a listing runs only on a machine the person who asked enrolled |
| `conflict` (409) | `pin_required` or `pin_not_accepted`: a local command needs your pin, and a registry package takes none |
| `conflict` (409) | `needs_digest`: an OCI image or a PyPI release, which Oxagen cannot pin yet |
| `conflict` (409) | `registry_unreachable` or `source_invalid`: the registry did not answer, or the entry lists no package that runs on a machine |
| `invalid_input` (400) | a field is missing or malformed, or the input carries another field |

A machine that refuses the pin, or a server that does not start, does not fail the request. The listing ends `failed`, and `get_studio_listing` returns the machine's reason.
