# @oxagen/stella-engine-client

The host side of Stella's headless engine. `stella-serve` runs the agent loop
and nothing else: it holds no model key and runs no tool. It asks the host
for every completion and every tool call over an event stream, and the host
answers on POST routes: a provider result, a tool result, a requery result,
and optional provider deltas. This package is that conversation.

## Boundary

- **Owns:** the typed wire to `stella-serve`, the HTTP transport, the SSE
  decoder, the loop that drives one turn to its outcome, and the in-process
  fake engine for tests.
- **Does not own:** where the engine lives or how the host authenticates to
  it (`STELLA_SERVE_URL` and `STELLA_SERVE_TOKEN` are read in
  [`@oxagen/agent`](../agent/README.md), `src/runtime/engine/client.ts`);
  answering provider requests through the gateway and tool requests through
  governed tools (`@oxagen/agent`, `src/runtime/engine/provider.ts` and
  `src/runtime/engine/tools.ts`); Stella itself, which is a separate
  repository.
- **Depends on:** No `@oxagen/*` runtime dependencies, and no npm runtime
  dependencies. It uses the platform `fetch`.
- **Used by:** `@oxagen/agent` (`src/runtime/engine/`,
  `src/runtime/governed-turn.ts`, `src/runtime/assistant-run.ts`, and the
  `get_assistant_engine` handler in `src/handlers/assistant.engine.get.ts`).

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `StellaEngineClient` | export | `packages/stella-engine-client/src/client.ts` | `packages/agent/src/runtime/engine/client.ts` |
| `DriveTurnHandlers` (`ProviderRequestHandler`, `ToolRequestHandler`, `RequeryRequestHandler`) | port | `packages/stella-engine-client/src/drive-turn.ts` | `packages/agent/src/runtime/engine/provider.ts`, `tools.ts` |
| `stella-serve` HTTP and SSE routes (table below) | boundary | `packages/stella-engine-client/src/wire.ts`, `src/generated/serveframe.d.ts` | A `stella-serve` process at `STELLA_SERVE_URL` |
| `FakeEngine`, `goldenScript` | export | `packages/stella-engine-client/src/fake-engine.ts` | `packages/agent/src/runtime/governed-turn.test.ts` |

## Entry points

- `.` → `src/index.ts`: the client, `driveTurn`, the SSE decoder,
  `STELLA_SERVE_PINNED_VERSION`, and every wire type.
- `./testing` → `src/fake-engine.ts`: the scripted fake engine and its golden
  turn (`fixtures/golden-turn.json`, `fixtures/golden-turn.sse`).

## Rules

- Keep the package on `fetch` alone, so it stays in step with the server.
- Write the engine's version in `src/version.ts` and nowhere else. Follow
  [Bump the engine version](#bump-the-engine-version).

## Bump the engine version

`STELLA_SERVE_PINNED_VERSION` in `src/version.ts` is the one version of
`stella-serve` in this repository. Three things read it:

- `tools/scripts/package-for-node.sh stella-serve` writes the image
  `ghcr.io/macanderson/stella-serve:<version>` into the engine's deploy
  manifest. It takes no tag from the environment, and it refuses to package
  the engine when it cannot read the pin.
- Every assistant run records it as the engine version on its attempt
  (`ASSISTANT_ENGINE` in `packages/agent/src/runtime/assistant-run.ts`).
- The smoke test refuses a binary older than it.

`docker-compose.dev.yml` cannot read TypeScript, so it writes the same
version as the default of `STELLA_SERVE_IMAGE_TAG`.
`tools/scripts/check-engine-version.mjs` runs in `pnpm check:contracts` and
fails when any tracked image tag differs from the pin.

To move to a new release:

1. Confirm Stella published the image for both architectures. The node is
   arm64.

   ```bash
   docker manifest inspect ghcr.io/macanderson/stella-serve:<version>
   ```

2. Set `STELLA_SERVE_PINNED_VERSION` in `src/version.ts` to the new version.
3. Set the default tag in `docker-compose.dev.yml`,
   `${STELLA_SERVE_IMAGE_TAG:-<version>}`, to the same version.
4. If Stella's `docs/wire` changed since the last bump, copy the new
   `serveframe.d.ts` into `src/generated/` and update the hand-written
   inbound types in `src/wire.ts`. Then hold them to a Stella checkout of the
   new release:

   ```bash
   STELLA_REPO=/path/to/stella pnpm --filter @oxagen/stella-engine-client test:unit src/wire.pin.test.ts
   ```

5. Drive the golden turn through a binary of the new release:

   ```bash
   STELLA_SERVE_BIN=/path/to/stella-serve pnpm --filter @oxagen/stella-engine-client test:smoke
   ```

6. Check every tag from the repository root. The check prints the pin when
   every tag matches it.

   ```bash
   node tools/scripts/check-engine-version.mjs
   ```

The merge to `main` deploys the new image. `deploy-node` runs
`package-for-node.sh`, which reads the version from `src/version.ts`.

## Tests

```bash
pnpm --filter @oxagen/stella-engine-client test:unit src/drive-turn.test.ts
STELLA_SERVE_BIN=/path/to/stella-serve pnpm --filter @oxagen/stella-engine-client test:smoke
```

Never put `--` before the filename. The unit tests live beside the source in
`src/*.test.ts`. `test:unit` excludes `*.smoke.test.ts`, and `test:smoke` runs
`src/stella-serve.smoke.test.ts` alone.

The smoke test boots the binary on a free loopback port and drives the same
scripted turn the fake replays. A binary comes from a Stella checkout with
`cargo build -p stella-serve --bin stella-serve`, or from the published image
`ghcr.io/macanderson/stella-serve:<version>`.

## Layout

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

## Routes

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/healthz`, `/readyz` | none |
| POST | `/v1/sessions`; GET, DELETE `/v1/sessions/{id}`; POST `/v1/sessions/{id}/turns` | bearer |
| POST | `/v1/turns` | bearer |
| GET | `/v1/turns/{id}/events` (SSE, one subscriber, `?after=` resumes) | bearer |
| POST | `/v1/turns/{id}/provider-result`, `/provider-delta`, `/tool-result`, `/requery-result` | bearer |
| POST | `/v1/turns/{id}/cancel`, `/steer`, `/pause`, `/resume` | bearer |
