# ADR-200: The context window is recorded on the model-call frame

- **Status:** Accepted
- **Date:** 2026-09-26
- **Owners:** run, agent, tacho
- **Related:** issue #3894, ADR-043 (Oxagen does not run the workload),
  ADR-093 (the one assembler), ADR-174 (the history summary), ADR-182 (the
  server folds the transcript), `packages/tacho/src/context-window.ts`,
  `packages/run-ledger/src/event-payload-registry.ts`,
  `packages/agent/src/runtime/context-window.ts`,
  `packages/handlers/src/run.context.get.ts`,
  `packages/agent/src/dispatch/context-projection.ts`,
  `docs/capabilities/run.context.get.md`.

## Context

The Run page draws what the model was sent on each request: the system
prompt, the steering, the tool definitions, the context the host placed in
the window, and the conversation. Nothing recorded it. The Context tab said
"not recorded" in every bar, and the frame view of a model request had no
panel at all.

Two places see a model request:

1. **The in-app assistant.** `governed-turn.ts` builds the completion request
   and `AssistantRun` writes `model.engine_call_started` before the provider
   is contacted. The request is the frame's body. The token counts arrive on
   `model.engine_call_completed`, after the provider answers.
2. **The tacho model proxy.** `model-proxy.ts` runs in `tachod` on the
   operator's machine and seals one `llm_call` frame per call, with the
   vendor's usage and the request's digest and byte count. `packages/tacho` is
   a leaf with no `@oxagen/*` runtime dependency. Its bodies can be dropped
   under `digest_only` retention, and its envelope attributes cannot.

Issue #3894 proposed a `USED_CONTEXT` edge in Neo4j carrying tokens, score,
rank and cache position. The four-store boundary puts usage counters outside
Neo4j (`tool-projection.ts` writes structure and identity only), and the
evidence ingress spec calls Neo4j rebuildable lineage derived from finalized
evidence. The window has to be recorded where the evidence is.

## Decision

### 1. The window is a member of the model-call frame

The window is recorded on the frame that records the model call, and that
frame is the record.

- **In-app:** `model.engine_call_started` carries an optional `window`
  member, typed by `contextWindowPayloadSchema` in the event payload
  registry. The started frame is written before the provider is contacted,
  so a call that fails or is cancelled still records what it would have
  sent.
- **Wrapped:** the proxy's `llm_call` frame carries the attribute
  `oxagen.window`. An envelope attribute survives `digest_only`, reaches
  `tacho_events.attrs` through `flattenEvent`, and needs no ClickHouse
  column.

`context.frames_selected` is not used. Its required members (a query
digest, a prompt template digest, a tokenizer reference and an
authorization decision) describe a retrieval selection neither producer
makes, and a tokenizer reference would claim a local count this decision
rules out. A new sibling event type is not used either. It would split one
request's evidence across two frames, and every reader that counts or folds
frames would have to learn a type that only restates the call.

### 2. A window is five blocks measured in bytes

A window lists its blocks in this order, each with its bytes and its item
count:

| Block | In-app assistant | Wrapped (proxy) |
|---|---|---|
| `system` | the system message, less the steering text it carries | Anthropic `system`; OpenAI Chat leading `system` and `developer` messages; OpenAI Responses `instructions` |
| `steering` | the assembled steering text inside the system message | the text the proxy injected, when it injected any |
| `tools` | the request's `tools`, one item per tool | the request's `tools`, one item per tool |
| `context` | the history summary, page context and recalled memory messages | absent |
| `conversation` | every other message | Anthropic `messages`; the other OpenAI Chat messages; OpenAI Responses `input` |

A block's bytes are the UTF-8 length of its parts' JSON. A block a producer
cannot tell apart is absent, and its bytes stay in the block that holds
them. The proxy cannot tell a harness's own hook context from the
conversation, so a wrapped window has no `context` block, and steering a
harness delivers through its hooks is counted in `conversation`. A window
that measured no bytes is not written.

### 3. A block's tokens are its byte share of the vendor's total

Nothing is tokenized locally. The read divides the prompt total the vendor
reported across the blocks by their bytes, with largest-remainder rounding,
so the blocks sum to the total by construction. Ties go to the earlier
block.

The total is the figure `FrameUsage` already gives: uncached input plus
cache reads plus cache writes. The two producers spell it differently. A
ledger completion's `input_tokens` already includes its cached tokens. A
tacho `llm_call`'s `input_tokens` is the uncached input, and its
`cache_read_tokens` and `cache_creation_tokens` are added to it, each absent
class read as zero. A call that reported no input keeps its bytes and has no
tokens.

A byte share is an estimate of where the tokens went. The total is the
vendor's, and every surface labels the split as a share of the request's
bytes.

### 4. `get_run_context` reads the frames

`get_run_context` answers each measured window of a run, with its request
frame, its completion frame, the vendor's prompt total and the blocks with
their tokens. It also answers the assembler's manifests: the budget, the
tokens spent, the items included and cut, and the text digest. It reads the
ledger's events or the session's `tacho_events` rows, never Neo4j.

A model call recorded with no window is counted as `unmeasured` and never
filled with a substitute. A run observed through its hooks alone, a
recording made before this decision, and a call on an API the proxy does
not parse all answer that way.

### 5. `USED_CONTEXT` is a best-effort projection

When an in-app assistant run seals, `projectRunContextWindows` reads the
run's started frames back from the ledger and merges one
`(:Execution)-[:USED_CONTEXT]->(:ContextManifest)` per window. The
execution is the turn's message, the node recall's citations already hang
on. The manifest node carries the run, the call, the block kinds and the
item counts. It carries no bytes, no tokens and no cost. A failed
projection is logged and never fails or slows the seal, and no read depends
on it. Wrapped runs are not projected yet: tacho cannot reach Neo4j, and a
projector over ingested sessions can reuse the same reader.

### 6. The frame view draws the window

The design of record (`mockups/pages/run.md`, 2026-09-25) draws the window
in the frame dialog's `model.request` and `context.assembled` panels. The
app's frame view is the Governed actions tab's open frame. It draws the
request panel on a model request frame (`llm_call`,
`model.engine_call_started`) and the assembled panel on the frame the
assembler seals (`steering.manifest`). The Context tab is still reachable,
so its Prompt panel, Prompt window and Retrieval stats read the same record.

## Consequences

- A window recorded before this change reads as unmeasured. No backfill is
  possible: a digest-only request kept no bytes to measure.
- A frame's score and whether the reply cited it are still unrecorded. No
  producer ranks context by relevance or links a reply to what it used.
- `schema.cypher` gains a `ContextManifest` constraint and index, and the
  `USED_CONTEXT` line in its edge list.
- The proxy parses the request it already decoded for its model check. It
  keeps only numbers past that point, so the measurement adds no retained
  bytes.
