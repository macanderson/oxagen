# Verification record — oxagen #1132

What the sidecar wire contract in this package has actually been checked
against, and how. This file exists because the contract it records was
previously *asserted* rather than verified, and the difference was invisible for
two PRs.

- **Date:** 2026-07-29
- **Closes:** oxagen #1132 (follow-up to #1081 / PR #1124)
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

#1081's acceptance criterion was "a field rename turns it red". That was
previously demonstrated only against a hand-written fixture in the same commit.
Re-run against the live binary, each mutation applied alone:

| Mutation | Result |
|---|---|
| `request_id` → `requestId` on `provider-result` | RED — 2 failed / 26 passed |
| `ToolOutput` internally tagged `{status:"ok"}` instead of `{ok:{…}}` | RED — 1 failed / 27 passed |
| Route drops the `/v1` prefix | RED — 6 failed / 22 passed |
| `finish_reason: "tool_use"` (Anthropic's spelling) | RED — 1 failed / 27 passed |
| *control: unmutated* | GREEN — 28 passed |

## What #1132 found

The previous contract was wrong about **every route**, because it mirrored a
planned session-oriented surface from stella's `docs/design/serve-surface.md`
rather than the shipped one. Nothing detected this, because the capability probe
looked for a `stella serve` subcommand that has never existed, so the smoke test
skipped in every environment including CI.

| Previously assumed | Reality |
|---|---|
| `POST /sessions` | **404.** No session resource exists at all |
| `POST /sessions/{id}/turns` | `POST /v1/turns` — the *turn* is the top-level resource |
| SSE `/sessions/{id}/events` | `GET /v1/turns/{id}/events` |
| `DELETE /sessions/{id}` | no such route → `POST /v1/turns/{id}/cancel` |
| `GET /health` | `GET /healthz` |
| no auth | `Authorization: Bearer` on every route except `/healthz` |
| `seq` on every event | no frame carries a sequence number |
| — *absent* — | `POST /v1/turns/{id}/provider-result` ← **required to drive any turn** |
| — *absent* — | `POST /v1/turns/{id}/tool-result` ← **required for any tool** |

The last two are why this was not merely cosmetic: with no way to answer a
reverse request, the old client could not have completed a single turn even
against corrected routes — the engine would have parked on its first model call
and aborted at the deadline.

## Known gaps (verified absent, not oversights)

Named here so the next person does not rediscover them as bugs. All are
documented as unbuilt in stella's `docs/design/serve-surface.md`:

- **No resumption.** No `seq`, no `?after=`, no retained history: a dropped SSE
  connection loses whatever streamed while it was down.
- **One turn per session object.** No multi-turn conversation state server-side;
  the host owns history and replays it on each `POST /v1/turns`.
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

Both workflows were rewritten to build `stella-serve` from source at the pinned
tag, because stella's release tarball contains `stella-cli` only and never had a
serve binary in it. They remain **unverified in practice**: GitHub Actions has
been failing at `startup_failure` org-wide since 2026-07-10, so no workflow in
this repository has run. The real gate is `pnpm gate` / lefthook, which runs
`test:unit` — where the smoke test skips cleanly when no binary is present.
