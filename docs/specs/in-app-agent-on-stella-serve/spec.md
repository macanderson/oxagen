# The in-app agent on Stella's headless engine — the wire, the answerer, and the gaps

- **Status:** Proposed
- **Date:** 2026-09-09
- **Author:** platform
- **Related:** [ADR-053](../../adr/ADR-053-in-app-agent-on-stella-serve-and-funding-sources.md)
  (the decision), [ADR-043](../../adr/ADR-043-runtime-excision.md) (what was
  cut, and the commit it is recoverable from), `macanderson/stella`
  `docs/spec/serve-surface.md` and `docs/wire/` (the engine side),
  `packages/agent/src/runtime/governed-turn.ts` (the loop this replaces),
  [the funding-source spec](../model-funding-source/spec.md) (what answers a
  completion)

---

## 1. Summary

ADR-053 decides that the in-app agent is a turn on `stella-serve`, reached
over HTTP, with every completion and tool call answered by Oxagen. This spec
is how: the routes and frames the client speaks, what the answerer does with
each reverse request, and the gap between the client that was deleted on
2026-09-08 and the server as it stands at Stella 0.9.411.

The one-line finding that shapes the plan: **the old client cannot be
restored, it has to be rewritten.** It pinned Stella 0.6.2, hand-wrote its
wire types because no codegen existed, and modelled four of the server's
seven frame tags. The server has since grown server-owned sessions,
resumable streams, streamed model deltas, steering, and a provider-routing
hint the old client silently ignored. The generated schema that the old
client's own header wished for now exists.

---

## 2. What the server offers

All paths take `Authorization: Bearer <token>`, read from
`STELLA_SERVE_TOKEN_FILE` or `STELLA_SERVE_TOKEN`. Auth runs before routing
and a wrong token gets a delayed 401. `/healthz` and `/readyz` take no auth.

| Route | Purpose |
| --- | --- |
| `POST /v1/sessions` | open a server-owned transcript: `{system_prompt, budget}` → `{session_id}` |
| `POST /v1/sessions/{id}/turns` | start a turn on it: `{provider_id, tools, input, principal?, engine?, …}` → `{turn_id, session_id, clamped[]}` |
| `GET /v1/turns/{id}/events` | SSE, one subscriber; `?after=<seq>` or `Last-Event-ID` resumes |
| `POST /v1/turns/{id}/provider-result` | answer a completion: `{request_id, status: "ok", result}` or `{…, status: "error", error}` |
| `POST /v1/turns/{id}/provider-delta` | optional streamed fragments `{request_id, deltas: [{kind, text}]}`; each batch resets the idle deadline |
| `POST /v1/turns/{id}/tool-result` | answer a tool call: `{request_id, output: {ok: {content, data?}} | {error: {message, class?}}}` |
| `POST /v1/turns/{id}/cancel` | stop at the next step boundary |
| `POST /v1/turns/{id}/steer` · `/pause` · `/resume` | inject a message, hold, release |
| `GET /v1/sessions/{id}` · `DELETE` | history, cost, live turn, `held`; end |

Frames on the stream, each carrying a `seq`: `event` (an `AgentEvent`),
`tool_request`, `provider_request`, `requery_request` (opt-in only),
`turn_held`, `turn_released`, `turn_complete`. One frame arrives without a
`seq`: `replay_truncated`, when `?after=` asked for history the server no
longer holds.

A `provider_request` carries `provider_id`, a `role` (`worker`, `verdict`,
`summarization`, …), and a `CompletionRequest` with `messages`, `tools`,
`max_output_tokens?`, `temperature?`, `effort?`. **It carries no model.** The
host chooses the model from the routing hints, and the answer is one
`CompletionResult` with `text`, `tool_calls`, a required `usage`, a required
`model`, and a required `cost_usd`. The engine folds that cost into its
budget, so the host is the metering authority and the engine's own count is
a cross-check.

The TypeScript types are generated from Rust and committed:
`docs/wire/serveframe.d.ts` and `serveframe.schema.json` for what the server
sends, `serveinbound.schema.json` for what it accepts. The client here is
generated from those, and a schema change reddens this repository's
typecheck rather than a production turn.

The binary ships a container image (`packaging/docker/Dockerfile.serve`,
port 8080, health check built in). `STELLA_SERVE_TOOLS` accepts only
`remote`, so a local tool surface is not a configuration mistake anyone can
make.

---

## 3. The answerer

Two decisions taken while building it, each reversing a line in the plan
below and stated here so the plan is read against them.

**Stateless turns, not server-owned sessions.** The plan called sessions
"the prompt-cache win". That is true when the engine calls the vendor and
false here: Oxagen makes every completion, and the engine hands the whole
transcript back inside each `provider_request`, so the vendor sees the same
prefix either way. A session would add a per-conversation id to store, a
reclaim to recover from, and nothing the cache can feel. Each turn is
`POST /v1/turns` with the transcript the route already assembles; `?after=`
resume works on a stateless turn exactly as on a session turn.

**The turn's result keeps its shape.** Both chat routes consume a turn as a
stream of AI-SDK-shaped parts (`start-step`, `text-delta`, `tool-call`,
`tool-result`, `finish`, …), and the API's on-the-wire format is pinned
byte for byte by a snapshot test. So `runGovernedTurn` keeps its signature
and its result, and the engine's events are mapped onto those parts inside
it. The routes, the translators, persistence, and both wire formats do not
change. A tool's rich host-side output (the render directives the app
paints) is kept in a per-call table while the engine sees only its text,
and is re-attached when the engine's `tool_result` event arrives.

`packages/agent`'s `runGovernedTurn` keeps three of its four jobs and gives up
the fourth. It still builds the system prompt, still materialises tools from
capability contracts, and still writes the audit trail. It no longer runs
the step loop. In its place:

1. **Assemble the transcript** the way the route does today: system prompt,
   history, the volatile context messages, the user's instruction and its
   attachments, mapped onto `CompletionMessage`s.
2. **Start the turn** with that transcript, the tools as full
   `ToolContract`s, and the acting user as `principal`. A bare tool schema
   is coerced to untrusted and high-risk at the engine's gate, and an absent
   principal attributes every call to an anonymous host, so both fields are
   required here, not optional.
3. **Answer each `tool_request` through `kernel.invoke()`.** That is the
   whole governance argument: IAM, entitlement, approval, and the billing
   gate all run, an audit row is written, and under ADR-052 the call is a
   governed action. The engine receives the result and never a credential.
   A gate that says no returns `{error: {message, class: "refused"}}`, and
   the engine reports it as a refusal rather than a failure.
4. **Answer each `provider_request` through `@oxagen/ai`.** The funding
   source resolves the key. `role` picks the tier: `worker` takes the
   organisation's balanced model, `verdict` takes a different model from the
   worker so verification stays independent, `summarization` takes the fast
   tier. Deltas go back on `provider-delta` as they stream, so the chat
   surface renders tokens as they arrive and the engine's idle deadline is
   reset. The result carries usage and cost, and the cost is what the
   metering in the funding-source spec records.
5. **Forward `event` frames** to the chat stream as the parts the routes
   already read, tracking the last `seq` so a dropped connection resumes
   with `?after=` rather than restarting. Writing the same events to the
   run ledger with their `seq` is the next slice, not this one: nothing
   records a chat turn in the ledger today, and the ledger's run and
   attempt shapes (`RunSpecV2`, retention policy, engine identity) are
   their own piece of work.
6. **Cancel** on client disconnect, and tolerate the 409 the server returns
   for an answer that arrives after the turn ended.

Wall-clock rule: a reverse request the answerer cannot settle within the
turn's `reverse_request_timeout_ms` is terminal on the engine side, so an
approval that waits on a person is answered with a refusal that names the
pending approval, and the person's decision starts a new turn.

---

## 4. Gap table

What the restored path needs, whether the server has it, and whether the
deleted client did. File references are to Stella at 0.9.411 and to the
Oxagen tree at the commit ADR-043 names.

| Need | Server today | Old client | Verdict |
| --- | --- | --- | --- |
| health and readiness | both routes, unauthenticated | health only | add readiness for container gating |
| bearer auth, delayed 401 | yes | yes | keep |
| `seq` on frames, `?after=` resume, `replay_truncated` | yes | none; a dropped stream was fatal | build; this is the largest new piece |
| `provider_request.provider_id` and `role` | yes | ignored | build; ignoring it routes the verifier to the worker's model |
| streamed deltas and idle-deadline reset | yes | none | build; without it there is no token streaming |
| provider error taxonomy | ten kinds, including overload and context overflow | seven | regenerate from schema; a mis-classified 529 loses the engine's parked wait |
| tools as `ToolContract` | accepted; bare schema coerced to untrusted | bare schema only | send contracts |
| `principal` on the turn | yes | none | send the acting user |
| stale `request_id` | 409 | any non-2xx threw | tolerate after cancel |
| server-owned sessions | yes | none, whole transcript resent each turn | not used; see §3, the host makes the model call so the cache sees the same prefix either way |
| steer, pause, resume, `turn_held` | yes | none; an unknown tag fell through and read as a hang | handle the frames; steering is optional |
| per-turn engine knobs, budget modes | yes | budget only | send `max_output_tokens` from the output-budget module |
| checkpoints | routes exist, no default store | none | skip for now, the run ledger is the record |
| approval gate | none; a require-approval verdict is a refused tool call | none | answer through the kernel's approval, refuse with the pending id |
| wire types | generated `.d.ts` and JSON schema | hand-written | generate |
| version pin | 0.9.411 | 0.6.2 | pin the current tag and cut a fresh verification note |

---

## 5. Build plan

Four slices, each landable alone and each leaving the tree better than it
found it.

1. **`packages/stella-engine-client`, rewritten.** Types copied from
   Stella's generated wire declarations at a pinned tag, a fetch-only client
   with turns, sessions (available, unused by the answerer), resumable SSE,
   deltas, reverse-request answers, cancel, and steer.
   A smoke test that builds the pinned tag's serve binary and drives one
   turn end to end, plus a fake server for the unit tests. The contract
   test for the schema pin is `check:contracts`'s neighbour: a regenerated
   type file that differs from the committed one fails the check.
2. **The answerer in `packages/agent`.** The turn lifecycle from §3, the
   kernel-backed tool answer, the funding-source-backed completion answer
   with deltas, and the event-to-part mapping. The chat routes need no
   change because the result shape is kept. The in-process step loop is
   deleted in the same change, per ADR-053 §4. The ledger write is a
   follow-up.
3. **The container.** A `stella-serve` service in the node's compose file
   with its token in Parameter Store beside the others, a readiness gate in
   the deploy script, and the engine's health in the platform health check.
4. **Role routing and verification.** The `verdict` role bound to a model
   distinct from the worker's, and a goal-shaped turn for the schema builder
   and rule authoring so the engine's verify ladder judges the result. This
   slice is where the graph rule and schema builder capabilities get their
   witness: a rule authored across two sources that the graph then answers
   a query through.

Slice 1 has no dependency on the funding source. Slice 2 depends on both.
