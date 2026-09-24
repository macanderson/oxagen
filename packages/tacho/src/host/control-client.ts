/**
 * The host's HTTPS client to the control plane (spec section 3.1 steps 3
 * and 4; section 7.4). Three machine-to-machine calls, each authenticated by
 * the host API key and validated against the wire schemas. `fetch` is
 * injected so tests run against a fake control plane.
 */
import {
  type BundleResponse,
  bundleResponseSchema,
  type CommandAcknowledgement,
  type CommandsResponse,
  commandsResponseSchema,
  type DaemonHealth,
  type IngestResponse,
  ingestResponseSchema,
  TACHO_BATCH_SCHEMA,
  TACHO_COMMANDS_SCHEMA,
  type TachoBatch,
} from "../wire";

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  /**
   * Optional so every existing fake control plane in the tests stays valid.
   * A real `fetch` always provides it, and without it the client simply has
   * no rate-limit hint to pass on and falls back to blind backoff.
   */
  headers?: { get: (name: string) => string | null };
}>;

/**
 * What the control plane said about our budget on the last response.
 *
 * The API sets `X-RateLimit-Remaining` / `X-RateLimit-Reset` on every counted
 * response and `Retry-After` on a 429, and the daemon used to ignore all three
 * and guess with exponential backoff instead. Guessing is strictly worse than
 * being told: a blind 60s sleep can idle through a window that resets in five
 * seconds, and a blind retry can spend a budget the server has already said is
 * gone. Every field is optional because a hint is an optimisation — the client
 * must work against a server, or a test double, that sends none of them.
 */
export interface RateLimitHint {
  /** Requests left in the current window. */
  remaining?: number;
  /** When the window resets, epoch milliseconds. */
  resetAtMs?: number;
  /** How long the server asked us to wait, milliseconds. */
  retryAfterMs?: number;
}

/** Seconds, or an HTTP-date, to milliseconds from now. Undefined if neither. */
function parseRetryAfter(
  value: string | null,
  nowMs: number,
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/**
 * A numeric header, or undefined when it is absent or not a number.
 * `Number(null)` and `Number("")` are both 0, which read a missing
 * `X-RateLimit-Remaining` as a spent budget and held the drain to one batch
 * per tick.
 */
function headerNumber(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readRateLimitHint(
  headers: { get: (name: string) => string | null } | undefined,
  nowMs: number,
): RateLimitHint | undefined {
  if (!headers) return undefined;
  const hint: RateLimitHint = {};
  const remaining = headerNumber(headers.get("x-ratelimit-remaining"));
  if (remaining !== undefined) hint.remaining = remaining;
  // X-RateLimit-Reset is epoch SECONDS (see the API middleware), not a delta.
  const reset = headerNumber(headers.get("x-ratelimit-reset"));
  if (reset !== undefined && reset > 0) hint.resetAtMs = reset * 1000;
  const retryAfter = parseRetryAfter(headers.get("retry-after"), nowMs);
  if (retryAfter !== undefined) hint.retryAfterMs = retryAfter;
  return Object.keys(hint).length > 0 ? hint : undefined;
}

/** How long a host waits for one ingest batch before it retries it. */
export const TACHO_INGEST_TIMEOUT_MS = 60_000;

export class ControlError extends Error {
  readonly status: number;
  readonly body: string;
  /**
   * What the server said about waiting, when it said anything. Carried on the
   * error so the Shipper can honour a 429's `Retry-After` instead of doubling
   * its own backoff past the window the server actually named.
   */
  readonly rateLimit: RateLimitHint | undefined;
  constructor(
    status: number,
    body: string,
    message?: string,
    rateLimit?: RateLimitHint,
  ) {
    super(message ?? `control plane answered ${status}: ${body.slice(0, 256)}`);
    this.name = "ControlError";
    this.status = status;
    this.body = body;
    this.rateLimit = rateLimit;
  }
}

export class ControlUnreachable extends Error {
  constructor(cause: unknown) {
    super(
      `control plane unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "ControlUnreachable";
  }
}

export interface ControlClientOptions {
  endpoints: { ingest: string; bundle: string; commands: string };
  apiKey: string;
  hostEnrollmentId: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /**
   * The bound on an ingest call alone, longer than `timeoutMs`. The route
   * writes every body in the batch before it answers, and bounds each write
   * at 30 seconds itself, so a host that gave up at 15 abandoned batches the
   * server went on to commit, then sent them again behind its backoff.
   */
  ingestTimeoutMs?: number;
  userAgent?: string;
  /**
   * Called after every response that carried rate-limit headers, success or
   * failure. The Shipper uses it to pace a backlog drain against the budget
   * the server reports, rather than firing every queued batch at once and
   * discovering the ceiling by being refused.
   */
  onRateLimit?: (hint: RateLimitHint) => void;
  /** Injectable clock, so Retry-After parsing is testable. */
  now?: () => number;
}

export interface ControlClient {
  /**
   * Ship one batch. `bodies` are the frame bodies of events IN THIS BATCH:
   * the control plane refuses a body naming an event it did not receive in
   * the same request (`unknown_event`), so a body never rides a later one.
   */
  ingest: (
    events: TachoBatch["events"],
    daemon?: DaemonHealth,
    /** Redacted bodies for events in this batch, at most one per event. */
    bodies?: TachoBatch["bodies"],
  ) => Promise<IngestResponse>;
  bundle: (etag?: string) => Promise<BundleResponse>;
  commands: (
    acknowledgements?: CommandAcknowledgement[],
    daemon?: Omit<DaemonHealth, "spool_oldest_at" | "bundle_etag">,
  ) => Promise<CommandsResponse>;
}

export function createControlClient(
  options: ControlClientOptions,
): ControlClient {
  const fetchImpl: FetchLike =
    options.fetch ?? ((input, init) => fetch(input, init) as never);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const ingestTimeoutMs = options.ingestTimeoutMs ?? TACHO_INGEST_TIMEOUT_MS;
  const nowMs = options.now ?? Date.now;

  async function post(
    url: string,
    body: unknown,
    boundMs: number = timeoutMs,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), boundMs);
    let response: Awaited<ReturnType<FetchLike>>;
    let text: string;
    try {
      // `clearTimeout` used to run in a `finally` scoped to this fetch call
      // alone, so the abort timer was disarmed the instant headers arrived —
      // before `response.text()` ever ran. A response whose body stalled
      // (a slow or wedged connection past the headers) then had nothing
      // bounding it: `post` never resolved, `shipOnce` never returned, and
      // the daemon's `ticking` guard (the interval driver skips a tick that
      // overlaps the one before it) stopped every later tick behind it,
      // wedging the whole ship path on one hung request. The timeout now
      // covers the read as well as the connect, and either half aborting
      // reports the same `ControlUnreachable` the caller already retries.
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": options.userAgent ?? "tachod",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      throw new ControlUnreachable(error);
    } finally {
      clearTimeout(timer);
    }
    const hint = readRateLimitHint(response.headers, nowMs());
    if (hint) options.onRateLimit?.(hint);
    if (!response.ok)
      throw new ControlError(response.status, text, undefined, hint);
    try {
      return JSON.parse(text);
    } catch {
      throw new ControlError(
        response.status,
        text,
        "control plane answered non-JSON",
        hint,
      );
    }
  }

  return {
    ingest: async (events, daemon, bodies) =>
      ingestResponseSchema.parse(
        await post(
          options.endpoints.ingest,
          {
            schema: TACHO_BATCH_SCHEMA,
            host_enrollment_id: options.hostEnrollmentId,
            events,
            ...(bodies !== undefined && bodies.length > 0 ? { bodies } : {}),
            ...(daemon !== undefined ? { daemon } : {}),
          },
          ingestTimeoutMs,
        ),
      ),
    bundle: async (etag) =>
      bundleResponseSchema.parse(
        await post(options.endpoints.bundle, {
          host_enrollment_id: options.hostEnrollmentId,
          ...(etag !== undefined ? { etag } : {}),
        }),
      ),
    commands: async (acknowledgements = [], daemon) =>
      commandsResponseSchema.parse(
        await post(options.endpoints.commands, {
          schema: TACHO_COMMANDS_SCHEMA,
          host_enrollment_id: options.hostEnrollmentId,
          acknowledgements,
          ...(daemon !== undefined ? { daemon } : {}),
        }),
      ),
  };
}
