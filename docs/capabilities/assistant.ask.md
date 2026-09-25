# ask_assistant

One turn of the in-app agent (MC spec App. E, §4.4, §14.1; ADR-053). The person's message is appended to a conversation, the turn is admitted as a run of its own in the evidence ledger, `stella-serve` drives the turn with every completion and tool call answered by Oxagen, and the reply is persisted as the assistant's message.

The app streams the same turn over the one SSE transport, `POST /v1/:org_slug/:workspace_slug/chat/stream` (`apps/app/ARCHITECTURE.md` §3.5). That route's body is this contract's input plus the surface's model and budget overrides, and its terminal `event: done` carries this contract's output. The API route and the MCP tool run the turn to completion and return the output whole.

All three adapters reach the turn through `kernel.invoke("ask_assistant")`, so the contract's IAM check, audit row, decision rules and billing flag apply the same way on each. The SSE route carries its hooks and overrides beside the invoke (`streamAssistantTurn`, `@oxagen/agent`); a refusal before the turn is prepared is that route's response, with the status `POST /assistant/ask` answers.

## Mode

**async** (streamed on the chat route; run to completion on the API route and the MCP tool)

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/assistant/ask`
- SSE: `POST /v1/:org_slug/:workspace_slug/chat/stream`
- MCP: `ask_assistant`
- Authentication: session or API key (an API key asks as the person who created it); org Owner or Admin, workspace Owner or Member, checked in the turn for every organisation tier (INV-29)
- Capability name: `ask_assistant`
- Billed: the turn is not a governed action (`noBillingGate: true`, #2968 decision 3), so the run is free to the customer. Each tool call inside it is a top-level governed action through `kernel.invoke()` with the asking person's IAM (ADR-053 §1): the handler runs the turn outside its own invoke's frame (`runOutsideGovernedAction`). The turn's tokens are metered on the organisation's funding source (ADR-053 §3).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `conversationId` | uuid or null | no | null opens a new conversation; an id outside the workspace is `not_found` |
| `content` | string | yes | 1 to 32 KiB, the cap every chat ingress shares |
| `pageContext` | object or null | no | `{ route, orgSlug, workspaceSlug, entityId }` — where the person was when they asked; null for a caller with no page |

## Output

| Field | Type | Description |
|---|---|---|
| `conversationId` | uuid | the conversation the turn was appended to |
| `userMessageId` | uuid | the person's message |
| `assistantMessageId` | uuid | the persisted reply |
| `runId` | string | `arun_…`, the run the turn was recorded as; `get_run` opens it |
| `reply` | string | the assistant's reply, whole |
| `parkedCards` | array | one `{ approvalId, capability, expiresAt }` per governed write the turn opened that waits on a person, in park order; empty when nothing parked. A turn can park more than one, and each has its own five-minute expiry, so all of them are returned |

## Recording

`openAssistantRun` (`@oxagen/agent`) admits the turn before the engine is contacted: the workspace's managed interactive agent acting through the `oxagen.assistant` service principal, the asking person's human principal as the initiating principal, a pinned authorization snapshot and a digest-only retention policy. Every provider and tool request the host answers is recorded first as `model.engine_call_completed` or `tool.engine_call_completed`, keyed by the engine frame's `seq`; the belt meta-tools `search_tools` and `load_tools` are recorded through the tool receipt. The seal carries verdict `waived` for a completed turn, `cancelled` for an aborted one and `failed` for an engine failure.

The run is admitted on the `chat` (SSE) or `api-chat` (API, MCP) surface, and `list_runs`, `list_recent_runs` and `search_tools` exclude both: the assistant is Oxagen's, and its turns never appear as the customer's runs.

## Steering

The system prompt carries the workspace's steering after the governance baseline. The steering assembler (`@oxagen/steering-assembler`) ranks the workspace's published context records and its configured instructions, fits them to 4,096 budget tokens, and cuts what does not fit (ADR-093 §7). The instructions carry SHOULD, so every published MUST record ranks above them. Before the engine is contacted, the run records a `steering.manifest` frame that names every item as included or cut, with the reason. A turn whose record read fails runs on the instructions alone, and the frame names `record` as unavailable.

## Tools

The engine is declared every governed tool plus the two meta-tools. Each completion shows the provider the pinned belt, the meta-tools and what the model loaded by name, under `assertToolListFitsProvider` (#2611). A tool call runs through the materialised tool's own `execute`, where IAM, entitlement, tool RBAC, consent and approval apply; a governed write that needs a person parks and comes back in `parkedCards`.

## Errors

| Code | Status | When |
|---|---|---|
| `not_found` (reason `conversation_not_found`) | 404 | `conversationId` names no conversation in this workspace |
| `forbidden` (reason `no_principal`, `org_role_required`) | 403 | the caller carries no person to ask as, or the person holds none of the contract's roles |
| `engine_unavailable` | 503 | `stella-serve` is not configured or could not be reached; nothing falls back to an in-process loop (ADR-053 §4) |
| `assistant_run_not_recorded` | 503 | the ledger could not admit the turn, or a receipt could not be written; the assistant does not answer from a path that was not recorded |
| `engine_aborted` | 409 | the turn was cancelled before it answered (a per-turn budget stop); nothing is saved as a reply |
| `insufficient_credits`, `billing_suspended`, `assistant_spend_cap` | 402 | the platform-funded turn credit gate refused the turn |

On the SSE route a failure after the turn is prepared arrives as an `error` event carrying the code (or the handler refusal's reason), followed by `event: done` with `[DONE]`.
