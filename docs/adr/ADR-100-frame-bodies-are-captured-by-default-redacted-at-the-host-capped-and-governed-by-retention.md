# ADR-100: Frame bodies are captured by default, redacted where they are produced, capped, and released by retention

- **Status:** Accepted
- **Date:** 2026-09-18
- **Owners:** evidence, app, platform
- **Related:** Mission Control spec §7.1 (the run record), §8.2 (Frame), §8.4
  (replay grade), ADR-058 (run record placement, retention default, and
  digest-only), ADR-043 (Oxagen governs agents, it does not run them),
  #2952, PR #3342,
  `packages/tacho/src/evidence/frame-body.ts`,
  `packages/tacho/src/evidence/replay-grade.ts`,
  `packages/run-ledger/src/frame-body.ts`,
  `packages/run-ledger/src/event-payload-registry.ts`,
  `packages/agent/src/runtime/assistant-run.ts`,
  `packages/tacho/src/collector/model-proxy.ts`,
  `packages/tacho/src/collector/mcp-gateway.ts`

## Context

Spec §8.4 grades a recording on what a reader can do with it. `inspect` means
the chain holds and every frame is accounted for. `view` means the reader can
also read what the agent was asked, what the model answered, what a tool was
called with, and what came back. Everything above `view` builds on it.

Every recorder in the tree stopped at `inspect`, and none of them stopped there
by decision:

- The Claude Code hooks digested the tool input, the tool response, the prompt
  and the last assistant message, and dropped the bytes.
- The loopback model proxy held the request in memory to digest it and said so
  in its header comment: it never wrote a body.
- The MCP gateway recorded a call as a name, a status and a duration.
- The in-app assistant's `Recorder` digested each tool input and output and
  each model call, and passed no body. The ledger has accepted one since
  ADR-058: `AttemptEventInput.body` is read, `prepareFrameBody` redacts it,
  digests the redacted bytes, and the store writes it through the body store
  when the run's pinned retention policy authorises the frame's content class.
  Nothing ever passed one, so that path had never run outside its own tests.

So a customer opening a run saw that a model was called and a tool ran, and
nothing that said what happened. `get_run_frame_body` had nothing to return.

Two further facts came out of building this.

The ledger's default policy for an in-app run is `content_exact` with every
content class retained (`ASSISTANT_RETENTION_POLICY`). Bodies were already
authorised. Only the producers were silent.

`isContentBearingFrame` and four other readers each held their own literal list
naming `model.call_completed` and `tool.call_completed`. The in-app assistant is
the only ledger producer in the tree and it writes
`model.engine_call_completed` and `tool.engine_call_completed`. So the seal
derived no `body_missing` gap, the Runs page counted zero model calls, the
transcript folded a whole run into one entry, and the cost rollup reported zero
turns. Capturing the bodies would not have raised a single run's grade while
those lists disagreed with the producer.

## Decision

### 1. A body is captured by default, not on request

Every recorder attaches the content its frames are about, with no flag to turn
on. A run that reaches `inspect` and no further is now a run that hit a stated
limit: a policy, a cap, or a class nobody retains. It is not a run whose
recorder was never asked.

The alternative, an opt-in, makes the useful setting the one nobody chose, and
the first time anyone needs a body is after the run they needed it for.

### 2. Redaction runs where the bytes are produced, and the digest names the
redacted bytes

The host redacts before it digests (`prepareContent`), and the ledger redacts
before it digests (`prepareFrameBody`). In both, `digest` names the bytes that
are kept, never the bytes that arrived. A reader who verifies a body against
its digest succeeds, and a secret that was cut is absent from both.

The control plane runs its own detectors and refuses a body they would redact,
so a host that skipped this loses the body rather than leaking it.

A frame's receipt digest is a different claim and keeps its own value. The
proxy's `oxagen.request_digest` says these bytes crossed the wire to this
vendor; the assistant's `input_digest` says the tool was called with this.
Neither is the body's digest, and neither should be: re-redacting on the
agent's critical path to make them agree would cost every call to satisfy a
comparison nothing performs.

### 3. One megabyte per body, and past it there is no body

`TACHO_MAX_BODY_BYTES` and `ASSISTANT_MAX_BODY_BYTES` are both 1 MiB. Content
past the cap is recorded as no body at all. The frame keeps its digest, and the
seal derives `body_missing`, so a reader sees a size limit.

Truncating was the alternative and is worse in both directions. The truncated
bytes digest to a value naming something that never existed, and truncated JSON
parses in no reader. A batch carries at most `TACHO_MAX_BATCH_BODY_BYTES`
(4 MiB) so that 200 events cannot ship 200 MiB, and the shipper cuts the batch
at the event that would cross it rather than separating a body from its event.

### 4. Retention decides whether bytes are kept, and the workspace sets
retention

A body is attached only when the pinned policy's mode keeps exact content and
the frame's content class is listed. `retention.mode: digest_only` ships no
bytes from the host and retains none in the ledger; the digest is still
chained, and the run grades `inspect` by that decision rather than by
accident. The server enforces the same rule, so a host running a bundle it has
not refetched costs one refused body and nothing else.

### 5. The registry names which events complete a step, and every reader asks it

`EventTypeDefinition` gains `step`, set on the four completed call events.
`MODEL_CALL_EVENT_TYPES`, `TOOL_CALL_EVENT_TYPES` and `stepKindOfEventType`
derive from it, and the seal rollup, the completeness gaps, the transcript
fold, the Runs page and the cost rollup read them instead of holding a list.
A write-ahead intention is deliberately not a step: counting it would report
every call twice.

`isContentBearingFrame` lives in `@oxagen/tacho`, which `@oxagen/run-ledger`
depends on, so it spells the names rather than importing them. A test in
`event-payload-registry.test.ts` asserts every registry step type is
content-bearing, so the two lists cannot drift apart in silence.

### 6. Where each body rides

A frame carries at most one body, keyed by its event id, in both recorders.

| Producer | Frame | Body |
|---|---|---|
| In-app assistant | `model.engine_call_started` | The completion request: messages, tools, parameters. The turn's prompt is inside it. |
| In-app assistant | `model.engine_call_completed` | The completion, with usage. |
| In-app assistant | `tool.engine_call_started` | The arguments. |
| In-app assistant | `tool.engine_call_completed` | The output, or the error when the call failed. |
| Claude Code hooks | `tool_requested`, `tool_call`, `oxagen:message`, `turn_end` | Tool input, tool input and output, the prompt, the last assistant message. |
| Model proxy | `llm_call` | `{ request, response }`, both as the exact decoded bytes. |
| MCP gateway | the call's frame | The arguments and the result. |

The request rides the write-ahead frame because it is durable before the
provider is contacted, so a turn that dies mid-call still says what it was
asked to do. The completion rides the call frame because that is the frame
`isContentBearingFrame` requires a body on. Neither frame repeats the other's
content: the messages are the largest bytes a turn writes, and writing them
twice would double them.

The proxy has one frame per call, so its request and its response share one
JSON body. `tool_call` in the hooks already put input and output in one body,
so this follows a precedent rather than setting one.

### 7. A store that retains bodies is constructed with a body store, and says so

`resolveBodyColumns` raises when a frame's policy retains its body and the
ledger has no body store. It does not quietly record a digest instead: a
deployment that promised a workspace exact content and cannot store it is a
misconfiguration, and a run that silently downgrades is one nobody notices
until they need the bytes.

The cost is that a producer which starts passing bodies must be constructed
with the seam in the same change, or every turn it records fails at its first
frame. `deferredEvidenceBodies` is that seam, the body half of the same lazy
store `deferredEvidenceArchive` already resolves, and
`assistantRunStore()` is exported so a test can assert both are present
without opening a storage driver.

## Consequences

A run recorded after this change reaches `view` when its policy keeps exact
content, and states why when it does not. `get_run_frame_body` returns bytes.
The Runs page counts the calls a run made. The seal's rollup and its
completeness gaps describe the run they sealed.

Storage grows by roughly the size of the traffic, bounded per body and per
batch. A workspace that does not want the bytes sets `digest_only` and keeps
the chain.

Three gaps stay open and are named here rather than left to be discovered:

- A refused call, on either the proxy or the gateway, seals as
  `policy_decision`, and `contentClassOf` gives that kind no retention class,
  so its body is dropped at the class check. The record says what was
  attempted, not what was said. Giving `policy_decision` a class is a
  retention-vocabulary change and belongs with the people who own retention.
- `@oxagen/run-ledger` canonicalises a body with `canonicalJson` and a receipt
  digest with `digestJcs` from `@oxagen/run-evidence`. The two agree on the
  values `canonicalJson` accepts and are documented as separate; nothing here
  makes them agree further.
- An unserialisable tool input still aborts the turn, because `digestJcs` runs
  before the body is built and is fail-closed by design. An unserialisable
  model request loses only its body. The asymmetry is deliberate: a tool call
  nobody can attribute should not run.
- `model.engine_call_completed` has no `turn_index`, because the assistant
  tracks an engine sequence rather than a turn. So an assistant run's seal
  rollup reports `turns: null` and its `turns` zoom folds on the run's
  boundaries instead of on an index. Giving the assistant a turn index is a
  schema addition and a change to what the engine reports, not a reader fix,
  so it is left for whoever needs the count.
