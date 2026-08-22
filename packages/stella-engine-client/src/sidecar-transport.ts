/**
 * The sidecar transport (oxagen #1072): drives one turn against a running
 * `stella-serve` process over its headless HTTP+SSE surface, acting as the
 * host — which means oxagen supplies the model completion and every tool
 * result, and the Rust engine supplies the orchestration.
 *
 * This is oxagen's ONE sidecar client: the platform's turn runner
 * (`@oxagen/agent-runner`'s stella-runner) drives production turns through the
 * very same `runTurn` the smoke test exercises. That is deliberate — a second
 * "production" pump beside a "contract-proving" one would mean the test proved
 * a parallel implementation, and the two would drift until the smoke test was
 * green about code nobody ran.
 *
 * Keep it dependency-free (fetch only) so it stays easy to hold in lockstep
 * with stella's serve surface.
 *
 * ## Why this file was rewritten (oxagen #1132)
 *
 * The previous revision spoke a session-oriented surface — `POST /sessions`,
 * `POST /sessions/{id}/turns`, `DELETE /sessions/{id}` — that `stella-serve`
 * has never served: every one of those routes is a 404. More importantly it
 * had no way to answer a reverse-RPC request, so even against the correct
 * routes it could not have driven a single turn to completion: the engine
 * would have parked on its first model call and aborted at the deadline.
 *
 * The corrected surface, verified against a locally built stella-serve 0.6.2:
 *
 * | Method | Path                                             |
 * |--------|--------------------------------------------------|
 * | GET    | `/healthz`  (the ONLY unauthenticated route)     |
 * | POST   | `/v1/turns`                                      |
 * | GET    | `/v1/turns/{id}/events`  (SSE, exclusive, one-shot) |
 * | POST   | `/v1/turns/{id}/provider-result`                 |
 * | POST   | `/v1/turns/{id}/tool-result`                     |
 * | POST   | `/v1/turns/{id}/cancel`                          |
 *
 * Every route except `/healthz` requires `Authorization: Bearer <token>`, and
 * the auth gate runs *before* routing — so a wrong path with no token answers
 * 401, not 404. That is worth knowing when debugging: a 401 does not prove
 * your token is wrong.
 */

import type {
  AgentEventEnvelope,
  ProviderError,
  CompletionRequest,
  CompletionResult,
  ServerFrame,
  ToolOutput,
  TurnCreated,
  TurnOutcome,
  TurnRequest,
} from "./wire-types";

export interface SidecarClientOptions {
  /** Base URL of a running `stella-serve` process, e.g. http://127.0.0.1:8137. */
  baseUrl: string;
  /**
   * The bearer token the server was started with (`STELLA_SERVE_TOKEN` or
   * `STELLA_SERVE_TOKEN_FILE`). Required: there is no unauthenticated mode
   * beyond `/healthz`.
   */
  token: string;
  fetchImpl?: typeof fetch;
}

/** One streamed fragment of an in-flight completion. */
export interface ProviderDelta {
  readonly kind: "text" | "reasoning";
  readonly text: string;
}

/** What the engine says about the model call it is asking for. */
export interface ProviderCallContext {
  readonly requestId: string;
  /**
   * The provider asked to serve THIS call — the turn's own, or the override on
   * a goal/sub-agent block. A host that cannot tell them apart cannot route a
   * verifier to a different model family.
   */
  readonly providerId: string;
  /** What the call is for, so a host routes by role rather than by string-matching an id. */
  readonly role: string;
  /**
   * Stream fragments to the engine ahead of the final result.
   *
   * Advisory — the returned `CompletionResult` is authoritative — but load
   * bearing for two reasons: a second subscriber sees text as it arrives, and
   * each batch RE-ARMS the reverse-request deadline. That is what makes the
   * provider deadline an idle bound rather than a total one, so a long
   * completion cannot time out mid-stream.
   */
  pushDelta(deltas: readonly ProviderDelta[]): Promise<void>;
  readonly signal: AbortSignal;
}

export interface ToolCallContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
}

/** The host's model port: answer one `provider_request`. */
export type ProviderHandler = (
  request: CompletionRequest,
  ctx: ProviderCallContext,
) => Promise<CompletionResult>;

/** The host's tool port: answer one `tool_request`. */
export type ToolHandler = (
  name: string,
  input: Record<string, unknown>,
  ctx: ToolCallContext,
) => Promise<ToolOutput>;

export interface DriveTurnHandlers {
  onProviderRequest: ProviderHandler;
  onToolRequest: ToolHandler;
  /** Optional observer for UI events. Never required to respond. */
  onEvent?: (event: AgentEventEnvelope) => void;
}

export interface TurnRunResult {
  readonly turnId: string;
  readonly outcome: TurnOutcome;
  readonly events: readonly AgentEventEnvelope[];
  readonly providerCalls: number;
  readonly toolCalls: number;
}

/** Thrown for any non-2xx response, preserving the status for the caller. */
export class SidecarHttpError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${operation} failed: ${status} ${body}`);
    this.name = "SidecarHttpError";
  }
}

export class StellaSidecarClient {
  /** Normalized base URL, exposed so callers can probe routes off the client. */
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SidecarClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };
  }

  /** `GET /healthz` — unauthenticated. True once the server answers 200. */
  async health(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/healthz`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * `POST /v1/turns` — registers and immediately starts a turn.
   *
   * Returns as soon as the turn's OS thread is spawned, before any model call.
   * Frames buffer on an unbounded channel until the stream is opened, so there
   * is no race between creating a turn and subscribing to it.
   */
  async createTurn(request: TurnRequest): Promise<{ turnId: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/turns`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      throw new SidecarHttpError("createTurn", res.status, await res.text());
    }
    const body = (await res.json()) as TurnCreated;
    if (!body.turn_id) {
      throw new Error(
        `createTurn response missing turn_id: ${JSON.stringify(body)}`,
      );
    }
    return { turnId: body.turn_id };
  }

  /**
   * `GET /v1/turns/{id}/events` — the frame stream.
   *
   * Exclusive and one-shot: the server hands the session to this connection,
   * so a second subscriber gets 409. When the stream ends the turn leaves the
   * registry, and any later result POST for that id answers 404.
   */
  async openFrameStream(turnId: string): Promise<AsyncIterable<ServerFrame>> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/turns/${turnId}/events`,
      { headers: { ...this.headers(), accept: "text/event-stream" } },
    );
    if (!res.ok) {
      throw new SidecarHttpError(
        "openFrameStream",
        res.status,
        await res.text(),
      );
    }
    if (!res.body) {
      throw new Error("openFrameStream: response carried no body to stream");
    }
    return parseSseFrames(res.body);
  }

  /** `POST /v1/turns/{id}/provider-result` — answer a model call. */
  async resolveProvider(
    turnId: string,
    requestId: string,
    result: CompletionResult,
  ): Promise<void> {
    await this.post(turnId, "provider-result", {
      request_id: requestId,
      status: "ok",
      result,
    });
  }

  /**
   * `POST /v1/turns/{id}/provider-delta` — stream fragments for an in-flight
   * model call, ahead of its terminating provider-result.
   *
   * An EMPTY batch is refused at the route (400), so it is dropped here rather
   * than sent: a caller flushing on its own cadence should not have to guard.
   */
  async pushProviderDelta(
    turnId: string,
    requestId: string,
    deltas: readonly ProviderDelta[],
  ): Promise<void> {
    if (deltas.length === 0) return;
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/turns/${turnId}/provider-delta`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ request_id: requestId, deltas }),
      },
    );
    // A delta is advisory: the authoritative answer is the provider-result
    // that follows. Losing one must never fail the turn — a 409 here just
    // means the result already landed.
    if (!res.ok && res.status !== 409) {
      throw new SidecarHttpError(
        "provider-delta",
        res.status,
        await res.text(),
      );
    }
  }

  /**
   * `POST /v1/turns/{id}/provider-result` with a classified failure.
   *
   * Best-effort by design: if answering the failure itself fails there is
   * nothing further to try, and throwing here would replace the real error
   * with a less useful one.
   */
  private async failProvider(
    turnId: string,
    requestId: string,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    // `terminal` rather than `transport`: the host already applies its own
    // retry policy around the model call, so a failure that reaches here has
    // been given up on. Declaring it retryable would buy a second attempt the
    // host has already decided against.
    const error: ProviderError = { kind: "terminal", message };
    try {
      await this.post(turnId, "provider-result", {
        request_id: requestId,
        status: "error",
        error,
      });
    } catch {
      // swallowed: see the doc comment
    }
  }

  /** `POST /v1/turns/{id}/tool-result` — answer a tool call. */
  async resolveTool(
    turnId: string,
    requestId: string,
    output: ToolOutput,
  ): Promise<void> {
    await this.post(turnId, "tool-result", {
      request_id: requestId,
      output,
    });
  }

  /**
   * `POST /v1/turns/{id}/cancel` — end an in-flight turn.
   *
   * This is the only teardown route; there is no `DELETE`. Answers once the
   * turn is *signalled*, not once it has unwound, and a host still streaming
   * `/events` receives a terminal frame with an `aborted` outcome. A second
   * cancel is a 404, which we tolerate so cancellation is idempotent.
   */
  async cancelTurn(turnId: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/turns/${turnId}/cancel`,
      { method: "POST", headers: this.headers() },
    );
    if (!res.ok && res.status !== 404) {
      throw new SidecarHttpError("cancelTurn", res.status, await res.text());
    }
  }

  private async post(
    turnId: string,
    route: "provider-result" | "tool-result",
    body: unknown,
  ): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/turns/${turnId}/${route}`,
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
    );
    if (!res.ok) {
      throw new SidecarHttpError(route, res.status, await res.text());
    }
  }

  /**
   * Run one turn to its terminal outcome, acting as the host for every reverse
   * request the engine raises.
   *
   * Reverse requests are dispatched **without awaiting each other**, because
   * the engine may have several read-only tool calls outstanding at once and
   * serializing them here would stall the group. Handler failures are
   * collected and rethrown after the stream ends, so a handler bug surfaces as
   * itself rather than as a wedged turn.
   */
  async runTurn(
    request: TurnRequest,
    handlers: DriveTurnHandlers,
    opts: { signal?: AbortSignal } = {},
  ): Promise<TurnRunResult> {
    const { turnId } = await this.createTurn(request);

    // An abort unwinds the engine at its next STEP boundary — never mid-tool —
    // and the turn still emits a terminal frame, so the loop below exits
    // normally rather than being torn out from under its in-flight handlers.
    // Held so the cancel is awaited before this method returns: fire-and-forget
    // would let a caller that exits right after aborting leave the turn running
    // server-side, still spending.
    let cancelling: Promise<void> | undefined;
    // Handlers get this rather than the caller's signal directly, so an
    // in-flight model call or tool sees the abort even when the turn was
    // stopped by something other than the caller.
    const abort = new AbortController();
    const onAbort = () => {
      abort.abort();
      cancelling = this.cancelTurn(turnId).catch(() => undefined);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    const frames = await this.openFrameStream(turnId);

    const events: AgentEventEnvelope[] = [];
    const inFlight: Promise<void>[] = [];
    const failures: unknown[] = [];
    let providerCalls = 0;
    let toolCalls = 0;
    let outcome: TurnOutcome | undefined;

    const track = (work: Promise<void>): void => {
      inFlight.push(
        work.catch((err: unknown) => {
          failures.push(err);
        }),
      );
    };

    for await (const frame of frames) {
      switch (frame.type) {
        case "event":
          events.push(frame.event);
          handlers.onEvent?.(frame.event);
          break;
        case "provider_request": {
          providerCalls += 1;
          const { request_id, request: completion } = frame;
          const ctx: ProviderCallContext = {
            requestId: request_id,
            providerId: frame.provider_id,
            role: frame.role,
            pushDelta: (deltas) =>
              this.pushProviderDelta(turnId, request_id, deltas),
            signal: abort.signal,
          };
          track(
            handlers
              .onProviderRequest(completion, ctx)
              .then((result) =>
                this.resolveProvider(turnId, request_id, result),
              )
              // A rejecting handler must still ANSWER. Recording the failure
              // and staying silent leaves the engine parked on a request it
              // only gives up on at the reverse-request deadline — minutes of
              // apparent hang for what is usually an instant, nameable error.
              // Answering lets the engine classify and recover; the rethrow
              // still surfaces the failure to the caller.
              .catch(async (err: unknown) => {
                await this.failProvider(turnId, request_id, err);
                throw err;
              }),
          );
          break;
        }
        case "tool_request": {
          toolCalls += 1;
          const { request_id, name, input } = frame;
          const ctx: ToolCallContext = {
            requestId: request_id,
            signal: abort.signal,
          };
          track(
            handlers
              .onToolRequest(name, input, ctx)
              .then((output) => this.resolveTool(turnId, request_id, output))
              // Same contract on the tool side: the model sees the error text
              // and can adapt, instead of the turn stalling to its deadline.
              .catch(async (err: unknown) => {
                await this.resolveTool(turnId, request_id, {
                  error: {
                    message: err instanceof Error ? err.message : String(err),
                  },
                });
                throw err;
              }),
          );
          break;
        }
        case "turn_complete":
          outcome = frame.outcome;
          break;
      }
      if (outcome) break;
    }

    await Promise.all(inFlight);
    await cancelling;
    opts.signal?.removeEventListener("abort", onAbort);
    if (failures.length > 0) {
      throw failures[0];
    }
    if (!outcome) {
      throw new Error(
        `turn ${turnId} stream ended without a turn_complete frame ` +
          `(${events.length} events seen) — the connection dropped mid-turn`,
      );
    }
    return { turnId, outcome, events, providerCalls, toolCalls };
  }
}

/**
 * Parses an SSE byte stream of `data: <json>\n\n` frames into {@link ServerFrame}s.
 *
 * Splits on the SSE record separator (a blank line) rather than on every
 * newline, and concatenates multi-line `data:` fields per the SSE spec — the
 * previous revision parsed each `data:` line as standalone JSON, which would
 * throw a bare `SyntaxError` on any payload the server chose to wrap. stella
 * emits single-line frames today, so this is robustness against a future
 * change rather than a live bug.
 *
 * The stream carries no `event:`, `id:` or `retry:` fields and no heartbeat
 * comments; discrimination is entirely by the JSON `type` key.
 */
async function* parseSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<ServerFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = findRecordBoundary(buffer);
        if (!boundary) break;
        const record = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const frame = recordToFrame(record);
        if (frame) yield frame;
      }
    }
    // A final record with no trailing blank line still counts.
    const tail = recordToFrame(buffer);
    if (tail) yield tail;
  } finally {
    // Cancel, not merely release: releasing the lock alone leaves the response
    // body un-cancelled, so the socket to the child process stays open and a
    // consumer that breaks early leaks it.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function findRecordBoundary(
  buffer: string,
): { index: number; length: number } | undefined {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { index: crlf, length: 4 };
  }
  return { index: lf, length: 2 };
}

function recordToFrame(record: string): ServerFrame | undefined {
  const data = record
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (data.length === 0) return undefined;
  return JSON.parse(data) as ServerFrame;
}
