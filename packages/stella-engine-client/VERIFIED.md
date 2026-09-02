# Verification record

What the sidecar wire contract in this package has actually been checked
against, and how.

- **Date:** 2026-07-29
- **Engine under test:** `stella-serve` 0.6.2, built from stella `main` at
  `c8249788` with `cargo build -p stella-serve --bin stella-serve`
- **How to reproduce:**
  ```sh
  # in a stella checkout
  cargo build -p stella-serve --bin stella-serve

  # in this repo
  STELLA_SERVE_BIN=/path/to/stella/target/debug/stella-serve \
    pnpm --filter @oxagen/stella-engine-client exec vitest run
  ```

## Result

`28 passed (28)`, of which 3 are the live round trip against the real binary.
Coverage 99.0% statements / 94.8% branches / 96.8% functions — above the
package's 80/70/80/80 gate.

The headline test drives a **complete two-step agentic turn** in which oxagen
owns the model and the tools and the Rust engine owns the orchestration:

```
POST /v1/turns                          -> {"turn_id":"turn-<32 hex>"}
GET  /v1/turns/{id}/events               (SSE)
  <- provider_request  prov-0   (2 messages)
  -> provider-result             host "model" returns a tool_call
  <- tool_request      tool-0   get_weather {"city":"Paris"}
  -> tool-result                 host runs it: "18C, clear skies in Paris."
  <- provider_request  prov-1   (4 messages — see below)
  -> provider-result             host "model" answers from the tool output
  <- turn_complete   {"status":"completed","text":"It is 18C and clear in
                      Paris.","cost_usd":0.0005}
```

`cost_usd` is the **sum of what the host reported on both model calls**, which
is the property that makes oxagen the metering authority rather than a consumer
of stella's estimate.

### The load-bearing assertion

Model call #2 carries the conversation the engine assembled, including the tool
result threaded back in as a first-class `tool` message. This is what makes it
an agent loop rather than a proxy:

```json
[
  { "role": "system",    "content": "You are a helpful assistant." },
  { "role": "user",      "content": "What is the weather in Paris?" },
  { "role": "assistant", "tool_calls": [
      { "call_id": "call-weather-1", "name": "get_weather", "input": {"city":"Paris"} } ] },
  { "role": "tool",      "tool_results": [
      { "call_id": "call-weather-1",
        "output": { "ok": { "content": "18C, clear skies in Paris." } } } ] }
]
```

`AgentEvent`s observed on the stream: `stage`, `budget_tick`,
`block_registered`, `step_manifest`, `step_usage`, `tool_start`, `tool_result`,
`text`, `complete`.

## No API key, no network

`stella-serve` depends on `stella-protocol` + `stella-core` only — no HTTP
client, no TLS, no provider adapters — so it is *structurally incapable* of
calling a model or reading a provider credential. Every model call and every
tool call is a reverse-RPC request the host answers. The round trip above is
therefore fully deterministic and offline, which is why it can be a gate rather
than a nightly best-effort.

## Mutation proof

The acceptance criterion is "a field rename turns it red". Re-run against the
live binary, each mutation applied alone:

| Mutation | Result |
|---|---|
| `request_id` → `requestId` on `provider-result` | RED — 2 failed / 26 passed |
| `ToolOutput` internally tagged `{status:"ok"}` instead of `{ok:{…}}` | RED — 1 failed / 27 passed |
| Route drops the `/v1` prefix | RED — 6 failed / 22 passed |
| `finish_reason: "tool_use"` (Anthropic's spelling) | RED — 1 failed / 27 passed |
| *control: unmutated* | GREEN — 28 passed |

## Wire surface, as verified

There is no session resource: `POST /sessions` is a 404, and the *turn* is the
top-level thing you create. There is also no `stella serve` subcommand —
`stella-serve` is its own binary, so a probe that looks for a subcommand finds
nothing and skips everywhere, including CI.

| Route | Notes |
|---|---|
| `GET /healthz` | The only route that takes no token |
| `POST /v1/turns` | Creates and starts a turn |
| `GET /v1/turns/{id}/events` | SSE frame stream. No frame carries a sequence number |
| `POST /v1/turns/{id}/provider-result` | **Required to drive any turn** |
| `POST /v1/turns/{id}/tool-result` | **Required for any tool** |
| `POST /v1/turns/{id}/cancel` | The only teardown route; there is no `DELETE` |

Every route except `/healthz` needs `Authorization: Bearer`.

The two result routes matter most. Without a way to answer a reverse request, a
client cannot finish a single turn even with every other route correct — the
engine parks on its first model call and aborts at the deadline.

## Known gaps (verified absent, not oversights)

Named here so the next person does not rediscover them as bugs. All are
documented as unbuilt in stella's `docs/design/serve-surface.md`:

- **No resumption.** No `seq`, no `?after=`, no retained history: a dropped SSE
  connection loses whatever streamed while it was down.
- **One turn at a time.** The server keeps no conversation state between turns;
  the host owns the history and sends all of it on each `POST /v1/turns`.
- **No steering, pause, or approval routes.** `scope_review` / `ask_user`
  `AgentEvent`s have no reverse endpoint yet.
- **No token-level model streaming.** `RemoteProvider` implements `complete`,
  not `complete_observed`, so the host sees whole completions.
- **No SIGTERM drain, no `Host`-header guard, no `/readyz`, no `/metrics`.**
- **Engine knobs are mostly fixed.** Only `max_steps` and
  `reverse_request_timeout_ms` are reachable from the wire; `temperature`,
  `max_output_tokens`, `effort` and the compaction budget come from
  `EngineConfig::default()`.

## CI status

Both sidecar workflows build `stella-serve` from source at the pinned tag.
They have to: stella's release tarball ships `stella-cli` only, with no serve
binary in it.

The gate that runs on every machine is `pnpm gate` / lefthook, which runs
`test:unit`. There the smoke test skips cleanly when no binary is present, so
the wire contract is proven by the in-memory fake and by the smoke test
whenever a binary is available.
