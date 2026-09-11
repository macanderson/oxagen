/**
 * Where the engine is, and whether it is there.
 *
 * `STELLA_SERVE_URL` and `STELLA_SERVE_TOKEN` name the `stella-serve`
 * container the in-app agent runs on (ADR-053 §1). There is no fallback when
 * it is absent: ADR-053 §4 says a silent in-process substitute would be the
 * second copy of the loop the ADR exists to prevent, so the runtime says
 * plainly that the engine is unavailable and the surface shows that.
 */
import { requireEnv } from "@oxagen/config/env";
import {
  EngineHttpError,
  StellaEngineClient,
} from "@oxagen/stella-engine-client";

/** The message every surface shows when a turn cannot reach the engine. */
export const ENGINE_UNAVAILABLE_MESSAGE = "the assistant engine is unavailable";

/**
 * The engine could not be reached, is not ready, or is not configured. Carries
 * a stable `code` so a surface can map it to its own error shape.
 */
export class EngineUnavailableError extends Error {
  override readonly name = "EngineUnavailableError";
  readonly code = "engine_unavailable" as const;
  constructor(
    readonly reason: string,
    cause?: unknown,
  ) {
    super(`${ENGINE_UNAVAILABLE_MESSAGE}: ${reason}`, { cause });
  }
}

/**
 * Whether an error from the client means the engine is down rather than the
 * turn being refused: a connection failure, a 503 while starting or
 * draining, or a 401, which is a token mismatch between the two containers
 * and is an operator's problem, not the user's.
 */
export function isEngineUnavailable(err: unknown): boolean {
  if (err instanceof EngineUnavailableError) return true;
  if (err instanceof EngineHttpError)
    return err.status === 503 || err.status === 401;
  if (typeof err === "object" && err !== null) {
    const code =
      (err as { code?: unknown; cause?: { code?: unknown } }).code ??
      (err as { cause?: { code?: unknown } }).cause?.code;
    return (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ENOTFOUND" ||
      code === "UND_ERR_SOCKET" ||
      code === "UND_ERR_CONNECT_TIMEOUT"
    );
  }
  return false;
}

/**
 * The engine client from the environment. Throws `EngineUnavailableError`
 * when the token is unset, which is the configuration that ADR-053 names as
 * required rather than optional.
 */
export function engineClientFromEnv(
  fetchImpl?: typeof fetch,
): StellaEngineClient {
  const { STELLA_SERVE_URL, STELLA_SERVE_TOKEN } = requireEnv([
    "STELLA_SERVE_URL",
    "STELLA_SERVE_TOKEN",
  ] as const);
  if (!STELLA_SERVE_TOKEN) {
    throw new EngineUnavailableError("STELLA_SERVE_TOKEN is not set");
  }
  return new StellaEngineClient({
    baseUrl: STELLA_SERVE_URL,
    token: STELLA_SERVE_TOKEN,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
