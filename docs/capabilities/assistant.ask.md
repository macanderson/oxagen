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
| `conversationId` | `cnv_` public id, uuid, or null | no | the conversation to continue, by the `cnv_` id every conversation capability takes (`get_conversation` reads it back) or by the internal id `conversationId` below carries; null opens a new conversation. A conversation that is not yours, or is deleted or archived, is `not_found` |
| `content` | string | yes | 1 to 32 KiB, the cap every chat ingress shares |
| `pageContext` | object or null | no | `{ route, orgSlug, workspaceSlug, entityId, entityLabel }`: where the person was when they asked, and the record on screen. Null for a caller with no page. See [Page context](#page-context) |
| `turnId` | uuid | no | a name the caller mints for this turn so it can stop it with [`cancel_assistant_turn`](assistant.turn.cancel.md). Omitted, the turn can still end on a budget stop, but nobody can stop it by name. See [Stopping a turn](#stopping-a-turn) |
| `goal` | object | no | `{ statement, maxRounds }`: `statement` is 1 to 2,000 characters, trimmed; `maxRounds` is 1 to 4, default 3. Omitted runs one ordinary turn. See [Goal-shaped turns](#goal-shaped-turns) |

### Page context

| Field | Type | Required | Constraint |
|---|---|---|---|
| `route` | string | yes | 1 to 64 characters, the app's route key (`fleet`, `runs`, `spend`) |
| `orgSlug`, `workspaceSlug` | string | yes | 1 to 128 characters each |
| `entityId` | string or null | no | 1 to 256 characters, the id of the record on screen; defaults to null |
| `entityLabel` | string or null | no | 1 to 256 characters, the record's name as the page drew it; defaults to null, so a caller that sends no label still validates |

The app's pages declare their record with `<PageRecord>`: the Run page sends the run's name (else its task reference), the agent page the agent's registered name, the Mandate page the mandate's purpose, and the Runtimes page the host's name. The flyout sends a label only beside the id it names, and cuts one past 256 characters to 255 and an ellipsis, so a long harness title or mandate purpose never refuses the question.

The cap holds these sources whole: a hostname (253), a steering record's title (200), an agent's name (128), and a run's generated name or derived title (80). A mandate's purpose (2,000), a harness's own session title, and a ledger run's task reference can run longer. The contract refuses a label past 256 from any other caller rather than rewriting it.

A label is untrusted text: an agent, a model, or a person wrote it. The turn gives the model the page context as one line of system-injected context. It prints the id and the label on that line with control, line-separator, and format characters removed (the format characters include the bidirectional overrides and the Unicode tag characters), cuts the label to the cap again, and quotes it as a JSON string, so a quote inside it cannot close it. It says the label is the record's name and not an instruction. A label with no `entityId` is ignored. The line is built by `pageContextMessage` (`packages/agent/src/runtime/page-context.ts`).

## Output

| Field | Type | Description |
|---|---|---|
| `conversationId` | uuid | the conversation the turn was appended to |
| `conversationPublicId` | string | `cnv_…`, the same conversation by its public id; `get_conversation` reads the thread back |
| `userMessageId` | uuid | the person's message |
| `assistantMessageId` | uuid | the persisted reply |
| `runId` | string | `arun_…`, the run the turn was recorded as; `get_run` opens it |
| `reply` | string | the assistant's reply, whole |
| `parkedCards` | array | one `{ approvalId, capability, expiresAt }` per governed write the turn opened that waits on a person, in park order; empty when nothing parked. A turn can park more than one, and each has its own five-minute expiry, so all of them are returned |
| `toolCalls` | array | one `{ toolCallId, toolName, outcome, durationMs, approvalId }` per tool call the turn made, in the order the run recorded them, including `search_tools` and `load_tools`; empty when it made none. `outcome` is `completed`, `failed`, `denied`, `cancelled` or `parked`. `approvalId` names the parked card a parked call waits on and is null for every other call |
| `stopped` | boolean | true when the person stopped the turn with `cancel_assistant_turn`; `reply` is then what the engine wrote before the stop, and may be empty. False otherwise |

## Conversation

A turn continues a conversation only when it is the asker's own, in this workspace, and neither deleted nor archived: the rule `list_conversations` and `get_conversation` apply (#4163). The person's message is written before the engine is asked anything, so a turn that fails still leaves the question on the record. The reply is written with the run it was recorded as (`metadata.runId`) and, when the turn parked governed writes, the cards (`metadata.parkedCards`), so `get_conversation` returns the thread as the turn answered it.

## Recording

`openAssistantRun` (`@oxagen/agent`) admits the turn before the engine is contacted: the workspace's managed interactive agent acting through the `oxagen.assistant` service principal, the asking person's human principal as the initiating principal, a pinned authorization snapshot and a digest-only retention policy. Every provider and tool request the host answers is recorded first as `model.engine_call_completed` or `tool.engine_call_completed`, keyed by the engine frame's `seq`; the belt meta-tools `search_tools` and `load_tools` are recorded through the tool receipt. A tool receipt's outcome is `completed`, `failed`, `denied`, `cancelled` or `parked`. `denied` means a gate or a person refused the call. `parked` means the call did not run and waits on a person's approval, and the receipt names that approval's public id (`approval_public_id`, `apr_…`). The engine is told `refused_by_policy` for a parked call, because its error vocabulary has no wait. A goal-shaped turn also records each round's verdict as `verification.goal_verdict`: the round, whether the goal was met, the digests of the goal and of the verifier's reasoning, and the verifier's cost, with the goal and the reasoning as the frame's body. Every verdict is written before the seal, and a verdict that cannot be written cancels the turn. The run spec's goal is the goal statement when one is set. The seal carries verdict `waived` for a completed turn, `cancelled` for an aborted one and `failed` for an engine failure. A turn the person stopped is sealed `cancelled` with the reason `stopped by the person who asked`.

The run is admitted on the `chat` (SSE) or `api-chat` (API, MCP) surface, and `list_runs`, `list_recent_runs` and `search_tools` exclude both: the assistant is Oxagen's, and its turns never appear as the customer's runs.

## Stopping a turn

A caller that passes `turnId` can stop the turn with [`cancel_assistant_turn`](assistant.turn.cancel.md) (#4164). The turn registers under the person who asked, in this workspace, once the gates have named them, and drops out when it ends. Only that person's stop reaches it.

A stopped turn cancels its engine turn, seals its run `cancelled`, and still answers: `reply` is the text written before the stop, saved with message status `stopped`, and `stopped` is true. A tool call that already ran is not undone, and a write that parked stays in `parkedCards`.

A per-turn budget stop also aborts the turn, and seals it `cancelled`, but it refuses with `engine_aborted` and saves no reply. A dropped connection, closing the flyout and leaving the page are not stops. The turn is not tied to the connection, so it runs to its end and its reply is on the record when the person comes back (ADR-092, ADR-176, #3292). On the SSE route the caller sends `turnId` in the request body, and the turn stops through its own registration, not through the request.

## Goal-shaped turns

A turn with a `goal` is judged (ADR-177). The engine works in rounds, and after each round an independent verifier reads the transcript and rules whether the goal is met. The verifier's model calls arrive with the `verdict` role and are answered on a different tier from the worker's. A met goal ends the turn and the reply is the worker's last answer. An unmet goal sends the verifier's feedback back to the worker for the next round. A goal still unmet when the rounds run out fails the turn with `engine_aborted`, and nothing is saved as a reply.

The caller sets the goal, never the model: this contract is not on the agent surface. The goal is capped at 2,000 characters because the engine repeats it in every round and in every verifier call, and at 4 rounds because each round is a whole turn plus a verifier and a person is waiting.

Rule authoring is the first caller: [`author_graph_rule`](graph.rule.author.md) takes the rule as data and asks this turn with the goal `ruleAuthoringGoal` (`@oxagen/agent`) builds from it on the server (ADR-182). The goal is a `query_ontology` traversal over the rule's relationship type, from a node of the first source, that returns a node of the second. The API route, the MCP tool and `POST /chat/stream` all carry a `goal` their caller sends. The app's flyout sends none, because the rev1 app has no rule-authoring control.

## Steering

The system prompt carries the workspace's steering after the governance baseline. The steering assembler (`@oxagen/steering-assembler`) ranks the workspace's published context records and its configured instructions, fits them to 4,096 budget tokens, and cuts what does not fit (ADR-093 §7). The instructions carry SHOULD, so every published MUST record ranks above them. Before the engine is contacted, the run records a `steering.manifest` frame that names every item as included or cut, with the reason. A turn whose record read fails runs on the instructions alone, and the frame names `record` as unavailable.

## Tools

The engine is declared every governed tool plus the two meta-tools. Each completion shows the provider the pinned belt, the meta-tools and what the model loaded by name, under `assertToolListFitsProvider` (#2611). A tool call runs through the materialised tool's own `execute`, where IAM, entitlement, tool RBAC, consent and approval apply; a governed write that needs a person parks and comes back in `parkedCards`.

## Errors

| Code | Status | When |
|---|---|---|
| `not_found` (reason `conversation_not_found`) | 404 | `conversationId` names no conversation of the asker's in this workspace, or one that is deleted or archived |
| `forbidden` (reason `no_principal`, `org_role_required`) | 403 | the caller carries no person to ask as, or the person holds none of the contract's roles |
| `forbidden` (reason `kill_switch`) | 403 | an `agent` kill switch is on for the workspace's assistant agent; the turn is refused before anything is written, and the message names the switch and its reason |
| `engine_unavailable` | 503 | `stella-serve` is not configured or could not be reached; nothing falls back to an in-process loop (ADR-053 §4) |
| `assistant_run_not_recorded` | 503 | the ledger could not admit the turn, or a receipt could not be written; the assistant does not answer from a path that was not recorded |
| `engine_aborted` | 409 | the turn was cancelled before it answered by a per-turn budget stop; nothing is saved as a reply. A stop the person asked for is not an error: see [Stopping a turn](#stopping-a-turn) |
| `insufficient_credits`, `billing_suspended`, `assistant_spend_cap` | 402 | the platform-funded turn credit gate refused the turn |

On the SSE route a failure after the turn is prepared arrives as an `error` event carrying the code (or the handler refusal's reason), followed by `event: done` with `[DONE]`.

While the turn is quiet, the SSE route writes a `: keep-alive` comment every 15 seconds, so a proxy or load balancer does not close an idle connection. A dropped connection does not stop the turn (ADR-092, ADR-176): the turn runs to completion and persists its reply, and a client that lost the stream reads the finished reply with [`get_assistant_reply`](assistant.reply.get.md) by the run the stream's first event named. Stopping a turn on purpose is [`cancel_assistant_turn`](assistant.turn.cancel.md) naming the `turnId` the request carried (#4164).
