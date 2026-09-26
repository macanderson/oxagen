# get_run_context

What each of one run's model requests carried, block by block, and what the steering assembler put in front of the model (ADR-193; #3894). The Run page draws a model request's window from this read in the Governed actions tab's open frame and in the Context tab's Prompt panel, Prompt window and Retrieval stats.

The window is read from the frames that recorded the model calls, never from Neo4j. An in-app assistant run records each window on its `model.engine_call_started` frame, and the provider's token counts on the matching `model.engine_call_completed`, joined on `model_call_id`. A wrapped session records it on the tacho proxy's `llm_call` frame as the `oxagen.window` attribute, beside the usage the vendor reported. The attribute is part of the envelope, so a workspace that keeps digests only still records its windows.

**Surfaces:** api, mcp, cli

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs/context`
- MCP: `get_run_context`
- CLI: `oxagen run context <run-id> [--json]`
- Authentication: session or API key (org Owner, Admin or Member; workspace Owner or Member)
- Capability name: `get_run_context`
- Not billed (`noBillingGate: true`): a console read is never a governed action. IAM default-deny; medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `runId` | string | yes | `arun_…` or `tse_…` |

## Output

| Field | Type | Description |
|---|---|---|
| `runId` | string | as asked |
| `source` | `wrapped` or `ledger` | which store recorded the run |
| `windows` | object[] | every measured window on the run's own chain, in frame order; at most 500 |
| `unmeasured` | integer | model calls the run recorded with no window |
| `assemblies` | object[] | the assembler's manifests, in frame order; at most 50 |
| `complete` | boolean | false when the read stopped at a cap: 500 windows, 50 manifests, 20,000 ledger events or 5,000 wrapped rows |

Each window:

| Field | Type | Description |
|---|---|---|
| `seq` | string | the frame that recorded the request |
| `responseSeq` | string or null | the frame that recorded the answer: the same frame on a wrapped run, the completion on a ledger run, null when no answer was recorded |
| `modelCallId` | string or null | the engine's request id on a ledger run, the vendor's on a wrapped one |
| `provider` | string or null | the provider the call went to |
| `model` | string or null | the model that answered, else the model the host asked for |
| `promptTokens` | integer or null | the prompt tokens the vendor reported: uncached input, cache reads and cache writes together; null when it reported no input |
| `bytes` | integer | every byte the window measured |
| `blocks` | object[] | `{ kind, bytes, items, tokens }` in request order |

Each assembly: `{ seq, budgetTokens, spentTokens, included, cut, textDigest }`, the summary of one `steering.manifest` frame. `textDigest` is null when nothing was included.

## The blocks

| Block | In-app assistant | Wrapped (proxy) |
|---|---|---|
| `system` | the system message, less the steering text it carries | Anthropic `system`; OpenAI Chat leading `system` and `developer` messages; OpenAI Responses `instructions` |
| `steering` | the assembled steering inside the system message | the text the proxy injected, when it injected any |
| `tools` | the request's tools, one item per tool | the request's tools, one item per tool |
| `context` | the history summary, page context and recalled memory messages | absent |
| `conversation` | every other message | Anthropic `messages`; the other OpenAI Chat messages; OpenAI Responses `input` |

A block's `bytes` is the UTF-8 length of its parts' JSON. A block the recorder could not tell apart is absent, and its bytes stay in the block that holds them. The proxy cannot tell a harness's own hook context from the conversation, so a wrapped window has no `context` block, and steering a harness delivers through its hooks is counted in `conversation`.

## Tokens

Nothing is tokenized locally. A block's `tokens` is its byte share of `promptTokens`, with largest-remainder rounding, so a window's blocks sum to its `promptTokens` exactly. A tie goes to the earlier block. A call that reported no input keeps its bytes, and every block's `tokens` is null.

A ledger completion's `input_tokens` already includes its cached tokens. A wrapped `llm_call`'s `input_tokens` is the uncached input, and the read adds `cache_read_tokens` and `cache_creation_tokens` to it, reading an absent class as zero.

## Honesty

A model call recorded with no window is counted in `unmeasured` and never given a substitute. A run observed through its hooks alone (the `observe` tier), a recording made before windows were recorded, and a call on an API the proxy does not parse all answer that way. A later sighting of a call the proxy measured (`oxagen.llm_call_duplicate_of`) is not counted again. An id outside the caller's workspace answers `not_found`.

The Neo4j `USED_CONTEXT` edges are a best-effort projection of the same frames, and this read never depends on them.
