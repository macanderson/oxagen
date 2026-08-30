/**
 * @oxagen/functions - Provider-agnostic durable function interfaces.
 *
 * These types define the contract for durable function execution without
 * coupling to any specific provider (Inngest, Temporal, custom AWS, etc.).
 * Product code imports from this package; provider adapters implement these
 * interfaces against concrete SDKs.
 *
 * The shapes are provider-agnostic; a handful of *string values* are not.
 * `ConcurrencyConfig.key`, `CancelOnConfig.if`, `batchEvents.key` and
 * `WaitForEventOptions.match` all carry an expression written in the
 * provider's own dialect (CEL, for the Inngest adapter). Swapping providers
 * means rewriting those strings even though no type changes. They are called
 * out individually below so the seams are visible rather than surprising.
 */

// ─── Event Types ─────────────────────────────────────────────────────────────

/**
 * A typed event payload. All events flowing through the durable function
 * system conform to this shape: a string name and an arbitrary data bag.
 */
export type EventPayload<T = Record<string, unknown>> = {
  name: string;
  data: T;
};

// ─── Step Context ────────────────────────────────────────────────────────────

/**
 * Options for waitForEvent. The step will park until an event matching
 * these criteria arrives, or the timeout elapses.
 */
export interface WaitForEventOptions {
  /** The event name to wait for. */
  event: string;
  /** Timeout duration as a string (e.g. "30s", "5m", "1h"). */
  timeout: string;
  /**
   * Optional expression matching a field on the incoming event against the
   * same field on the triggering event (e.g. "data.fanoutId"). Written in the
   * provider's expression dialect — see the provider-dialect note at the top
   * of this file.
   */
  match?: string;
}

/**
 * The step context provided to durable function handlers. Each method
 * represents a durable, retriable unit of work that the runtime checkpoints.
 *
 * All methods accept a human-readable label as the first argument for
 * observability and idempotency keying.
 */
export interface StepContext {
  /**
   * Execute a named step function. The result is checkpointed; on retry
   * the cached value is returned without re-executing the function.
   *
   * IMPORTANT — the declared `T` is what `fn` returns, NOT what a replay
   * hands back. The checkpoint is JSON, so once a run resumes from it the
   * value has been through `JSON.parse(JSON.stringify(...))`: `Date` comes
   * back as an ISO string, `undefined` as `null`, `Map` and `Set` as `{}`,
   * and a `Uint8Array` as `{ "0": 12, "1": 34, ... }`. The type does not
   * model that round-trip, so the compiler will happily let you call
   * `.getTime()` on what is now a string.
   *
   * Return JSON-native values from `fn` wherever you can. The two workarounds
   * already in the tree show the shape of the fix: `auth.session-expiry-audit.ts`
   * re-parses `expiresAt` on the way out, and `agent.video-render.ts` keeps raw
   * bytes inside a single step so they never cross a boundary at all.
   */
  run<T>(name: string, fn: () => T | Promise<T>): Promise<T>;

  /**
   * Dispatch one or more events from within a step. The label identifies
   * this send operation for idempotency. Any per-event ids the provider
   * assigns are discarded; use `waitForEvent` to correlate a reply rather
   * than expecting a handle back from here.
   */
  sendEvent(label: string, event: EventPayload | EventPayload[]): Promise<void>;

  /**
   * Park execution until a matching event arrives or the timeout elapses.
   * Returns the event payload if received, or null on timeout.
   */
  waitForEvent<T = Record<string, unknown>>(
    label: string,
    opts: WaitForEventOptions,
  ): Promise<EventPayload<T> | null>;

  /**
   * Sleep before continuing. Pass a *duration* string ("30s", "5m", "1h") for
   * a relative wait, or a `Date` for an absolute wake time.
   *
   * Do NOT pass an ISO-8601 timestamp as a string. A string is parsed as a
   * duration, and a timestamp does not parse as one — the provider does not
   * reject it, it resolves to an empty duration and the step does not wait at
   * all. Wrap it: `sleep(label, new Date(iso))`.
   */
  sleep(label: string, duration: string | Date): Promise<void>;
}

// ─── Function Configuration ──────────────────────────────────────────────────

/**
 * Concurrency configuration for a durable function.
 */
export interface ConcurrencyConfig {
  /** Maximum concurrent executions. */
  limit: number;
  /**
   * Optional key expression scoping the limit, so each distinct key value
   * gets its own budget (e.g. "event.data.orgId" for a per-tenant limit).
   * Provider dialect — see the note at the top of this file.
   */
  key?: string;
}

/**
 * A cancellation trigger: the function is cancelled when this event arrives
 * and the optional condition matches.
 */
export interface CancelOnConfig {
  /** Event name that triggers cancellation. */
  event: string;
  /**
   * Optional condition narrowing which in-flight runs the event cancels
   * (e.g. "event.data.executionId == async.data.executionId"). Without it
   * the event cancels every in-flight run of the function. Provider dialect
   * — see the note at the top of this file.
   */
  if?: string;
}

/**
 * Configuration for a durable function definition.
 */
export interface DurableFunctionConfig {
  /** Unique function identifier (used for routing and observability). */
  id: string;
  /**
   * Number of retry attempts on failure. Providers cap this — Inngest types
   * its own option as the literal union 0–20.
   *
   * Nothing in this repo enforces that. `number` is deliberately wider than
   * the provider allows, and the Inngest adapter casts the whole config on
   * the way into `inngest.createFunction`, which erases the SDK's union too.
   * An out-of-range value therefore compiles here and travels all the way to
   * the provider's own registration/sync check. Keep values in range.
   */
  retries?: number;
  /** Concurrency limits for this function. */
  concurrency?: ConcurrencyConfig;
  /** Events that trigger automatic cancellation of in-flight runs. */
  cancelOn?: CancelOnConfig[];
  /** Timeout configuration for the function run. */
  timeouts?: { finish?: string };
  /**
   * Optional failure handler invoked once the function exhausts its retries.
   *
   * IMPORTANT — this handler does NOT receive the original trigger event.
   * Adapters register it as a separate companion function subscribed to the
   * provider's own function-failed event, so `ctx.event` is that failure
   * event and the original payload is nested one level down:
   *
   * ```ts
   * onFailure: async ({ event }) => {
   *   const d = event.data as {
   *     event?: { data?: { requestId?: string } };
   *     error?: { message?: string };
   *   };
   *   const requestId = d.event?.data?.requestId; // NOT event.data.requestId
   * }
   * ```
   *
   * `event.data.error` is the serialized final error (a plain JSON object,
   * not an `Error` instance — no stack, no `instanceof`). The companion is
   * registered with its own id and inherits none of the parent's `retries`,
   * `concurrency`, `timeouts` or `cancelOn`, so keep the handler cheap and
   * idempotent: it gets the provider's default retry budget, not yours.
   */
  onFailure?: DurableFunctionHandler;
  /**
   * Batch many trigger events into a single function run. When set, the
   * provider collects up to `maxSize` matching events (or waits `timeout`,
   * e.g. "30s") and invokes the handler once with all of them exposed on
   * `ctx.events`. `key` batches per-key so a run never mixes tenants — set
   * it to "event.data.orgId" unless you have a reason not to. Provider
   * dialect — see the note at the top of this file.
   *
   * No durable function uses this yet. The first one that does should also
   * read `ctx.events`, not `ctx.event` — otherwise batching silently drops
   * every event but the first.
   */
  batchEvents?: { maxSize: number; timeout: string; key?: string };
}

// ─── Function Trigger ────────────────────────────────────────────────────────

/**
 * A function trigger: either event-driven or cron-scheduled.
 *
 * The union rules out supplying both, but not supplying an empty one — the
 * type accepts `{ event: "" }`. Adapters reject that at `createFunction` time
 * rather than registering a function nothing can ever fire.
 */
export type DurableFunctionTrigger =
  | { event: string; cron?: never }
  | { cron: string; event?: never };

// ─── Function Handler ────────────────────────────────────────────────────────

/**
 * The context object passed to a durable function handler at invocation time.
 */
export interface DurableFunctionHandlerContext {
  /**
   * The triggering event. Always present — where a run has no meaningful
   * trigger payload (a cron schedule, say) the adapter normalizes it to an
   * empty-named payload rather than leaving this undefined, so handlers
   * never have to null-check it.
   */
  event: EventPayload<Record<string, unknown>>;
  /**
   * All events in this run when the function uses `batchEvents`. For a
   * non-batched run this is a single-element array holding the same event as
   * `event`; for a batched run it holds every collected event. Handlers that
   * opt into batching read this instead of `event`.
   */
  events?: EventPayload<Record<string, unknown>>[];
  /** The step context for durable operations. */
  step: StepContext;
  /**
   * Provider-assigned id of this function run, stable across step replays.
   * Used as the worker identity for durable claim/lease ownership
   * (docs/specs/graph-mediated-fanout-phase2 §1). Optional because tests and
   * older providers may not supply it.
   *
   * When it is absent there is no unique worker identity for the run, so a
   * lease holder cannot be told apart from a concurrent run of the same work.
   * Substituting a value derived from the event payload does not restore that
   * — two runs triggered by the same event would share it. Treat an absent
   * `runId` as "ownership is unprovable" rather than as a value to synthesize.
   */
  runId?: string;
}

/**
 * The async handler function executed when a durable function is triggered.
 * Receives the event and step context, returns an arbitrary result.
 */
export type DurableFunctionHandler<TReturn = unknown> = (
  ctx: DurableFunctionHandlerContext,
) => Promise<TReturn>;

// ─── Durable Function (opaque registered handle) ─────────────────────────────

/**
 * An opaque handle representing a registered durable function. Consumers
 * pass these to the serve layer; internals are provider-specific.
 */
export interface DurableFunction {
  /**
   * The function's configuration (for introspection). The unique id is
   * `config.id` — there is deliberately NO top-level `id` field: provider
   * adapters (e.g. Inngest) return objects whose `id` is a callable method,
   * and a string `id` here would shadow it and break the provider's serve
   * handler. Read the id via `config.id`.
   */
  readonly config: DurableFunctionConfig;
  /** The trigger that activates this function. */
  readonly trigger: DurableFunctionTrigger;
}

// ─── Event Client ────────────────────────────────────────────────────────────

/**
 * Client for dispatching events into the durable function system from
 * outside function handlers (e.g. HTTP handlers, cron jobs).
 */
export interface EventClient {
  /**
   * Send one or more events. The provider delivers them to any functions
   * whose trigger matches.
   *
   * As with `StepContext.sendEvent`, any per-event ids the provider assigns
   * are discarded. Correlate a reply through an event the sender can match
   * on — don't expect a handle back from here.
   */
  send(event: EventPayload | EventPayload[]): Promise<void>;
}

// ─── Factory Type ────────────────────────────────────────────────────────────

/**
 * Factory function signature for creating durable functions from abstract
 * configuration. Provider adapters implement this to translate abstract
 * definitions into provider-native function objects.
 *
 * Conformance is structural and currently unverified: no adapter in the tree
 * annotates its exported `createFunction` with this type, so a signature drift
 * between the two would compile. Annotating an adapter's export against this
 * type is what would turn the intent into a check.
 */
export type CreateFunctionFactory = (
  config: DurableFunctionConfig,
  trigger: DurableFunctionTrigger,
  handler: DurableFunctionHandler,
) => DurableFunction[];

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Throw this error to permanently fail a function without retries.
 *
 * Two things carry the signal, and both are load-bearing:
 *
 * - `isNonRetriable` is what adapters branch on when they translate this into
 *   their own non-retriable type. It is a structural check, so it survives
 *   the error crossing a module-instance or realm boundary where `instanceof`
 *   would not.
 * - `name` is what the provider itself checks. Inngest tests
 *   `err?.name === "NonRetriableError"` at both the step and the function
 *   level, which is the only reason throwing this *inside* a `step.run`
 *   callback stops the retry — the adapter's own translation sits outside the
 *   step and never sees it.
 *
 * Do not "tidy away" the `name` assignment. Without it, a throw from inside a
 * step is silently retried to exhaustion.
 */
export class NonRetriableError extends Error {
  public readonly isNonRetriable = true as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NonRetriableError";
  }
}
