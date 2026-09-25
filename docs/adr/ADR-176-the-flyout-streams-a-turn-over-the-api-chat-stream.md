# ADR-176: The flyout streams a turn over the API's chat stream

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** app, agent, api
- **Related:** ADR-053 (the in-app agent on `stella-serve`), ADR-089 (an
  on-demand read goes through `kernelRead` in a `"use server"` module),
  ADR-092 (an abandoned assistant turn is owned to completion, which this
  extends from navigation to the connection), #4160 (the item this settles),
  #2953 (run controls: stopping a turn on purpose)

## Context

The assistant flyout asked a question through a Server Action, `askAssistant`,
which made one `kernelWrite` of `ask_assistant` and returned the finished reply.
The flyout then faked a stream: `assistant-streaming-text.tsx` revealed the
finished reply at 90 characters a second. A turn can take 12 steps and 6
minutes, so the person watched a spinner for minutes and then a typing effect
over text that already existed.

Three facts shaped the decision.

- **The streaming adapter already exists.** The engine streams deltas to the
  host (`docs/specs/in-app-agent-on-stella-serve/spec.md` §6), and
  `ask_assistant` has `POST /v1/:org/:ws/chat/stream` as its streaming adapter.
  The contract, the handler and the route each name that route as the app's
  transport, and the handler records any streamed turn on the `chat` surface,
  the app's.
- **A Server Action cannot carry a turn.** Next.js dispatches Server Actions
  one at a time per client
  (`next/dist/docs/01-app/02-guides/server-actions.md`). A turn held every other
  action in the app, an approval or a notification, behind it for as long as
  six minutes.
- **The route cancelled a turn when its client went away.** It handed the
  request's abort signal to the turn. A dropped connection cancelled the engine
  turn, sealed the run as cancelled, and saved no reply. ADR-092 decided that a
  turn the person walks away from is owned to completion, and a network blip is
  less of a decision to stop than a click elsewhere.

## Decision

**The flyout streams a turn from the API's `POST /v1/:org/:ws/chat/stream`.**
The browser reaches it same-origin through the app's `/api/v1/*` rewrite
(`next.config.ts`), so the session cookie travels, the way the Run page follows
a run (`features/run/use-run-stream.ts`). The client is
`apps/app/src/features/shell/assistant-stream-client.ts`, a `fetch` that reads
the route's SSE body. The app adds no SSE route of its own and no second
translator.

The turn still has one write path into the kernel. The route invokes
`ask_assistant` through `kernel.invoke()` with the hooks beside it, so the turn
passes the same IAM, audit, rules and billing gates and the handler's role and
credit gates, is recorded as the same `chat` run, and refuses with the same
codes. The client answers every outcome in the shape `kernelWrite` answered it
(`ActionResult`), classified by the same codes, so the flyout's refusal
sentences are unchanged. The stream carries text deltas, tool-call starts and
ends, parked writes, and the final output.

**A dropped connection does not stop the turn.** The route no longer hands the
request's abort signal to the turn. The turn runs to completion and persists its
reply. Stopping a turn on purpose is an explicit cancel, never a socket
closing. For an assistant turn that cancel is `cancel_assistant_turn` (#4164):
the flyout mints a `turnId`, sends it in the stream request, and Stop posts it
to the app's `assistant/stop` route. The handler registers the turn under that
id with an abort controller of its own, so the stop reaches the engine although
the turn carries no signal from the request. Run controls for every run stay
with #2953.

**The route writes a keep-alive comment every 15 seconds.** The rewrite proxy
closes a socket that is idle for 30 seconds, and a load balancer does the same
at its own timeout. A turn can go longer than that without a part while a tool
runs.

**A dropped stream keeps what arrived and offers the finished reply.** The
stream names the run before the engine is asked anything. A new read,
`get_assistant_reply`, answers the reply persisted for an `arun_…` run in the
caller's own conversations, with the conversation it continues, or the run's
ledger status while none is recorded. The flyout reads it through `kernelRead`
in `features/shell/assistant-actions.ts`, a `"use server"` module (ADR-089), when
the person asks to load the finished reply.

**The fake reveal is gone.** Text is painted as it arrives. The growing copy is
`aria-hidden` and `inert`, and the finished reply replaces it as a new entry, so
the transcript's live region announces the reply once, whole.

## Why not the alternatives

**A route handler in `apps/app` over a streaming kernel seam.** It would keep
the app's viewer seam and the `app` surface on the kernel's audit row, but it
is a second SSE producer for one contract. It would need its own translator of
the engine's parts, a `kernelWrite` variant that imports `@oxagen/agent`, and a
wider §2 allowlist. Two producers of one stream drift, and the route that
exists is already the one the contract, the handler and the Run page's
precedent point to.

**A Server Action that returns a stream.** It stays behind the one-at-a-time
dispatch, which is the defect this replaces.

**Polling the run for its reply.** It adds a timer and a read per interval for
every open turn, and paints nothing until a step lands.

**Resuming the stream after a drop.** It needs a server-side buffer of each
turn's events keyed for reconnection. A drop is rare, the reply is persisted
either way, and one read of the finished reply loses nothing the record holds.

## Consequences

- The flyout's reply appears as the engine writes it, and each tool call is
  named while it runs.
- Other Server Actions no longer wait behind a turn.
- A turn whose connection drops runs to completion and saves its reply, for
  every caller of the route, the app and an API client alike. Its spend is
  spent. Before this decision, a drop cancelled the turn and discarded the
  answer the person had asked for.
- The kernel's audit row for a streamed turn names the `api` surface, because
  the request arrives through the API. The run is recorded on `chat`, as it
  was.
- The request passes the API's session, organization and workspace middleware,
  not the app's viewer seam. The organization's two-factor and SSO
  requirements that the viewer seam enforces on a page are not re-checked on
  this request. The same holds for every `/api/v1` route today, the Run page's
  stream included.
- The chat rate limiter (`/chat/*`) now counts the flyout's turns.
- A refusal after the stream opened replaces what arrived, because nothing of a
  failed turn is saved as a reply.
- Parallel work on the flyout mocks `./assistant-stream-client` in place of
  `./assistant-actions`. `askAssistantStream` takes the three arguments
  `askAssistant` took and answers the same result shape.

## Verification

- `apps/api/src/routes/v1/chat.stream.test.ts`: the turn is handed no abort
  signal and ends on its own clock after the client drops, the keep-alive is
  written while the turn is quiet and stops at the terminal, and a reader never
  sees it as an event.
- `apps/app/src/features/shell/assistant-stream-client.test.ts`: the request,
  the parse of the wire across split chunks and keep-alives, the refusal
  classification before and after the stream opens, and a dropped stream.
- `apps/app/src/features/shell/assistant-flyout.streaming.test.tsx`: a streamed
  reply, a refusal mid-stream, a dropped stream and its load, and axe in the
  streaming and dropped states.
- `packages/agent/src/handlers/assistant.reply.get.test.ts` and
  `apps/app/src/features/shell/assistant-actions.test.ts`: the read and the
  action that loads the finished reply.
