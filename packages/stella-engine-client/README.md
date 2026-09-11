# @oxagen/stella-engine-client

The host side of Stella's headless engine. `stella-serve` runs the agent loop
and nothing else: it holds no model key and runs no tool. It asks the host
for every completion and every tool call over an event stream, and the host
answers on three POST routes. This package is that conversation.

- `src/wire.ts` — the types. What the server sends is copied from Stella's
  generated declarations (`src/generated/serveframe.d.ts`); what the server
  accepts is written by hand against `serveinbound.schema.json`, and
  `wire.pin.test.ts` holds the two together when a Stella checkout is on
  disk.
- `src/client.ts` — one method per route, over `fetch` and nothing else.
- `src/drive-turn.ts` — one turn to its outcome: start, subscribe, answer
  reverse requests concurrently, resume a dropped stream with `?after=`,
  cancel on abort.
- `src/fake-engine.ts` — an in-process fake for tests, scripted with the
  frames a real turn produced.

`src/version.ts` names the release the types were copied from and the smoke
test drove. Bump it in the same change that refreshes the generated file.

## Routes

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/healthz`, `/readyz` | none |
| POST | `/v1/sessions`; GET, DELETE `/v1/sessions/{id}`; POST `/v1/sessions/{id}/turns` | bearer |
| POST | `/v1/turns` | bearer |
| GET | `/v1/turns/{id}/events` (SSE, one subscriber, `?after=` resumes) | bearer |
| POST | `/v1/turns/{id}/provider-result`, `/provider-delta`, `/tool-result`, `/requery-result` | bearer |
| POST | `/v1/turns/{id}/cancel`, `/steer`, `/pause`, `/resume` | bearer |

## Tests

```sh
pnpm --filter @oxagen/stella-engine-client test:unit
STELLA_SERVE_BIN=/path/to/stella-serve pnpm --filter @oxagen/stella-engine-client test:smoke
```

The smoke test boots the binary on a free loopback port and drives the same
scripted turn the fake replays. A binary comes from a Stella checkout with
`cargo build -p stella-serve --bin stella-serve`, or from the published image
`ghcr.io/macanderson/stella-serve:<version>`.
