// retry.ts: the deadline, cancellation, and retry loop the MCP, HTTP, and
// GraphQL Senders share (mcp-studio-spec, Call path, Send).
//
// A call has one deadline, 30 seconds unless tools.toml sets deadline_ms, and
// every attempt, wait, and page of the call fits inside it. The caller's
// signal cancels the call at any point. The gRPC Sender in grpc/ keeps its own
// copy of these helpers, because M7 owns that folder.
import type { SendError } from "./sender";

/** The first attempt and 3 retries. */
export const MAX_ATTEMPTS = 4;

// setTimeout fires at once for a delay above 2^31 - 1 ms.
const MAX_TIMER_MS = 2_147_483_647;

/** The wait in milliseconds before retry n, where n is 1, 2, or 3: 100, 200, and 400. */
export function defaultBackoff(retry: number): number {
  return 100 * 2 ** (retry - 1);
}

export const CANCELLED: SendError = {
  title: "Cancelled",
  detail: "The call was cancelled before it finished.",
  status: undefined,
};

/** The error for a call that ran out of time. */
export function deadlineExceeded(deadline_ms: number): SendError {
  return { title: "Deadline exceeded", detail: `The call did not finish within ${deadline_ms} ms.`, status: undefined };
}

/**
 * The wait a Retry-After header asks for, in milliseconds: a number of
 * seconds, or an HTTP date. Undefined when the header is absent or unreadable,
 * so the caller falls back to its backoff. A date in the past waits 0.
 */
export function retryAfterMs(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Wait, or resolve false as soon as the signal aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      },
      Math.min(ms, MAX_TIMER_MS),
    );
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type Stop = "deadline" | "cancelled";
export type Raced<T> = { kind: "value"; value: T } | { kind: "failed"; error: unknown } | { kind: "stopped"; stop: Stop };

/**
 * The deadline and the caller's signal for one attempt.
 *
 * race() settles with the promise's result, or with the stop that comes
 * first. The clock holds one waiter at a time, so reading a long body does not
 * pile up a listener per chunk. A stop also aborts the attempt's signal, which
 * tells the Transport to cancel the request.
 */
export class Clock {
  private stop: Stop | undefined;
  private waiter: ((stop: Stop) => void) | undefined;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly signal: AbortSignal;
  private readonly controller: AbortController;
  private readonly onAbort = (): void => this.fire("cancelled");

  constructor(deadline: number, signal: AbortSignal, controller: AbortController) {
    this.signal = signal;
    this.controller = controller;
    this.timer = setTimeout(() => this.fire("deadline"), Math.min(Math.max(0, deadline - Date.now()), MAX_TIMER_MS));
    if (signal.aborted) this.fire("cancelled");
    else signal.addEventListener("abort", this.onAbort, { once: true });
  }

  race<T>(promise: Promise<T>): Promise<Raced<T>> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: Raced<T>): void => {
        if (settled) return;
        settled = true;
        this.waiter = undefined;
        resolve(result);
      };
      promise.then(
        (value) => settle({ kind: "value", value }),
        (error: unknown) => settle({ kind: "failed", error }),
      );
      if (this.stop === undefined) this.waiter = (stop) => settle({ kind: "stopped", stop });
      else settle({ kind: "stopped", stop: this.stop });
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.signal.removeEventListener("abort", this.onAbort);
  }

  private fire(stop: Stop): void {
    if (this.stop !== undefined) return;
    this.stop = stop;
    this.controller.abort();
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.(stop);
  }
}

/** The error a stop becomes. */
export function stopError(stop: Stop, deadline_ms: number): SendError {
  return stop === "cancelled" ? CANCELLED : deadlineExceeded(deadline_ms);
}

/**
 * One attempt's outcome. A failure carries retry when another attempt may
 * succeed, with the wait the upstream asked for, if any.
 */
export type Attempt<T> =
  | { ok: true; value: T }
  | { ok: false; error: SendError; retry?: { after_ms: number | undefined } };

export type Attempted<T> = { ok: true; value: T; attempts: number } | { ok: false; error: SendError; attempts: number };

export interface RetryPolicy {
  /** When the whole call must finish, in epoch milliseconds. */
  deadline: number;
  signal: AbortSignal;
  backoff_ms: (retry: number) => number;
}

/**
 * Run attempt until it succeeds, fails for good, or 4 attempts have run.
 * Each retry waits for the upstream's Retry-After or the backoff. A retry
 * that cannot start before the deadline is not tried, because it would only
 * fail again.
 */
export async function withRetries<T>(
  attempt: (number: number) => Promise<Attempt<T>>,
  policy: RetryPolicy,
): Promise<Attempted<T>> {
  for (let number = 1; ; number += 1) {
    const result = await attempt(number);
    if (result.ok) return { ok: true, value: result.value, attempts: number };
    if (result.retry === undefined || number >= MAX_ATTEMPTS) return { ok: false, error: result.error, attempts: number };
    const wait = result.retry.after_ms ?? policy.backoff_ms(number);
    if (Date.now() + wait >= policy.deadline) return { ok: false, error: result.error, attempts: number };
    if (!(await sleep(wait, policy.signal))) return { ok: false, error: CANCELLED, attempts: number };
    // A timer can fire late, so check the deadline again after the wait.
    if (Date.now() >= policy.deadline) return { ok: false, error: result.error, attempts: number };
  }
}
