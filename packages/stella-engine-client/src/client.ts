/**
 * One method per `stella-serve` route, over `fetch` and nothing else.
 *
 * The engine holds no model key and runs no tool. It asks the host for each
 * completion and each tool call as a frame on `GET /v1/turns/{id}/events`,
 * and the host answers on the `provider-result` / `tool-result` routes. This
 * class is the transport for that exchange; `driveTurn` in `./drive-turn.ts`
 * is the loop that uses it.
 *
 * | Method | Path | Auth |
 * | --- | --- | --- |
 * | GET | `/healthz` | none |
 * | GET | `/readyz` | none |
 * | POST | `/v1/sessions` | bearer |
 * | GET, DELETE | `/v1/sessions/{id}` | bearer |
 * | POST | `/v1/sessions/{id}/turns` | bearer |
 * | POST | `/v1/turns` | bearer |
 * | GET | `/v1/turns/{id}/events` | bearer, one subscriber |
 * | POST | `/v1/turns/{id}/provider-result` | bearer |
 * | POST | `/v1/turns/{id}/provider-delta` | bearer |
 * | POST | `/v1/turns/{id}/tool-result` | bearer |
 * | POST | `/v1/turns/{id}/requery-result` | bearer |
 * | POST | `/v1/turns/{id}/cancel` | bearer |
 * | POST | `/v1/turns/{id}/steer` | bearer |
 * | POST | `/v1/turns/{id}/pause` | bearer |
 * | POST | `/v1/turns/{id}/resume` | bearer |
 *
 * Every response carries `Connection: close`, so no request here assumes a
 * kept-alive socket, and every body is sent as a string so `fetch` writes a
 * `Content-Length` — the server refuses a chunked request body with a 501.
 *
 * The bearer token is held in a private field and appears in no error, no
 * message, and no log line this file writes.
 */

import { decodeSseStream, recordToFrame } from "./sse";
import type {
  CompletionResult,
  CreateSessionRequest,
  ErrorBody,
  HealthView,
  ProviderDelta,
  ProviderDeltaIn,
  ProviderErrorWire,
  ProviderResultIn,
  ReadinessView,
  RequeryResultIn,
  SessionCreated,
  SessionDeleted,
  SessionTurnCreated,
  SessionTurnRequest,
  SessionView,
  StellaSseFrame,
  ToolOutput,
  ToolResultIn,
  TurnCreated,
  TurnRequest,
} from "./wire";

export interface StellaEngineClientOptions {
  /** Where the server listens, e.g. `http://127.0.0.1:8080`. */
  baseUrl: string;
  /** The bearer token the server was started with. */
  token: string;
  /**
   * The `fetch` to use. Tests pass a fake; production leaves it unset so the
   * runtime's own `fetch` is used.
   */
  fetchImpl?: typeof fetch;
}

/**
 * A non-2xx answer from the server, with enough on it for a caller to branch:
 * the route that was being called, the status, the raw body, the `error`
 * string the server put in that body when it was JSON, and the `Retry-After`
 * the server sent with a 429 or a draining 503.
 */
export class EngineHttpError extends Error {
  override readonly name = "EngineHttpError";
  /** The server's `{"error": ...}` message, when the body carried one. */
  readonly errorMessage: string | undefined;
  /** `Retry-After`, in milliseconds, when the response carried the header. */
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly operation: string,
    readonly status: number,
    readonly body: string,
    retryAfter?: string | null,
  ) {
    const message = parseErrorBody(body);
    super(`${operation}: ${status} ${message ?? body}`.trimEnd());
    this.errorMessage = message;
    this.retryAfterMs = parseRetryAfter(retryAfter);
  }
}

/**
 * Whether `err` is the server declining an answer for a request it no longer
 * waits on: a 409 for a `request_id` that is not outstanding, or a 404 for a
 * turn that has already left the registry. Both are the ordinary outcome of
 * answering a request after the turn was cancelled or completed, and a host
 * that cancelled treats them as success.
 */
export function isStaleRequest(err: unknown): boolean {
  return (
    err instanceof EngineHttpError && (err.status === 409 || err.status === 404)
  );
}

/** Whether `err` is a `fetch` abort, from either the caller's signal or a timeout. */
export function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

export interface OpenFramesOptions {
  /**
   * Resume after this seq. Omit for a fresh subscription; `0` replays the
   * whole retained ring, which is what a process that lost its in-flight
   * request ids must ask for.
   */
  after?: number;
  signal?: AbortSignal;
}

export class StellaEngineClient {
  /** The normalised base URL, with no trailing slash. */
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: StellaEngineClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** `GET /healthz`. Unauthenticated; throws unless the server answers 200. */
  async health(): Promise<HealthView> {
    const res = await this.fetchImpl(`${this.baseUrl}/healthz`);
    return this.decode<HealthView>("health", res);
  }

  /**
   * `GET /readyz`. Unauthenticated. A 503 is not an error here: it is the
   * server saying `starting` or `draining`, and a readiness gate wants that
   * word rather than an exception.
   */
  async ready(): Promise<ReadinessView> {
    const res = await this.fetchImpl(`${this.baseUrl}/readyz`);
    if (res.status === 200 || res.status === 503) {
      const body = (await res.json()) as { state?: unknown };
      const state = typeof body.state === "string" ? body.state : "unknown";
      return { state, ready: res.status === 200 };
    }
    throw await this.fail("ready", res);
  }

  /** `POST /v1/sessions`. A 429 with `Retry-After` means the session cap is full. */
  async createSession(request: CreateSessionRequest): Promise<SessionCreated> {
    const res = await this.request("POST", "/v1/sessions", request);
    return this.decode<SessionCreated>("createSession", res);
  }

  /** `GET /v1/sessions/{id}`. 404 once the session is reclaimed or deleted. */
  async getSession(sessionId: string): Promise<SessionView> {
    const res = await this.request("GET", `/v1/sessions/${enc(sessionId)}`);
    return this.decode<SessionView>("getSession", res);
  }

  /** `DELETE /v1/sessions/{id}`. */
  async deleteSession(sessionId: string): Promise<SessionDeleted> {
    const res = await this.request("DELETE", `/v1/sessions/${enc(sessionId)}`);
    return this.decode<SessionDeleted>("deleteSession", res);
  }

  /**
   * `POST /v1/sessions/{id}/turns`. Returns as soon as the turn is
   * registered; frames buffer until `openFrames` subscribes, so there is no
   * race between starting a turn and reading it. A 409 means the session
   * already has a live turn; a 429 with `Retry-After` means the server's
   * live-turn cap is full.
   */
  async startTurn(
    sessionId: string,
    request: SessionTurnRequest,
  ): Promise<SessionTurnCreated> {
    const res = await this.request(
      "POST",
      `/v1/sessions/${enc(sessionId)}/turns`,
      request,
    );
    const created = await this.decode<Partial<SessionTurnCreated>>(
      "startTurn",
      res,
    );
    return {
      ...requireTurnId("startTurn", created),
      session_id: created.session_id ?? sessionId,
    };
  }

  /** `POST /v1/turns` — the stateless form, carrying the whole conversation. */
  async startStatelessTurn(request: TurnRequest): Promise<TurnCreated> {
    const res = await this.request("POST", "/v1/turns", request);
    const created = await this.decode<Partial<TurnCreated>>(
      "startStatelessTurn",
      res,
    );
    return requireTurnId("startStatelessTurn", created);
  }

  /**
   * `GET /v1/turns/{id}/events`, decoded frame by frame.
   *
   * The request is made on the first `next()`, so an open that fails (a 409
   * because someone else holds the stream, a 404 because the turn is gone)
   * surfaces as an `EngineHttpError` from the iterator. Returning from the
   * loop early cancels the body, which releases the server's subscriber slot.
   *
   * `after` asks for a replay of everything past that seq before live frames.
   * The server answers a request it can no longer honour with one
   * `replay_truncated` frame and then closes; it is yielded like any other.
   */
  async *openFrames(
    turnId: string,
    options: OpenFramesOptions = {},
  ): AsyncGenerator<StellaSseFrame, void, undefined> {
    const query =
      options.after === undefined
        ? ""
        : `?after=${encodeURIComponent(String(options.after))}`;
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/turns/${enc(turnId)}/events${query}`,
      {
        method: "GET",
        headers: { ...this.headers(), accept: "text/event-stream" },
        signal: options.signal,
      },
    );
    if (!res.ok) throw await this.fail("openFrames", res);
    if (!res.body) {
      throw new Error("openFrames: the response carried no body to stream");
    }
    for await (const record of decodeSseStream(res.body)) {
      yield recordToFrame(record);
    }
  }

  /** `POST /v1/turns/{id}/provider-result`, the success arm. */
  async resolveProvider(
    turnId: string,
    requestId: string,
    result: CompletionResult,
  ): Promise<void> {
    const body: ProviderResultIn = {
      request_id: requestId,
      status: "ok",
      result,
    };
    await this.answer(turnId, "provider-result", body);
  }

  /**
   * `POST /v1/turns/{id}/provider-result`, the error arm. The `kind` decides
   * what the engine does next: `transport`, `rate_limited` and `overloaded`
   * re-enter its retry with backoff; the rest end the step.
   */
  async rejectProvider(
    turnId: string,
    requestId: string,
    error: ProviderErrorWire,
  ): Promise<void> {
    const body: ProviderResultIn = {
      request_id: requestId,
      status: "error",
      error,
    };
    await this.answer(turnId, "provider-result", body);
  }

  /**
   * `POST /v1/turns/{id}/provider-delta`. Optional and advisory: the
   * fragments surface on the event stream as `text_delta` / `reasoning` and
   * each batch resets the reverse-request deadline. An empty batch is refused
   * here before it reaches the server, which would answer 400.
   */
  async sendProviderDeltas(
    turnId: string,
    requestId: string,
    deltas: ProviderDelta[],
  ): Promise<void> {
    if (deltas.length === 0) {
      throw new Error(
        "sendProviderDeltas: a batch must carry at least one fragment; the server refuses an empty one",
      );
    }
    const body: ProviderDeltaIn = { request_id: requestId, deltas };
    await this.answer(turnId, "provider-delta", body);
  }

  /** `POST /v1/turns/{id}/tool-result`. */
  async resolveTool(
    turnId: string,
    requestId: string,
    output: ToolOutput,
  ): Promise<void> {
    const body: ToolResultIn = { request_id: requestId, output };
    await this.answer(turnId, "tool-result", body);
  }

  /**
   * `POST /v1/turns/{id}/requery-result`. `null` is the ordinary answer and
   * means the host has nothing worth the tokens for this step.
   */
  async resolveRequery(
    turnId: string,
    requestId: string,
    context: string | null,
  ): Promise<void> {
    const body: RequeryResultIn = { request_id: requestId, context };
    await this.answer(turnId, "requery-result", body);
  }

  /**
   * `POST /v1/turns/{id}/cancel`. Returns `true` when the server accepted
   * the cancel and `false` when the turn was already gone (404), so cancelling
   * twice, or cancelling a turn that just completed, is not an error.
   */
  async cancelTurn(turnId: string): Promise<boolean> {
    const res = await this.request("POST", `/v1/turns/${enc(turnId)}/cancel`);
    if (res.status === 404) {
      await res.text().catch(() => undefined);
      return false;
    }
    await this.decode("cancelTurn", res);
    return true;
  }

  /**
   * `POST /v1/turns/{id}/steer`. Queued for the next step boundary; a turn
   * that finishes first never sees it, and one that has already finished
   * answers 409.
   */
  async steer(turnId: string, message: string): Promise<void> {
    const res = await this.request("POST", `/v1/turns/${enc(turnId)}/steer`, {
      message,
    });
    await this.decode("steer", res);
  }

  /** `POST /v1/turns/{id}/pause`. Idempotent; 409 once the turn has finished. */
  async pause(turnId: string, reason?: string): Promise<void> {
    const res = await this.request(
      "POST",
      `/v1/turns/${enc(turnId)}/pause`,
      reason === undefined ? {} : { reason },
    );
    await this.decode("pause", res);
  }

  /** `POST /v1/turns/{id}/resume`. Idempotent; 409 once the turn has finished. */
  async resume(turnId: string): Promise<void> {
    const res = await this.request(
      "POST",
      `/v1/turns/${enc(turnId)}/resume`,
      {},
    );
    await this.decode("resume", res);
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async answer(
    turnId: string,
    route:
      | "provider-result"
      | "provider-delta"
      | "tool-result"
      | "requery-result",
    body: unknown,
  ): Promise<void> {
    const res = await this.request(
      "POST",
      `/v1/turns/${enc(turnId)}/${route}`,
      body,
    );
    await this.decode(route, res);
  }

  /** Read a 2xx JSON body, or throw the typed error for anything else. */
  private async decode<T = unknown>(
    operation: string,
    res: Response,
  ): Promise<T> {
    if (!res.ok) throw await this.fail(operation, res);
    return (await res.json()) as T;
  }

  private async fail(
    operation: string,
    res: Response,
  ): Promise<EngineHttpError> {
    const body = await res.text().catch(() => "");
    return new EngineHttpError(
      operation,
      res.status,
      body,
      res.headers.get("retry-after"),
    );
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function requireTurnId<T extends Partial<TurnCreated>>(
  operation: string,
  created: T,
): T & TurnCreated {
  if (typeof created.turn_id !== "string" || created.turn_id.length === 0) {
    throw new Error(
      `${operation}: the response carried no turn_id: ${JSON.stringify(created)}`,
    );
  }
  // The server omits `clamped` when nothing was lowered; callers read a list.
  return {
    ...created,
    turn_id: created.turn_id,
    clamped: created.clamped ?? [],
  };
}

function parseErrorBody(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as Partial<ErrorBody> | null;
    return typeof parsed?.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `Retry-After` is either a number of seconds or an HTTP date. The server
 * sends seconds; the date form is handled because a proxy in front of it may
 * not.
 */
function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}
