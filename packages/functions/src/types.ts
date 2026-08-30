/**
 * @oxagen/functions - Provider-agnostic durable function interfaces.
 *
 * These types define the contract for durable function execution without
 * coupling to any specific provider (Inngest, Temporal, custom AWS, etc.).
 * Product code imports from this package; provider adapters implement these
 * interfaces against concrete SDKs.
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
  /** Optional expression to match event data fields (e.g. "data.fanoutId"). */
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
   */
  run<T>(name: string, fn: () => T | Promise<T>): Promise<T>;

  /**
   * Dispatch one or more events from within a step. The label identifies
   * this send operation for idempotency.
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
   * Sleep for the specified duration. Accepts either a duration string
   * (e.g. "30s", "5m") or an ISO-8601 date string / Date indicating
   * when to wake.
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
  /** Optional key expression to scope concurrency (e.g. per-tenant). */
  key?: string;
}

/**
 * A cancellation trigger: the function is cancelled when this event arrives
 * and the optional condition matches.
 */
export interface CancelOnConfig {
  /** Event name that triggers cancellation. */
  event: string;
  /** Optional condition expression (e.g. "event.data.executionId == async.data.executionId"). */
  if?: string;
}

/**
 * Configuration for a durable function definition.
 */
export interface DurableFunctionConfig {
  /** Unique function identifier (used for routing and observability). */
  id: string;
  /** Number of retry attempts on failure. */
  retries?: number;
  /** Concurrency limits for this function. */
  concurrency?: ConcurrencyConfig;
  /** Events that trigger automatic cancellation of in-flight runs. */
  cancelOn?: CancelOnConfig[];
  /** Timeout configuration for the function run. */
  timeouts?: { finish?: string };
  /** Optional failure handler invoked when the function exhausts retries. */
  onFailure?: DurableFunctionHandler;
  /**
   * Batch many trigger events into a single function run. When set, the
   * provider collects up to `maxSize` matching events (or waits `timeout`,
   * e.g. "30s") and invokes the handler once with all of them exposed on
   * `ctx.events`. `key` (a CEL expression like "event.data.orgId") batches
   * per-key so a run never mixes tenants. Used for cost-efficient bulk
   * inference (e.g. one Anthropic Message Batch per collected event set).
   */
  batchEvents?: { maxSize: number; timeout: string; key?: string };
}

// ─── Function Trigger ────────────────────────────────────────────────────────

/**
 * A function trigger: either event-driven or cron-scheduled.
 */
export type DurableFunctionTrigger =
  | { event: string; cron?: never }
  | { cron: string; event?: never };

// ─── Function Handler ────────────────────────────────────────────────────────

/**
 * The context object passed to a durable function handler at invocation time.
 */
export interface DurableFunctionHandlerContext {
  /** The triggering event (present for event-triggered functions). */
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
   */
  send(event: EventPayload | EventPayload[]): Promise<void>;
}

// ─── Factory Type ────────────────────────────────────────────────────────────

/**
 * Factory function signature for creating durable functions from abstract
 * configuration. Provider adapters implement this to translate abstract
 * definitions into provider-native function objects.
 */
export type CreateFunctionFactory = (
  config: DurableFunctionConfig,
  trigger: DurableFunctionTrigger,
  handler: DurableFunctionHandler,
) => DurableFunction[];

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Throw this error to permanently fail a function without retries.
 * Provider adapters translate this into their own non-retriable error type.
 */
export class NonRetriableError extends Error {
  public readonly isNonRetriable = true as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NonRetriableError";
  }
}
