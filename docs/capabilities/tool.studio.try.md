# try_studio_tool

**Capability:** `try_studio_tool`
**Domain:** tool
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** on. Every answer from the policy decision on meters once as a governed action

## Intent

The Try it button on Studio's tool panel sends one call to one tool, against the environment you pick, with the arguments you typed. Oxagen decides the call the way it decides a served call, then sends it and shows what went out and what came back.

The handler works in five steps:

1. It builds the saved draft, or production's folder when the server has no draft, as [list_studio_findings](tool.studio.findings.list.md) does, and finds the tool. The tool must be imported and classified.
2. It reads the workspace's published steering version. Its policies and agents decide the call. The draft's tools stand in for the published tools of the same server, so a draft classification is what the policies see.
3. It checks the off switches and the kill switches, then decides the call with Cedar on the gateway tier. A rule that asks for approval denies the call, because Try it opens no approval.
4. It reads the environment's credential and sends the call over the cloud transport, with a 30-second limit.
5. It returns the first upstream request and answer with every credential removed, and the shaped result the agent would receive.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `server` | string | yes | the folder name under `tools/servers/`: a lowercase letter, then lowercase letters, digits, or underscores, 24 characters at most. `builtin` is reserved |
| `tool` | string | yes | the tool's tools.toml key, the name the agent sees, or the upstream name it selects, 1 to 128 characters |
| `environment` | string | yes | the environment in server.toml to call, such as `staging`, 1 to 64 characters |
| `arguments` | object | yes | the tool's arguments, at most 65,536 characters as JSON. The handler checks them against the tool's input schema before the call |
| `agent` | string | no | the published agent whose policies decide the call, 1 to 128 characters. Leave it out when the workspace publishes exactly one agent |

## Output

The output is a union on `ok`.

When `ok` is `true`, Oxagen sent the call:

| Field | Type | Description |
|---|---|---|
| `server` | string | the folder the tool belongs to |
| `tool` | string | the tool as the agent sees it |
| `environment` | string | the environment called |
| `agent` | string | the agent whose policies decided the call |
| `request` | string | the first upstream request with credentials removed, at most 65,536 characters |
| `raw` | string | the upstream's first answer, unshaped, at most 262,144 characters |
| `shaped` | string | the result the agent would receive, at most 262,144 characters |
| `exchanges` | integer | how many upstream requests the call made. A paged call makes more than one |
| `cut` | array | which of `request`, `raw`, and `shaped` were cut at their limit. Each cut part ends with a note that says so |

When `ok` is `false`, the policies denied the call or the call failed:

| Field | Type | Description |
|---|---|---|
| `reason` | `denied` or `failed` | `denied` when a switch or a policy refused the call, `failed` when Oxagen could not send it or the upstream refused it |
| `message` | string | what happened and what to do next |
| `request` | string | the request the upstream refused, with credentials removed, when one was sent |
| `raw` | string | the upstream's answer to that request, when it sent one |

## Roles

Org Owner or Admin, or workspace Owner. The contract denies everyone else by default. An API key acts as the person who created it.

## Metering

A refusal before the policy decision throws, and the kernel does not meter it. Every answer from the decision on, allowed or denied, meters once as a governed action.

## Side effects

The call reaches the upstream API, which can change data there. Oxagen writes nothing to the steering repo or the draft store.

## Limits

- The upstream call has 30 seconds.
- Try it sends calls only over the cloud network.
- Try it sends a workspace credential only to an address a merged steering PR set.

## Surfaces

- `POST /v1/{org}/{ws}/tools/studio/try`
- MCP tool `try_studio_tool`

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or no qualifying role |
| `not_found` (404) | `tool_not_found`: the folder has no tool by that name, and its source offers none |
| `not_found` (404) | `tool_not_imported`: the source offers the tool, and the folder has not imported it |
| `not_found` (404) | `environment_not_found`: server.toml has no environment by that name |
| `not_found` (404) | `agent_not_found`: the published version has no agent by that name |
| `conflict` (409) | `tool_unclassified`: the tool has no classification, so no policy can decide it |
| `conflict` (409) | `folder_not_locked`: the folder's lock has no entry for the tool |
| `conflict` (409) | `network_unsupported`: the environment runs on a network other than the cloud network |
| `conflict` (409) | `environment_unpublished`: the environment or its sign-in differs from the published version |
| `conflict` (409) | `no_published_policies`, `no_agents`, `agent_required`, or `policies_invalid`: the published version cannot decide the call |
| `conflict` (409) | `policy_evaluator_unavailable`: Oxagen could not load its policy evaluator |
| `gau_exhausted`, `budget_exceeded` (402) | the organization's month of governed actions is used up, or a spend ceiling is reached |
| `invalid_input` (400) | a field is missing or malformed, the arguments are too long, or the input carries another field |
