// get_assistant_engine: the honest engine-down read (ADR-053 §4; Mockups
// origin/main mc.html 10636-10660). Three probes of the engine's own
// readiness route with a two-second connect timeout each, and the answer
// names what was observed. Nothing here starts a turn or falls back to an
// in-process loop; the incident field is null because rev1 has no incident
// store (apps/app/ARCHITECTURE.md §1.2).
import type { AssistantEngineGetOutput } from "@oxagen/oxagen/contracts/assistant.engine.get";
import type { StellaEngineClient } from "@oxagen/stella-engine-client";
import {
  EngineUnavailableError,
  engineClientFromEnv,
} from "../runtime/engine/client";
import type { CapabilityContext } from "../types";

export const ENGINE_PROBE_ATTEMPTS = 3;
export const ENGINE_PROBE_TIMEOUT_MS = 2000;

/**
 * Backoff between attempts, doubling from here. Three attempts fired back to
 * back at a two-second ceiling are three requests in six seconds at a server
 * that is already failing to answer in two; the wait is what makes a retry a
 * retry rather than a second load.
 */
export const ENGINE_PROBE_BACKOFF_MS = 250;

/** Full jitter on the backoff, so N callers probing at once do not re-converge. */
export const ENGINE_PROBE_JITTER = 0.5;

/** The probe's seams: the client (or none, when unconfigured), the clock, the sleep and the jitter. */
export interface EngineProbeDeps {
  client: () => StellaEngineClient;
  now: () => Date;
  /** Test seam; production waits on a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam; production reads Math.random. */
  random?: () => number;
}

export function createAssistantEngineProbe(deps: EngineProbeDeps) {
  return async (
    _input: unknown,
    _ctx: CapabilityContext,
  ): Promise<AssistantEngineGetOutput> => {
    let client: StellaEngineClient;
    try {
      client = deps.client();
    } catch (err) {
      return {
        state: "unconfigured",
        endpoint: null,
        attempts: 0,
        error:
          err instanceof EngineUnavailableError ? err.code : "unconfigured",
        checkedAt: deps.now().toISOString(),
        incident: null,
      };
    }
    const endpoint = endpointOf(client.baseUrl);
    const sleep = deps.sleep ?? defaultSleep;
    const random = deps.random ?? Math.random;
    let lastError = "unreachable";
    for (let attempt = 1; attempt <= ENGINE_PROBE_ATTEMPTS; attempt += 1) {
      // A fresh controller per attempt: the timeout branch aborts the request
      // it gave up on, so a degraded engine answering in ten seconds is not
      // left holding three orphaned requests per caller.
      const controller = new AbortController();
      try {
        const ready = await withTimeout(
          client.ready({ signal: controller.signal }),
          ENGINE_PROBE_TIMEOUT_MS,
          () => controller.abort(),
        );
        return {
          state: reportedState(ready.state),
          endpoint,
          attempts: attempt,
          error: null,
          checkedAt: deps.now().toISOString(),
          incident: null,
        };
      } catch (err) {
        lastError = errorCode(err);
        if (attempt < ENGINE_PROBE_ATTEMPTS) {
          const ceiling = ENGINE_PROBE_BACKOFF_MS * 2 ** (attempt - 1);
          await sleep(
            Math.round(ceiling * (1 - ENGINE_PROBE_JITTER * random())),
          );
        }
      }
    }
    return {
      state: "unreachable",
      endpoint,
      attempts: ENGINE_PROBE_ATTEMPTS,
      error: lastError,
      checkedAt: deps.now().toISOString(),
      incident: null,
    };
  };
}

export const assistantEngineGetHandler = createAssistantEngineProbe({
  client: () => engineClientFromEnv(),
  now: () => new Date(),
});

/** The engine's word for its state; a word this client does not know reads as unreachable. */
function reportedState(
  state: string,
): "ready" | "starting" | "draining" | "unreachable" {
  return state === "ready" || state === "starting" || state === "draining"
    ? state
    : "unreachable";
}

function endpointOf(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return baseUrl;
  }
}

/** The error's code when it has one (`ECONNREFUSED`, `engine_unavailable`), else its name. */
function errorCode(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code =
      (err as { code?: unknown; cause?: { code?: unknown } }).code ??
      (err as { cause?: { code?: unknown } }).cause?.code;
    if (typeof code === "string") return code;
    if (err instanceof Error) return err.name;
  }
  return "unreachable";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reject on the timer, and tell the caller so it can end the work it is no
 * longer waiting for. `onTimeout` runs before the rejection: a timeout that
 * does not abort is a timeout that only hides the request.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(
        Object.assign(new Error(`engine probe timed out after ${ms} ms`), {
          code: "ETIMEDOUT",
        }),
      );
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
