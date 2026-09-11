/**
 * Run one engine turn to its outcome, acting as the host for every reverse
 * request the engine raises along the way.
 *
 * The shape of the loop: start the turn, subscribe to its frames, and answer
 * each `provider_request` and `tool_request` as it arrives without waiting for
 * the previous one, because the engine dispatches a step's read-only tool
 * calls together and serialising them here would stall the step. A handler
 * that throws is reported to the engine rather than swallowed: a provider
 * failure becomes a classified `ProviderErrorWire` the engine can retry on,
 * and a tool failure becomes the `error` arm of `ToolOutput` the model reads
 * and reacts to. Under the alternative — collecting the failure and saying
 * nothing — the engine learns nothing and the step sits until its
 * reverse-request deadline, which turns a retryable blip into a dead turn.
 *
 * The connection is not the turn. When the stream drops before
 * `turn_complete`, the turn is still running on the server, which parks the
 * stream for thirty seconds so a subscriber can come back. This loop comes
 * back with `?after=<last seq>`, bounded by a backoff policy, and keeps its
 * outstanding request ids in memory across the gap — the server does not
 * re-announce an obligation on resume, because asking for `after=N` asserts
 * you already hold everything through N.
 */

import {
  EngineHttpError,
  isAbortError,
  isStaleRequest,
  type StellaEngineClient,
} from "./client";
import { frameSeq } from "./sse";
import type {
  AgentEvent,
  ClampedKnob,
  CompletionRequest,
  CompletionResult,
  ErrorClass,
  ModelCallRoleWire,
  ProviderDelta,
  ProviderErrorWire,
  ReplayTruncated,
  RequerySignal,
  SessionTurnRequest,
  StellaSseFrame,
  ToolOutput,
  TurnOutcomeWire,
  TurnRequest,
} from "./wire";

/** A `provider_request` frame as a handler sees it: the frame minus its tag. */
export interface ProviderRequestView {
  request_id: string;
  provider_id: string;
  role: ModelCallRoleWire;
  request: CompletionRequest;
}

/** A `tool_request` frame as a handler sees it. */
export interface ToolRequestView {
  request_id: string;
  name: string;
  input: unknown;
}

export interface RequestContext {
  /**
   * Aborted when the turn is cancelled, completes, or the stream is given up
   * on. A handler streaming a model call should stop on it: the engine no
   * longer waits for the answer.
   */
  signal: AbortSignal;
}

export interface ProviderRequestContext extends RequestContext {
  /**
   * Post a batch of streamed fragments for this request. Each batch resets
   * the engine's reverse-request deadline and surfaces on the event stream as
   * `text_delta` / `reasoning`, so the chat surface renders tokens as they
   * arrive. Advisory: the result returned by the handler is the text of
   * record. A batch posted after the turn ended is dropped silently, since
   * the answer it previews is stale too.
   */
  deltas(batch: ProviderDelta[]): Promise<void>;
}

export type ProviderRequestHandler = (
  request: ProviderRequestView,
  context: ProviderRequestContext,
) => Promise<CompletionResult>;

export type ToolRequestHandler = (
  request: ToolRequestView,
  context: RequestContext,
) => Promise<ToolOutput>;

/**
 * Answer a `requery_request` with the context block the host's own context
 * plane chose, or `null` for nothing worth the tokens. Only raised on a turn
 * started with `steering_requery: true`.
 */
export type RequeryRequestHandler = (
  signal: RequerySignal,
  context: RequestContext,
) => Promise<string | null>;

/** What `onHold` receives: the turn paused, with the reason, or released. */
export type TurnHold = { held: true; reason: string | null } | { held: false };

export interface DriveTurnHandlers {
  onProviderRequest: ProviderRequestHandler;
  onToolRequest: ToolRequestHandler;
  /** Absent means every re-query is answered `null` at once. */
  onRequeryRequest?: RequeryRequestHandler;
  /**
   * Every `event` frame, with its `seq`. The seq is what a ledger stores so a
   * later reader can ask the server for what it missed.
   */
  onEvent?: (event: AgentEvent, seq: number) => void;
  onHold?: (hold: TurnHold, seq: number) => void;
  /**
   * The server could not replay from the seq this loop asked for. The frames
   * between `requested_after` and `oldest_retained` are gone; the loop
   * continues from the oldest retained one. A host keeping a ledger reloads
   * that gap from the ledger.
   */
  onReplayTruncated?: (frame: ReplayTruncated) => void;
  /** The stream dropped and the loop is about to reconnect. */
  onResume?: (info: {
    attempt: number;
    after: number;
    delayMs: number;
  }) => void;
  /**
   * Classify a rejected `onProviderRequest` into the engine's taxonomy. The
   * host owns this because only its model adapter knows whether a failure
   * was a 429, a bad key, or a socket reset, and the engine's behaviour
   * forks on exactly that. Defaults to `classifyProviderError`.
   */
  classifyProviderError?: (error: unknown) => ProviderErrorWire;
  /** Turn a rejected `onToolRequest` into a `ToolOutput`. Defaults to `classifyToolError`. */
  classifyToolError?: (error: unknown) => ToolOutput;
}

export interface ResumePolicy {
  /** Reconnects attempted after the first stream, before giving up. */
  maxAttempts: number;
  /** Delay before the first reconnect; each later one doubles it. */
  baseDelayMs: number;
  /** Ceiling on the delay between reconnects. */
  maxDelayMs: number;
}

/**
 * Five tries over roughly eight seconds. The server parks a dropped stream
 * for thirty, so this gives up well inside the window rather than at its
 * edge, where a reconnect would race the server's own abandonment.
 */
export const DEFAULT_RESUME_POLICY: ResumePolicy = {
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 4000,
};

interface DriveTurnCommon {
  handlers: DriveTurnHandlers;
  /** Aborting it cancels the engine turn and returns the aborted outcome. */
  signal?: AbortSignal;
  resume?: Partial<ResumePolicy>;
  /**
   * After a cancel, how long to keep reading for the engine's own aborted
   * outcome before returning a synthesised one. The engine answers within a
   * step boundary; this bounds a host that would otherwise wait on a wedged
   * one.
   */
  cancelGraceMs?: number;
  /** The wait between reconnects; tests replace it with one that does not wait. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type DriveTurnOptions = DriveTurnCommon &
  (
    | { sessionId: string; request: SessionTurnRequest }
    | { sessionId?: undefined; request: TurnRequest }
  );

export interface TurnDriveResult {
  readonly turnId: string;
  readonly sessionId: string | undefined;
  readonly outcome: TurnOutcomeWire;
  /** The highest seq read. Stored beside the ledger, it is the resume point. */
  readonly lastSeq: number;
  /** Knobs the server lowered from what the request asked. */
  readonly clamped: readonly ClampedKnob[];
  /** `provider_request` frames received — calls asked for, not calls completed. */
  readonly providerCalls: number;
  /** `tool_request` frames received. */
  readonly toolCalls: number;
  /** `event` frames received. */
  readonly events: number;
  /** Frames whose `type` this client does not know: a newer server's. */
  readonly unknownFrames: number;
  /** How many times the stream was reconnected. */
  readonly resumes: number;
}

/** The stream dropped more times than the policy allows, before `turn_complete`. */
export class TurnStreamLostError extends Error {
  override readonly name = "TurnStreamLostError";
  constructor(
    readonly turnId: string,
    readonly lastSeq: number,
    readonly attempts: number,
    cause: unknown,
  ) {
    super(
      `turn ${turnId}: the event stream ended ${attempts + 1} times without turn_complete (last seq ${lastSeq})`,
      { cause },
    );
  }
}

/**
 * Default classification of a failed model call: an abort is `cancelled`,
 * which ends the step; anything else is `transport`, which the engine retries
 * with backoff. Retryable is the safe default in only one direction — a
 * terminal failure misread as `transport` costs a few retries that fail the
 * same way, while a blip misread as terminal kills a turn the engine could
 * have finished. A host that can tell them apart says so through
 * `DriveTurnHandlers.classifyProviderError`.
 */
export function classifyProviderError(error: unknown): ProviderErrorWire {
  if (isAbortError(error)) return { kind: "cancelled" };
  return { kind: "transport", message: errorMessage(error) };
}

const ERROR_CLASSES: ReadonlySet<string> = new Set<ErrorClass>([
  "invalid_input",
  "not_found",
  "permission_denied",
  "refused_by_policy",
  "timeout",
  "environment",
  "internal",
  "other",
]);

/**
 * Default conversion of a failed tool call into the `error` arm the model
 * reads. An error carrying a `class` that names one of the engine's error
 * classes keeps it, so a governance gate that throws `{class:
 * "refused_by_policy"}` reaches the engine as a refusal rather than a fault.
 */
export function classifyToolError(error: unknown): ToolOutput {
  const message = errorMessage(error);
  const cls =
    typeof error === "object" && error !== null && "class" in error
      ? (error as { class?: unknown }).class
      : undefined;
  if (typeof cls === "string" && ERROR_CLASSES.has(cls)) {
    return { error: { message, class: cls as ErrorClass } };
  }
  return { error: { message } };
}

/**
 * The seq to resume after. A process that still holds its outstanding request
 * ids resumes after the last seq it read. One that lost them — it restarted —
 * must ask for everything from the start, because the server never
 * re-announces an obligation on resume, and the only way to rediscover what
 * is owed is to read the frames that announced it.
 */
export function resumeAfter(
  lastSeq: number,
  knowsOutstanding: boolean,
): number {
  return knowsOutstanding ? lastSeq : 0;
}

export async function driveTurn(
  client: StellaEngineClient,
  options: DriveTurnOptions,
): Promise<TurnDriveResult> {
  const { handlers } = options;
  const policy: ResumePolicy = { ...DEFAULT_RESUME_POLICY, ...options.resume };
  const sleep = options.sleep ?? defaultSleep;
  const cancelGraceMs = options.cancelGraceMs ?? 5000;

  const started =
    options.sessionId === undefined
      ? await client.startStatelessTurn(options.request)
      : await client.startTurn(options.sessionId, options.request);
  const turnId = started.turn_id;
  const sessionId =
    "session_id" in started && typeof started.session_id === "string"
      ? started.session_id
      : options.sessionId;

  // One signal for everything this turn owns: the stream, the handlers, and
  // the reconnect sleeps. The caller's signal cancels the turn on the server
  // and then lets the stream deliver the engine's own aborted outcome; this
  // one fires when that has happened, or when the grace ran out.
  const internal = new AbortController();
  let outcome: TurnOutcomeWire | undefined;
  let cancelled = false;
  let lastSeq = 0;
  let providerCalls = 0;
  let toolCalls = 0;
  let events = 0;
  let unknownFrames = 0;
  let resumes = 0;
  const outstanding = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  const failures: unknown[] = [];
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const staleIsFine = (): boolean =>
    cancelled || outcome !== undefined || internal.signal.aborted;

  // Post an answer, tolerating the server's refusal of a request it no
  // longer waits on — which after a cancel or a completion is the expected
  // result, not a fault.
  const post = async (send: () => Promise<void>): Promise<void> => {
    try {
      await send();
    } catch (err) {
      if (isStaleRequest(err) && staleIsFine()) return;
      throw err;
    }
  };

  const track = (work: Promise<void>): void => {
    const settled: Promise<void> = work
      .catch((err: unknown) => {
        failures.push(err);
      })
      .finally(() => {
        inFlight.delete(settled);
      });
    inFlight.add(settled);
  };

  const answerProvider = async (view: ProviderRequestView): Promise<void> => {
    outstanding.add(view.request_id);
    try {
      const context: ProviderRequestContext = {
        signal: internal.signal,
        deltas: (batch) =>
          post(() => client.sendProviderDeltas(turnId, view.request_id, batch)),
      };
      let result: CompletionResult;
      try {
        result = await handlers.onProviderRequest(view, context);
      } catch (err) {
        const classify =
          handlers.classifyProviderError ?? classifyProviderError;
        await post(() =>
          client.rejectProvider(turnId, view.request_id, classify(err)),
        );
        return;
      }
      await post(() => client.resolveProvider(turnId, view.request_id, result));
    } finally {
      outstanding.delete(view.request_id);
    }
  };

  const answerTool = async (view: ToolRequestView): Promise<void> => {
    outstanding.add(view.request_id);
    try {
      let output: ToolOutput;
      try {
        output = await handlers.onToolRequest(view, {
          signal: internal.signal,
        });
      } catch (err) {
        output = (handlers.classifyToolError ?? classifyToolError)(err);
      }
      await post(() => client.resolveTool(turnId, view.request_id, output));
    } finally {
      outstanding.delete(view.request_id);
    }
  };

  const answerRequery = async (
    requestId: string,
    signal: RequerySignal,
  ): Promise<void> => {
    outstanding.add(requestId);
    try {
      let context: string | null = null;
      if (handlers.onRequeryRequest) {
        try {
          context = await handlers.onRequeryRequest(signal, {
            signal: internal.signal,
          });
        } catch (err) {
          // A failed re-query is the same as an empty one: the step proceeds
          // with the context it has. Recorded so the host hears about it.
          failures.push(err);
        }
      }
      await post(() => client.resolveRequery(turnId, requestId, context));
    } finally {
      outstanding.delete(requestId);
    }
  };

  const dispatch = (frame: StellaSseFrame, seq: number | undefined): void => {
    switch (frame.type) {
      case "event":
        events += 1;
        handlers.onEvent?.(frame.event, seq ?? lastSeq);
        break;
      case "provider_request": {
        providerCalls += 1;
        const { request_id, provider_id, role, request } = frame;
        track(answerProvider({ request_id, provider_id, role, request }));
        break;
      }
      case "tool_request": {
        toolCalls += 1;
        const { request_id, name, input } = frame;
        track(answerTool({ request_id, name, input }));
        break;
      }
      case "requery_request":
        track(answerRequery(frame.request_id, frame.signal));
        break;
      case "turn_held":
        handlers.onHold?.(
          { held: true, reason: frame.reason ?? null },
          seq ?? lastSeq,
        );
        break;
      case "turn_released":
        handlers.onHold?.({ held: false }, seq ?? lastSeq);
        break;
      case "turn_complete":
        outcome = frame.outcome;
        break;
      default:
        // A tag this client does not know is a newer server's frame. It is
        // counted and its seq is kept, so a resume never re-asks for it.
        unknownFrames += 1;
        break;
    }
  };

  const onAbort = (): void => {
    if (cancelled) return;
    cancelled = true;
    track(client.cancelTurn(turnId).then(() => undefined));
    graceTimer = setTimeout(() => internal.abort(), cancelGraceMs);
  };

  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    let attempt = 0;
    let firstOpen = true;
    for (;;) {
      // A fresh subscription carries no `after`; a reconnect asks for what
      // was missed. This loop always knows its outstanding requests, so it
      // never has to replay from the start.
      const after = firstOpen ? undefined : resumeAfter(lastSeq, true);
      firstOpen = false;
      let truncated = false;
      let dropped: unknown;
      try {
        for await (const frame of client.openFrames(turnId, {
          after,
          signal: internal.signal,
        })) {
          if (frame.type === "replay_truncated") {
            handlers.onReplayTruncated?.(frame);
            lastSeq = Math.max(0, frame.oldest_retained - 1);
            truncated = true;
            break;
          }
          const seq = frameSeq(frame);
          if (seq !== undefined) {
            if (seq <= lastSeq) continue;
            lastSeq = seq;
          }
          dispatch(frame, seq);
          if (outcome !== undefined) break;
        }
      } catch (err) {
        if (outcome !== undefined || internal.signal.aborted) break;
        if (err instanceof EngineHttpError) {
          // The open itself was refused. After a cancel, a 404 is the turn
          // having already left the registry, which is the end this loop
          // was waiting for; anything else is the caller's to see.
          if (err.status === 404 && cancelled) break;
          throw err;
        }
        if (isAbortError(err)) break;
        dropped = err;
      }
      if (outcome !== undefined || internal.signal.aborted) break;
      if (truncated) continue;
      attempt += 1;
      if (attempt > policy.maxAttempts) {
        throw new TurnStreamLostError(
          turnId,
          lastSeq,
          policy.maxAttempts,
          dropped,
        );
      }
      const delayMs = Math.min(
        policy.maxDelayMs,
        policy.baseDelayMs * 2 ** (attempt - 1),
      );
      resumes += 1;
      handlers.onResume?.({ attempt, after: lastSeq, delayMs });
      await sleep(delayMs, internal.signal);
      if (internal.signal.aborted) break;
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    internal.abort();
    // Every answer still in flight settles here; a stale refusal after the
    // outcome is tolerated by `post`, a real failure is collected.
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  }

  if (failures.length > 0) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(
          failures,
          `turn ${turnId}: ${failures.length} handlers failed`,
        );
  }
  if (outcome === undefined) {
    if (!cancelled) {
      throw new Error(
        `turn ${turnId}: the stream closed without turn_complete`,
      );
    }
    outcome = {
      status: "aborted",
      reason: "cancelled by the host before the engine reported an outcome",
    };
  }
  return {
    turnId,
    sessionId,
    outcome,
    lastSeq,
    clamped: started.clamped,
    providerCalls,
    toolCalls,
    events,
    unknownFrames,
    resumes,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
