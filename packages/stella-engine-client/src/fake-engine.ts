/**
 * An in-process stand-in for `stella-serve`, spoken to through a `fetch`.
 *
 * It exists so the client and the turn loop can be tested against the
 * server's observed behaviour without a socket or a binary: the routes, the
 * status codes, the `seq` envelope, `?after=` replay, the parked reverse
 * requests, and the refusals (409 for a stale answer, 409 for a second
 * subscriber, 429 at the session cap, 400 for an empty delta batch).
 *
 * A turn is a script: a list of frames in the order the engine would emit
 * them. Emission pauses at a `provider_request` or `tool_request` until the
 * host answers it, exactly as the engine parks the step, and the answer is
 * recorded so a test can assert on it. The smoke test drives the same script
 * against the real binary, which is what keeps this fake honest.
 */

import type {
  ProviderDelta,
  ProviderResultIn,
  ServerFrame,
  ToolOutput,
  ToolResultIn,
} from "./wire";

export interface FakeEngineOptions {
  /** Bearer token the fake accepts. */
  token?: string;
  /** Session cap; a create past it answers 429 with `Retry-After: 5`. */
  maxSessions?: number;
  /** Frames retained for replay; a resume older than this is `replay_truncated`. */
  retainedFrames?: number;
  /**
   * Close the event stream after this many frames, once, without ending the
   * turn — the shape of a dropped connection. The next subscriber that
   * resumes with `?after=` continues.
   */
  dropAfterFrames?: number;
  /** Answer `/readyz` with this state; anything but `ready` is a 503. */
  readiness?: "ready" | "starting" | "draining";
}

export interface RecordedPost {
  route:
    | "provider-result"
    | "provider-delta"
    | "tool-result"
    | "requery-result";
  turnId: string;
  body: unknown;
  status: number;
}

/** A frame with its engine-assigned seq, as it will go over the fake's wire. */
type Emitted = ServerFrame & { seq: number };

interface FakeTurn {
  id: string;
  sessionId: string | undefined;
  script: ServerFrame[];
  /** Index of the next scripted frame to emit. */
  cursor: number;
  emitted: Emitted[];
  /** The reverse request emission is parked on, when any. */
  waitingOn: string | undefined;
  answered: Set<string>;
  done: boolean;
  cancelled: boolean;
  subscriber: { close(): void } | undefined;
  wake: (() => void) | undefined;
  dropped: boolean;
}

interface FakeSession {
  id: string;
  systemPrompt: string;
  messages: unknown[];
  liveTurn: string | undefined;
  turnsCompleted: number;
  turnsAborted: number;
}

export class FakeEngine {
  readonly posts: RecordedPost[] = [];
  readonly turnRequests: unknown[] = [];
  readonly sessionRequests: unknown[] = [];
  private readonly token: string;
  private readonly maxSessions: number;
  private readonly retainedFrames: number;
  private readonly dropAfterFrames: number | undefined;
  private readiness: "ready" | "starting" | "draining";
  private readonly sessions = new Map<string, FakeSession>();
  private readonly turns = new Map<string, FakeTurn>();
  private scripts: ServerFrame[][] = [];
  private counter = 0;

  constructor(options: FakeEngineOptions = {}) {
    this.token = options.token ?? "fake-token";
    this.maxSessions = options.maxSessions ?? 64;
    this.retainedFrames = options.retainedFrames ?? 4096;
    this.dropAfterFrames = options.dropAfterFrames;
    this.readiness = options.readiness ?? "ready";
  }

  /** Queue the frames the next started turn will emit. */
  scriptTurn(frames: ServerFrame[]): void {
    this.scripts.push(frames);
  }

  setReadiness(state: "ready" | "starting" | "draining"): void {
    this.readiness = state;
  }

  /** The turn ids started so far, in order. */
  get turnIds(): string[] {
    return [...this.turns.keys()];
  }

  /** Whether the host's last subscriber is still attached to the turn. */
  hasSubscriber(turnId: string): boolean {
    return this.turns.get(turnId)?.subscriber !== undefined;
  }

  /** A `fetch` bound to this fake, for `StellaEngineClientOptions.fetchImpl`. */
  get fetch(): typeof fetch {
    return async (input, init) => this.handle(input, init);
  }

  private async handle(
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;

    if (path === "/healthz") return json(200, { status: "ok" });
    if (path === "/readyz") {
      return json(this.readiness === "ready" ? 200 : 503, {
        state: this.readiness,
      });
    }

    const auth = headerOf(init?.headers, "authorization");
    if (auth !== `Bearer ${this.token}`) {
      return json(401, { error: "missing or invalid bearer token" });
    }

    let m: RegExpMatchArray | null;
    if (path === "/v1/sessions" && method === "POST") {
      return this.createSession(await bodyOf(init));
    }
    if ((m = path.match(/^\/v1\/sessions\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]!);
      if (method === "GET") return this.getSession(id);
      if (method === "DELETE") return this.deleteSession(id);
      return json(405, { error: "method not allowed" });
    }
    if (
      (m = path.match(/^\/v1\/sessions\/([^/]+)\/turns$/)) &&
      method === "POST"
    ) {
      return this.startTurn(decodeURIComponent(m[1]!), await bodyOf(init));
    }
    if (path === "/v1/turns" && method === "POST") {
      return this.startTurn(undefined, await bodyOf(init));
    }
    if ((m = path.match(/^\/v1\/turns\/([^/]+)\/([a-z-]+)$/))) {
      const id = decodeURIComponent(m[1]!);
      const route = m[2]!;
      const turn = this.turns.get(id);
      if (!turn) return json(404, { error: "unknown turn" });
      switch (route) {
        case "events":
          return this.events(turn, url.searchParams.get("after"), init?.signal);
        case "provider-result":
        case "tool-result":
        case "requery-result":
          return this.answer(turn, route, await bodyOf(init));
        case "provider-delta":
          return this.delta(turn, await bodyOf(init));
        case "cancel":
          return this.cancel(turn);
        case "steer":
        case "pause":
        case "resume":
          if (turn.done) return json(409, { error: "turn already finished" });
          return json(200, {
            status:
              route === "steer"
                ? "queued"
                : route === "pause"
                  ? "paused"
                  : "resumed",
          });
        default:
          return json(404, { error: "not found" });
      }
    }
    return json(404, { error: "not found" });
  }

  private createSession(body: unknown): Response {
    this.sessionRequests.push(body);
    if (this.sessions.size >= this.maxSessions) {
      return json(
        429,
        { error: "too many sessions; delete sessions you are done with" },
        { "retry-after": "5" },
      );
    }
    const request = body as { system_prompt?: unknown };
    if (typeof request.system_prompt !== "string") {
      return json(400, {
        error: "invalid session request: missing field `system_prompt`",
      });
    }
    const id = `session-${this.nextId()}`;
    this.sessions.set(id, {
      id,
      systemPrompt: request.system_prompt,
      messages: [{ role: "system", content: request.system_prompt }],
      liveTurn: undefined,
      turnsCompleted: 0,
      turnsAborted: 0,
    });
    return json(200, { session_id: id });
  }

  private getSession(id: string): Response {
    const s = this.sessions.get(id);
    if (!s) return json(404, { error: "unknown session" });
    return json(200, {
      session_id: s.id,
      turns_completed: s.turnsCompleted,
      turns_aborted: s.turnsAborted,
      cost_usd: 0,
      live_turn: s.liveTurn ?? null,
      held: false,
      messages: s.messages,
    });
  }

  private deleteSession(id: string): Response {
    if (!this.sessions.delete(id))
      return json(404, { error: "unknown session" });
    return json(200, { status: "deleted" });
  }

  private startTurn(sessionId: string | undefined, body: unknown): Response {
    this.turnRequests.push(body);
    let session: FakeSession | undefined;
    if (sessionId !== undefined) {
      session = this.sessions.get(sessionId);
      if (!session) return json(404, { error: "unknown session" });
      if (session.liveTurn !== undefined) {
        return json(409, {
          error: "a turn is already running in this session",
        });
      }
      const input = (body as { input?: unknown }).input;
      if (!Array.isArray(input) || input.length === 0) {
        return json(400, { error: "input must carry at least one message" });
      }
      session.messages.push(...(input as unknown[]));
    }
    const script = this.scripts.shift();
    if (!script) {
      throw new Error(
        "FakeEngine: no scripted turn queued; call scriptTurn() first",
      );
    }
    const id = `turn-${this.nextId()}`;
    const turn: FakeTurn = {
      id,
      sessionId,
      script,
      cursor: 0,
      emitted: [],
      waitingOn: undefined,
      answered: new Set(),
      done: false,
      cancelled: false,
      subscriber: undefined,
      wake: undefined,
      dropped: false,
    };
    this.turns.set(id, turn);
    if (session) session.liveTurn = id;
    const created: Record<string, unknown> = { turn_id: id };
    if (session) created.session_id = session.id;
    const clamped = (body as { engine?: { max_output_tokens?: number } }).engine
      ?.max_output_tokens;
    if (typeof clamped === "number" && clamped > 262_144) {
      created.clamped = [
        { knob: "max_output_tokens", requested: clamped, effective: 262_144 },
      ];
    }
    return json(200, created);
  }

  /**
   * Advance the script until it parks on a reverse request, ends, or runs
   * out. Returns the frames newly emitted.
   */
  private advance(turn: FakeTurn): Emitted[] {
    const out: Emitted[] = [];
    while (
      !turn.done &&
      turn.waitingOn === undefined &&
      turn.cursor < turn.script.length
    ) {
      const frame = turn.script[turn.cursor]!;
      turn.cursor += 1;
      const emitted = { ...frame, seq: turn.emitted.length + 1 } as Emitted;
      turn.emitted.push(emitted);
      out.push(emitted);
      if (
        frame.type === "provider_request" ||
        frame.type === "tool_request" ||
        frame.type === "requery_request"
      ) {
        turn.waitingOn = frame.request_id;
      }
      if (frame.type === "turn_complete") {
        this.finish(turn, frame.outcome.status === "aborted");
      }
    }
    return out;
  }

  private finish(turn: FakeTurn, aborted: boolean): void {
    turn.done = true;
    if (turn.sessionId) {
      const s = this.sessions.get(turn.sessionId);
      if (s) {
        s.liveTurn = undefined;
        if (aborted) s.turnsAborted += 1;
        else s.turnsCompleted += 1;
      }
    }
  }

  private answer(
    turn: FakeTurn,
    route: RecordedPost["route"],
    body: unknown,
  ): Response {
    const requestId = (body as { request_id?: unknown }).request_id;
    let status: number;
    if (turn.done) status = 404;
    else if (typeof requestId !== "string" || turn.waitingOn !== requestId)
      status = 409;
    else if (
      route === "provider-result" &&
      !validProviderResult(body as ProviderResultIn)
    ) {
      status = 400;
    } else if (
      route === "tool-result" &&
      !validToolResult(body as ToolResultIn)
    )
      status = 400;
    else status = 200;
    this.posts.push({ route, turnId: turn.id, body, status });
    if (status === 404) return json(404, { error: "unknown turn" });
    if (status === 409)
      return json(409, { error: "no pending request with that id" });
    if (status === 400)
      return json(400, { error: `invalid ${route.replace("-", " ")}` });
    turn.answered.add(requestId as string);
    turn.waitingOn = undefined;
    // With a subscriber, the pump advances the script; without one the
    // engine still does, into the ring.
    if (turn.wake) turn.wake();
    else this.advance(turn);
    return json(200, { status: "ok" });
  }

  private delta(turn: FakeTurn, body: unknown): Response {
    const request = body as { request_id?: unknown; deltas?: unknown };
    let status: number;
    if (turn.done) status = 404;
    else if (
      typeof request.request_id !== "string" ||
      turn.waitingOn !== request.request_id
    )
      status = 409;
    else if (!Array.isArray(request.deltas)) status = 400;
    else if (request.deltas.length === 0) status = 400;
    else status = 200;
    this.posts.push({ route: "provider-delta", turnId: turn.id, body, status });
    if (status === 404) return json(404, { error: "unknown turn" });
    if (status === 409)
      return json(409, { error: "no pending request with that id" });
    if (status === 400) {
      return json(400, {
        error: Array.isArray(request.deltas)
          ? "deltas must carry at least one fragment"
          : "invalid provider delta",
      });
    }
    return json(200, { status: "ok" });
  }

  private cancel(turn: FakeTurn): Response {
    if (turn.done) {
      this.turns.delete(turn.id);
      return json(404, { error: "unknown turn" });
    }
    turn.cancelled = true;
    // The engine reports the abort as the terminal frame and then the turn
    // leaves the registry, so the next cancel is an honest 404.
    const outcome: Emitted = {
      type: "turn_complete",
      outcome: { status: "aborted", reason: "cancelled", cost_usd: 0 },
      seq: turn.emitted.length + 1,
    };
    turn.emitted.push(outcome);
    turn.waitingOn = undefined;
    this.finish(turn, true);
    turn.wake?.();
    return json(200, { status: "cancelled" });
  }

  private events(
    turn: FakeTurn,
    afterParam: string | null,
    signal: AbortSignal | null | undefined,
  ): Response {
    const after = afterParam === null ? undefined : Number(afterParam);
    if (turn.subscriber && after === undefined) {
      return json(409, {
        error: "events are already being streamed for this turn",
      });
    }
    if (turn.subscriber) turn.subscriber.close();

    const encoder = new TextEncoder();
    let closed = false;
    let pushed = 0;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const close = (): void => {
          if (closed) return;
          closed = true;
          if (turn.subscriber === subscriber) turn.subscriber = undefined;
          turn.wake = undefined;
          try {
            controller.close();
          } catch {
            // Already closed by the consumer cancelling.
          }
        };
        const subscriber = { close };
        turn.subscriber = subscriber;
        signal?.addEventListener("abort", close, { once: true });

        const write = (
          frame:
            | Emitted
            | {
                type: "replay_truncated";
                requested_after: number;
                oldest_retained: number;
              },
        ): boolean => {
          if (closed) return false;
          const id = "seq" in frame ? `id: ${frame.seq}\n` : "";
          controller.enqueue(
            encoder.encode(`${id}data: ${JSON.stringify(frame)}\n\n`),
          );
          pushed += 1;
          // A connection can drop at any frame before the outcome reaches the
          // host; the script's own state does not decide that.
          if (
            this.dropAfterFrames !== undefined &&
            !turn.dropped &&
            pushed >= this.dropAfterFrames &&
            frame.type !== "turn_complete"
          ) {
            turn.dropped = true;
            close();
            // The engine keeps running while nobody listens: whatever the
            // script can emit without an answer lands in the ring now.
            this.advance(turn);
            return false;
          }
          return true;
        };

        // Everything the turn has emitted past `written` goes out, whether it
        // was replayed from the ring or produced just now; then the script
        // advances until it parks on a reverse request or ends.
        let written = after ?? 0;
        if (after !== undefined) {
          const oldestRetained = Math.max(
            1,
            turn.emitted.length - this.retainedFrames + 1,
          );
          if (after + 1 < oldestRetained) {
            write({
              type: "replay_truncated",
              requested_after: after,
              oldest_retained: oldestRetained,
            });
            close();
            return;
          }
        }
        const flush = (): boolean => {
          for (const frame of turn.emitted) {
            if (frame.seq <= written) continue;
            if (!write(frame)) return false;
            written = frame.seq;
          }
          return true;
        };
        const pump = (): void => {
          if (closed) return;
          if (!flush()) return;
          this.advance(turn);
          if (!flush()) return;
          if (turn.done) {
            close();
            return;
          }
          turn.wake = () => {
            turn.wake = undefined;
            pump();
          };
        };
        pump();
      },
      cancel: () => {
        closed = true;
        if (turn.subscriber) turn.subscriber = undefined;
        turn.wake = undefined;
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      },
    });
  }

  private nextId(): string {
    this.counter += 1;
    return this.counter.toString(16).padStart(8, "0");
  }
}

function validProviderResult(body: ProviderResultIn): boolean {
  if (body.status === "ok") {
    const r = body.result;
    return (
      typeof r === "object" &&
      r !== null &&
      typeof r.model === "string" &&
      typeof r.cost_usd === "number" &&
      typeof r.usage === "object" &&
      (r.tool_calls ?? []).every(
        (c) => typeof c.call_id === "string" && typeof c.name === "string",
      )
    );
  }
  return (
    body.status === "error" &&
    typeof body.error === "object" &&
    body.error !== null
  );
}

function validToolResult(body: ToolResultIn): boolean {
  const o = body.output as ToolOutput | undefined;
  return typeof o === "object" && o !== null && ("ok" in o || "error" in o);
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function headerOf(
  headers: RequestInit["headers"],
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    return headers.find(([k]) => k.toLowerCase() === name)?.[1];
  }
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === name) return v;
  }
  return undefined;
}

async function bodyOf(init: RequestInit | undefined): Promise<unknown> {
  const raw = init?.body;
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "string") return raw.length === 0 ? {} : JSON.parse(raw);
  throw new Error(
    "FakeEngine: request bodies must be strings (the server needs a Content-Length)",
  );
}

/** A minimal frame script: one completion, one tool call, one final answer. */
export function goldenScript(): ServerFrame[] {
  return [
    {
      type: "provider_request",
      request_id: "prov-1-0",
      provider_id: "openrouter",
      role: "worker",
      request: {
        messages: [{ role: "user", content: "list the nodes" }],
        max_output_tokens: 16384,
        temperature: 0,
        tools: [
          {
            name: "search_nodes",
            description: "Search graph nodes",
            input_schema: {
              type: "object",
              properties: { q: { type: "string" } },
              required: ["q"],
            },
            read_only: true,
            speculation_safe: false,
          },
        ],
      },
    } as ServerFrame,
    {
      type: "event",
      event: { type: "stage", name: "execute", scope: "run" },
    } as ServerFrame,
    {
      type: "tool_request",
      request_id: "tool-1-0",
      name: "search_nodes",
      input: { q: "nodes" },
    },
    {
      type: "event",
      event: {
        type: "tool_start",
        call: {
          call_id: "call_1",
          name: "search_nodes",
          input: { q: "nodes" },
        },
      },
    } as ServerFrame,
    {
      type: "provider_request",
      request_id: "prov-1-1",
      provider_id: "openrouter",
      role: "worker",
      request: {
        messages: [
          { role: "user", content: "list the nodes" },
          {
            role: "assistant",
            tool_calls: [
              {
                call_id: "call_1",
                name: "search_nodes",
                input: { q: "nodes" },
              },
            ],
          },
          {
            role: "tool",
            tool_results: [
              { call_id: "call_1", output: { ok: { content: "[n1,n2,n3]" } } },
            ],
          },
        ],
        max_output_tokens: 16384,
        temperature: 0,
      },
    } as ServerFrame,
    {
      type: "event",
      event: {
        type: "tool_result",
        call_id: "call_1",
        output: { ok: { content: "[n1,n2,n3]" } },
        duration_ms: 0,
        speculated: false,
      },
    } as ServerFrame,
    {
      type: "event",
      event: { type: "text_delta", delta: "There are " },
    } as ServerFrame,
    {
      type: "event",
      event: { type: "text", text: "There are 3 nodes." },
    } as ServerFrame,
    {
      type: "event",
      event: {
        type: "turn_complete",
        model: "anthropic/claude-sonnet-4.6",
        cost_usd: 0.002,
      },
    } as ServerFrame,
    {
      type: "turn_complete",
      outcome: {
        status: "completed",
        text: "There are 3 nodes.",
        cost_usd: 0.002,
      },
    },
  ];
}

/** The `provider_request` answer the golden script expects for `requestId`. */
export function goldenProviderAnswer(requestId: string) {
  const usage = {
    reported: true,
    input_tokens: 10,
    output_tokens: 5,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
  };
  if (requestId === "prov-1-0") {
    return {
      text: "",
      tool_calls: [
        { call_id: "call_1", name: "search_nodes", input: { q: "nodes" } },
      ],
      usage,
      model: "anthropic/claude-sonnet-4.6",
      cost_usd: 0.001,
      finish_reason: "tool_calls" as const,
    };
  }
  return {
    text: "There are 3 nodes.",
    tool_calls: [],
    usage,
    model: "anthropic/claude-sonnet-4.6",
    cost_usd: 0.001,
    finish_reason: "stop" as const,
  };
}

export const goldenToolAnswer: ToolOutput = { ok: { content: "[n1,n2,n3]" } };
export const goldenDelta: ProviderDelta[] = [
  { kind: "text", text: "There are " },
];
