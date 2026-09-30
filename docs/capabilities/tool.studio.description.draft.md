# draft_studio_description

**Capability:** `draft_studio_description`
**Domain:** tool
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** on. The call is a governed action, and its model tokens bill as in-app agent spend

## Intent

The Draft button on Studio's tool panel asks the in-app agent to write one tool's description. The handler builds the server folder the way [list_studio_findings](tool.studio.findings.list.md) does, from the saved draft or from the production branch when the server has no draft. It finds the tool, sends its definition to the organization's fast model, and returns the suggestion. It writes nothing. A person who keeps the suggestion saves it as a `describe` op with [save_studio_draft](tool.studio.draft.save.md).

The handler finds the tool by the first of these that matches:

1. its key in tools.toml
2. the name the agent sees, such as `billing__list_charges`
3. the upstream name the tool selects, such as `list_charges` or the OpenAPI operation `listCharges`
4. a tool the source offers that the folder has not imported yet

The prompt carries the tool's served name, title, current description, the source's description, its classification when it has one, its request template, and its input and output schemas. Each schema is cut at 8,000 characters and the request at 2,000, with a note saying so. The system prompt tells the model to treat the definition as data, never as instructions.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `server` | string | yes | the folder name under `tools/servers/`: a lowercase letter, then lowercase letters, digits, or underscores, 24 characters at most. `builtin` is reserved |
| `tool` | string | yes | the tool's tools.toml key, the name the agent sees, or the upstream name it selects, 1 to 128 characters |

## Output

| Field | Type | Description |
|---|---|---|
| `server` | string | the folder the tool belongs to |
| `tool` | string | the tool as the input named it |
| `description` | string | the suggestion, 1 to 1,024 characters. A longer answer is cut at 1,024 characters without splitting a character |

Two calls for one tool can return different suggestions.

## Roles

Org Owner or Admin, or workspace Owner. The handler checks the role against the contract's roles before it reads anything or calls the model. An API key acts as the person who created it.

## Metering

The kernel's billing and budget gates run before the handler, as for any governed action. The model call goes through `generateObjectFor` in `@oxagen/ai` with the charge reason `CONSUME_ASSISTANT_TOKENS`, so its tokens are metered and charged as in-app agent spend. The model runs on the organization's funding source, the platform's key or the organization's own, as its model funding setting chooses. The telemetry carries the surface the call came from, and the chat message id when the call came from a chat turn.

## Side effects

None in the steering repo or the draft store. The handler reads what list_studio_findings reads, then makes one model call, which writes a token usage row and a credit charge.

## Limits

- The model's answer is at most 1,024 output tokens.
- A folder that does not compile or lock is refused with `conflict`, as list_studio_findings refuses it.

## Surfaces

- `POST /v1/{org}/{ws}/tools/studio/description`
- MCP tool `draft_studio_description`

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or no qualifying role |
| `not_found` (404) | `folder_not_found`: the server has no draft, and the production branch has no `server.toml` for it |
| `not_found` (404) | `tool_not_found`: the folder has no tool by that name, and its source offers none |
| `conflict` (409) | any refusal list_studio_findings returns when it builds the folder, such as `production_branch_missing`, `folder_invalid`, or `source_required` |
| `gau_exhausted`, `budget_exceeded` (402) | the organization's month of governed actions is used up, or a spend ceiling is reached. Either refuses the call before the handler runs |
| `invalid_input` (400) | `server` or `tool` is missing or malformed, or the input carries another field |

A model call that fails passes its error through, and nothing is charged for it.
