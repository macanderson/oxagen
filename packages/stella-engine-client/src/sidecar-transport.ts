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
  ServerFrame,
  ToolOutput,
  TurnCreated,
  TurnOutcome,
  TurnRequest,
} from "./wire-types.js";

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

/** The host's model port: answer one `provider_request`. */
export type ProviderHandler = (
  request: CompletionRequest,
) => Promise<CompletionResult>;

/** The host's tool port: answer one `tool_request`. */
export type ToolHandler = (
  name: string,
  input: Record<string, unknown>,
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
  ): Promise<TurnRunResult> {
    const { turnId } = await this.createTurn(request);
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
          track(
            handlers
              .onProviderRequest(completion)
              .then((result) =>
                this.resolveProvider(turnId, request_id, result),
              ),
          );
          break;
        }
        case "tool_request": {
          toolCalls += 1;
          const { request_id, name, input } = frame;
          track(
            handlers
              .onToolRequest(name, input)
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
  return JSON.parse(data) as ServerFrame;
}
