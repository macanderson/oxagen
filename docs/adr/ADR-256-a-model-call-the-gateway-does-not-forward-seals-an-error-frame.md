# ADR-256: A model call the gateway does not forward seals an error frame

- **Status:** Accepted. The agent building lane tacho-transcript-capture chose
  this under SCR-002. Mac has not ruled on it.
- **Date:** 2026-10-02
- **Owners:** tacho
- **Related:** issue #3824 (item 3), macanderson/oxagen#3822, ADR-160,
  ADR-189, `packages/tacho/src/collector/model-proxy.ts`,
  `packages/tacho/src/evidence/replay-grade.ts`.

## Context

The loopback model proxy is the gateway on the host. It stands between a
wrapped harness and the model vendor and records every call that passes
through it.

- A call it forwards seals one `llm_call` frame when it settles. That holds
  even when the vendor never answered: an unreachable vendor or a connection
  that never opened still seals an `llm_call` with its `api_error_class`,
  and the frame carries the request the proxy tried to send.
- A call it refuses for the operator's reasons (a budget, a model policy, a
  paused session, a credential) seals one `policy_decision` frame.

Three exits sealed nothing:

1. A request over the bytes the proxy holds for one call, 64 MiB by default.
   The harness was answered 413 `request_too_large`.
2. A harness that left, or whose connection broke, before its request had
   all arrived.
3. An exception in the proxy after it began reading the request and before it
   opened the call to the vendor. The harness was answered 502
   `gateway_error`.

In each case the harness made a model call and saw it fail, and the session's
record showed nothing.

## Decision

1. **Kind.** Each exit seals one `error` frame, with fidelity `proxy` and
   source `collector`.
2. **Chain.** The frame lands on the chain of the session the call was
   attributed to. For exits 1 and 2 the body never arrived whole, so the
   proxy attributes the call the way it attributes any call, less the two
   sources it reads from the body (an Anthropic `metadata.user_id` and
   Codex's `prompt_cache_key`). A call it can attribute to no session lands
   on the host's own chain, as any proxy frame does. A correlation that
   throws counts as no session.
3. **Body.** `provider`; `model` when the proxy read one; `api_status_code`
   when the proxy answered the harness (413 or 502; exit 2 has none, because
   the harness had gone); `api_error_class`, which is `request_too_large`,
   `client_aborted`, or `gateway_error`; and `api_duration_ms`, from the
   moment the proxy began reading the request.
4. **Attrs.** The attrs a forwarded call's frame carries, as far as the proxy
   got: `oxagen.enforcement_tier`, `oxagen.model_api`, and
   `oxagen.correlation` always, and `oxagen.credential_basis` and
   `oxagen.run_token_id` once it resolved the credential. Then
   `oxagen.not_forwarded`, which repeats the `api_error_class`;
   `oxagen.provider`; `oxagen.request_bytes_read`, the request bytes the
   proxy read before it stopped; and `oxagen.request_digest` when the whole
   request arrived.
5. **No body content.** The frame carries no request or response. Nothing
   reached a model, and for exit 1 the proxy cannot hold the request.
6. **Once per call.** `forward` keeps a record of how far the call got. The
   refusal frame and `settle` mark the call as recorded, and so does handing
   the request to the vendor, after which `settle` seals the frame whatever
   happens. The request handler's catch seals only a call nothing has
   recorded yet. A refusal whose frame fails to reach the WAL is rolled
   back, so it has recorded nothing. The agent is answered 502
   `gateway_error`, and the catch seals this frame at the refusal's seq
   when the WAL takes the write. If the WAL still refuses, that frame is
   rolled back too, and the chain keeps no gap either way.
7. **Same paths as a forwarded call.** A call on a path the proxy does not
   meter (`other`) seals no frame here, as it seals none when forwarded.
8. **Counters.** The call does not count toward `calls_observed` on
   `/healthz` or toward `refused` in the proxy's stats. Both count calls a
   vendor saw or the operator refused.

## Why `error` and not `llm_call`

- **The replay grade.** An `llm_call` is a content-bearing frame
  (`isContentBearingFrame`), so it owes a body. A call no vendor saw has no
  exchange to keep, and an `llm_call` without one would add a `body_missing`
  gap and grade the whole session `inspect`. An `error` owes no body.
- **The session's figures.** Ingest counts each first sighting of an
  `llm_call` as a model call. It counts an `error` with an API status or
  class as an API error. From the harness's side, an API error is what
  happened.
- **The line between the two.** A call that left the host is an `llm_call`
  whatever became of it, and its frame carries the request that left. A call
  that never left is an `error`.
- **One exception, older than this ADR.** The operator can stop a call while
  `beforeForward` runs, before the proxy opens the call to the vendor. That
  call still seals an `llm_call` with `api_error_class` `interrupted`, from
  `settle`, and its frame holds the request the proxy would have sent. This
  ADR leaves that path as it is: the frame records the operator's cut, and
  the proxy had built the request by then.

## Consequences

- Each of the three exits now leaves a frame on the session's chain, and the
  Run page shows it with the session's other errors.
- Claude Code reports a failed call too: an API error record in its
  transcript, and a `StopFailure` hook when the turn ends on the failure.
  Tacho seals an `error` frame for each. So `num_api_errors` can already
  count one failure more than once on a Claude Code session, and this frame
  adds one more for a call that fails at the gateway. No reader dedupes
  `error` frames today. One that needs one count per failed call can key on
  `oxagen.not_forwarded`, which only the gateway's frame carries.
- A host keeps sealing nothing for these exits until its daemon is upgraded.

## Alternatives considered

- **An `llm_call` with no usage, marked `oxagen.not_forwarded`.** Rejected
  for the grade and the model call count above.
- **A `policy_decision` with a deny.** Rejected. Only exit 1 is a limit of
  the gateway's own, and none of the three is an operator's decision. A deny
  would also count in the session's policy denies.
- **A `telemetry_gap`.** Rejected. A gap says Tacho lost frames. Here nothing
  was lost: the call failed, and the frame says how.
