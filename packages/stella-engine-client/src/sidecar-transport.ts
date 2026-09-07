/**
 * Drives one turn against a running `stella-serve` process over its headless
 * HTTP+SSE surface, acting as the host — oxagen supplies the model completion
 * and every tool result, and the Rust engine supplies the orchestration.
 *
 * This is the smallest possible client: it exists so the smoke test can prove
 * the wire contract, not to be oxagen's production sidecar integration (that
 * lives in the platform's agent-runner once ADR-033 Track 2 lands — see
 * docs/adr/ADR-033-stella-engine-core.md and docs/specs/agent-engine-v2/).
 * Keep it dependency-free (fetch only) so it stays easy to keep in lockstep
 * with stella's serve surface.
 *
 * The routes:
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
  CompletionRequest,
  CompletionResult,
  ProviderError,
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
  /**
   * Override the `fetch` used for every request. Only the tests set this; in
   * production leave it unset so the runtime's own `fetch` is used.
   */
  fetchImpl?: typeof fetch;
}

/** The host's model port: answer one `provider_request`. */
export type ProviderHandler = (
  request: CompletionRequest,
) => Promise<CompletionResult>;

/** The host's tool port: answer one `tool_request`. */
export type ToolHandler = (
  name: string,
  input: Record<string, unknown>,
) => Promise<ToolOutput>;

/**
 * What {@link StellaSidecarClient.runTurn} does when a reverse-request handler
 * rejects.
 *
 * - `"throw"` (default) — collect the rejection, cancel the turn so the engine
 *   stops waiting for an answer that is not coming, and rethrow once the stream
 *   ends. Right for a test or a script driving a scripted turn, where a handler
 *   rejection is a bug in the harness and should surface as itself.
 * - `"report"` — tell the engine. A provider rejection is classified into a
 *   {@link ProviderError} and POSTed as the error arm; a tool rejection is
 *   POSTed as the `error` arm of {@link ToolOutput}. Right for a production
 *   host, because both failures are ones the engine is built to handle: a
 *   `transport`/`rate_limited` provider error is retried with backoff, and a
 *   failed tool is surfaced to the model as text it can react to. Under
 *   `"throw"` the engine learns nothing it can act on, so the turn dies instead
 *   of retrying — promptly, now that the cancel spares both sides the
 *   `reverse_request_timeout_ms` wait, but a retryable blip is still a dead
 *   turn.
 */
export type ReverseRequestFailureMode = "throw" | "report";

export interface DriveTurnHandlers {
  onProviderRequest: ProviderHandler;
  onToolRequest: ToolHandler;
  /** Optional observer for UI events. Never required to respond. */
  onEvent?: (event: AgentEventEnvelope) => void;
  /** See {@link ReverseRequestFailureMode}. Defaults to `"throw"`. */
  onFailure?: ReverseRequestFailureMode;
  /**
   * Classifies a rejected {@link ProviderHandler} into the taxonomy the engine
   * retries on. Consulted only under `onFailure: "report"`; defaults to
   * {@link classifyProviderFailure}.
   *
   * The host owns this decision because only the host's own model adapter knows
   * whether a failure was a 429, a bad key, or a socket reset — and the engine's
   * behaviour forks on exactly that.
   */
  classifyProviderError?: (error: unknown) => ProviderError;
}

/**
 * Default classification for a model-call failure with no host-supplied
 * classifier: `transport`, which the engine retries with backoff.
 *
 * Retryable is the safe default in only one direction. Misclassifying a
 * terminal failure as `transport` costs a bounded number of retries that each
 * fail the same way; misclassifying a blip as `terminal` kills a turn the
 * engine could have completed. A host that can tell the difference should say
 * so via {@link DriveTurnHandlers.classifyProviderError} rather than rely on
 * this.
 */
export function classifyProviderFailure(error: unknown): ProviderError {
  const message = error instanceof Error ? error.message : String(error);
  if (isAbortLike(error)) return { kind: "cancelled" };
  return { kind: "transport", message };
}

function isAbortLike(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

export interface TurnRunResult {
  readonly turnId: string;
  /** The terminal frame's outcome: `completed` or `aborted`. */
  readonly outcome: TurnOutcome;
  /** Every `AgentEvent` seen on the stream, in arrival order. */
  readonly events: readonly AgentEventEnvelope[];
  /** How many `provider_request` frames arrived — requests, not completions. */
  readonly providerCalls: number;
  /** How many `tool_request` frames arrived — requests, not completions. */
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

/**
 * True for the answer a result POST gets when the turn it belongs to has
 * already ended.
 *
 * Reverse requests are dispatched without being awaited, so a handler can still
 * be running when the engine emits its terminal frame. When the stream ends the
 * turn leaves the registry, and the late POST answers 404 — or 409 for a
 * request id the turn no longer recognises. Neither says anything went wrong:
 * the handler finished after the turn ended, which is ordinary for a
 * cancellation and for any engine-side abort with a tool in flight.
 *
 * Narrow on purpose. Only these two statuses, only on the two result routes,
 * and — at the one call site — only once a terminal outcome is in hand. A 404
 * before the turn ends is a wrong turn id and stays an error (#1349).
 */
function isLateResultPost(err: unknown): boolean {
  return (
    err instanceof SidecarHttpError &&
    (err.status === 404 || err.status === 409) &&
    (err.operation === "provider-result" || err.operation === "tool-result")
  );
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
   * `POST /v1/turns/{id}/provider-result` — fail a model call.
   *
   * The error arm of the same route {@link resolveProvider} uses. `kind` is
   * load-bearing rather than cosmetic: the engine reconstructs a real
   * `ProviderError` from it, so `transport` and `rate_limited` re-enter its
   * retry-with-backoff path while `auth`, `unknown_model`, `malformed`,
   * `cancelled` and `terminal` fail the turn at once.
   */
  async rejectProvider(
    turnId: string,
    requestId: string,
    error: ProviderError,
  ): Promise<void> {
    await this.post(turnId, "provider-result", {
      request_id: requestId,
      status: "error",
      error,
    });
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
   * serializing them here would stall the group.
   *
   * A rejecting handler is governed by {@link ReverseRequestFailureMode}: by
   * default the rejection is collected and rethrown once the stream ends, so a
   * handler bug surfaces as itself rather than as a wedged turn; under
   * `onFailure: "report"` it is POSTed back to the engine instead, which is
   * what a production host wants.
   *
   * Either arm cancels the turn as soon as the client runs out of ways to
   * answer — a rejecting handler under `throw`, a failed report under
   * `report`. Without that the engine stays parked on a reverse request whose
   * answer is never coming, and both sides wait out
   * `reverse_request_timeout_ms` — the client because the rethrow cannot
   * happen until the stream ends, and the stream cannot end until the engine
   * unwinds (#1279).
   *
   * One limit of the default arm: only the first collected failure is
   * rethrown. With several tool calls outstanding, the later errors are
   * dropped.
   *
   * Either arm can be racing the engine. A handler that finishes after the
   * terminal frame POSTs into a turn that has left the registry and gets a 404
   * or 409 back; that is discarded rather than thrown, so a turn cancelled with
   * a tool in flight resolves with its `aborted` outcome instead of surfacing
   * an HTTP error for a turn that ended exactly as asked (#1349).
   */
  async runTurn(
    request: TurnRequest,
    handlers: DriveTurnHandlers,
  ): Promise<TurnRunResult> {
    const { turnId } = await this.createTurn(request);
    const frames = await this.openFrameStream(turnId);
    const reportFailures = (handlers.onFailure ?? "throw") === "report";

    const events: AgentEventEnvelope[] = [];
    const inFlight: Promise<void>[] = [];
    const failures: unknown[] = [];
    let providerCalls = 0;
    let toolCalls = 0;
    let outcome: TurnOutcome | undefined;

    // When the client gives up on the turn the engine does not know that: it
    // is parked on a reverse request whose answer is never coming, and only
    // `reverse_request_timeout_ms` ends it. The
    // client cannot even report the rejection until the stream ends, which is
    // the same deadline — so a handler bug cost the full timeout on both sides.
    // Signalling cancel unwinds the turn, which ends the stream, which is what
    // lets the rethrow happen at request latency instead (#1279).
    //
    // Fire-and-forget and at most once: `cancelTurn` already tolerates a 404,
    // so racing a turn that ended on its own is harmless, and a cancel that
    // fails must not replace the handler error the caller actually needs to
    // see.
    let cancelSignalled = false;
    const giveUpOnTurn = (): void => {
      if (cancelSignalled) return;
      cancelSignalled = true;
      void this.cancelTurn(turnId).catch(() => {});
    };

    // Both arms give up, because reaching here means both arms have run out of
    // ways to answer. Under `throw` that is the handler rejecting. Under
    // `report` the handler's rejection was already caught and POSTed, so the
    // only thing left to fail is the report itself — and a host that can
    // neither answer nor report has lost the turn exactly as surely. Leaving
    // the report arm parked was the whole defect this cancel exists to remove,
    // one step along.
    //
    // A late result POST that 404s or 409s also lands here, and cancelling on
    // it is harmless: the turn has already terminated, so the cancel answers
    // 404 and `cancelTurn` tolerates that.
    const track = (work: Promise<void>): void => {
      inFlight.push(
        work.catch((err: unknown) => {
          failures.push(err);
          giveUpOnTurn();
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
          track(
            handlers
              .onProviderRequest(completion)
              .then((result) =>
                this.resolveProvider(turnId, request_id, result),
              )
              .catch((err: unknown) => {
                if (!reportFailures) throw err;
                // Reporting is itself a POST that can fail; let THAT rejection
                // propagate, because a host that can neither answer nor report
                // has lost the turn and must say so.
                const classify =
                  handlers.classifyProviderError ?? classifyProviderFailure;
                return this.rejectProvider(turnId, request_id, classify(err));
              }),
          );
          break;
        }
        case "tool_request": {
          toolCalls += 1;
          const { request_id, name, input } = frame;
          track(
            handlers
              .onToolRequest(name, input)
              .catch((err: unknown): ToolOutput => {
                if (!reportFailures) throw err;
                // A failed tool is ordinary: the engine hands the message to
                // the model as text it can react to, exactly as it would a
                // tool that returned an error of its own accord.
                const message =
                  err instanceof Error ? err.message : String(err);
                return { error: { message } };
              })
              .then((output) => this.resolveTool(turnId, request_id, output)),
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
    // A result POST that lands after the turn terminated is the expected
    // answer, not a failure — the same tolerance `cancelTurn` already applies
    // to its own 404. Filtered only when an outcome is in hand, so a 404 from a
    // wrong turn id still surfaces, and only for that shape, so a handler that
    // genuinely broke is rethrown exactly as before (#1349).
    const realFailures = outcome
      ? failures.filter((err) => !isLateResultPost(err))
      : failures;
    if (realFailures.length > 0) {
      throw realFailures[0];
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
 * newline, and concatenates multi-line `data:` fields per the SSE spec, so a
 * payload the server wraps across lines still parses as one JSON value.
 * stella emits single-line frames today, but the SSE spec allows wrapping, so
 * this guards against a future change rather than a live bug.
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
  try {
    return JSON.parse(data) as ServerFrame;
  } catch (cause) {
    // A bare SyntaxError here reaches the caller with no hint that it came off
    // the frame stream, which is the hardest kind of failure to diagnose.
    const preview = data.length > 200 ? `${data.slice(0, 200)}…` : data;
    throw new Error(
      `frame stream carried a record that is not valid JSON: ${preview}`,
      { cause },
    );
  }
}
