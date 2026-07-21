/**
 * Thin client for the org-scoped /v1 API used by the env, secret, and memory
 * commands. Resolves auth + org/workspace scope from config (or OXAGEN_* env)
 * and POSTs to `${apiUrl}/v1/{org}/{workspace}/<path>`. Single place that talks
 * HTTP so commands stay declarative.
 *
 * Two call styles share one core:
 *   - `apiPost`        — exits the process with a friendly message on error.
 *     Right for one-shot CLI subcommands where a non-zero exit is the contract.
 *   - `apiPostOrThrow` — throws `ApiError` instead. Right for the interactive
 *     REPL, where a thrown error is caught and rendered into the TUI rather than
 *     tearing the whole session down with process.exit.
 */
import { getApiUrl, getToken, getOrgId, getWorkspaceId } from "./config.js";
import { debugLog } from "./debug-log.js";
import { stdoutWriter, type CommandWriter } from "./capture-writer.js";

interface ApiContext {
  apiUrl: string;
  token: string;
  org: string;
  ws: string;
}

/** A platform API failure (missing scope, network, or non-2xx) the caller can catch. */
export class ApiError extends Error {
  /** HTTP status when the failure was an API response; 0 for network/scope errors. */
  readonly status: number;
  /**
   * Provider request/trace id (`x-vercel-id`) when the failure was an HTTP
   * response, else undefined. This is the key to find the *server-side* stack:
   * a `FUNCTION_INVOCATION_FAILED` (or any 5xx) crashes on the server, so the
   * real filenames/line numbers live in the provider's logs, keyed by this id —
   * not on the client, which only ever sees the opaque 500 body.
   */
  readonly traceId?: string;
  constructor(message: string, status = 0, traceId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.traceId = traceId;
  }
}

/**
 * Response headers worth capturing for troubleshooting. `x-vercel-id` is the
 * single most valuable one: it's the request id you look up in the provider's
 * runtime logs to recover the server-side stack trace behind a 5xx, which the
 * client can never see locally. `x-vercel-error` names the platform failure
 * class (e.g. `FUNCTION_INVOCATION_FAILED`).
 */
const DIAGNOSTIC_HEADERS = [
  "x-vercel-id",
  "x-vercel-error",
  "x-vercel-cache",
  "x-oxagen-request-id",
  "content-type",
  "retry-after",
] as const;

/** Pull the troubleshooting-relevant headers off a response into a plain object. */
function diagnosticHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of DIAGNOSTIC_HEADERS) {
    const value = res.headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

/** A short, actionable pointer for common status classes, or undefined. */
function httpErrorHint(status: number, traceId?: string): string | undefined {
  if (status >= 500) {
    return (
      "Server-side error — the stack lives in the API's runtime logs, not here. " +
      (traceId
        ? `Look up request id "${traceId}" (its region prefix names the deployment): ` +
          "`vercel logs <deployment-url>` or the Vercel dashboard → Logs."
        : "Check the API deployment's runtime logs.")
    );
  }
  if (status === 401 || status === 403) {
    return "Auth/scope rejected. Re-check `oxagen login` or OXAGEN_API_TOKEN / OXAGEN_ORG_ID / OXAGEN_WORKSPACE_ID.";
  }
  if (status === 429) return "Rate limited — honor the retry-after header.";
  return undefined;
}

/**
 * Log a rich `error` entry for a non-2xx response and return the matching
 * `ApiError` for the caller to throw. Centralizes the diagnostics every request
 * site needs — full URL, method, status + statusText, latency, the diagnostic
 * response headers (incl. the `x-vercel-id` server-log pivot), the response
 * body, a local call stack, and a status-specific hint — so a single
 * `oxagen logs` entry tells an engineer exactly where to look next.
 *
 * The debug write is **awaited**, not fire-and-forget: one-shot commands call
 * `process.exit(1)` the instant this error propagates, and an un-awaited
 * `void debugLog(...)` append would be abandoned before it flushes — losing the
 * single most important entry (the error itself) on exactly the commands most
 * likely to fail. Callers do `throw await buildHttpError(...)` so the write
 * completes before the throw reaches the exit.
 */
async function buildHttpError(
  event: string,
  method: string,
  url: string,
  path: string,
  res: Response,
  startedAt: number,
): Promise<ApiError> {
  const body = await res.text().catch(() => res.statusText);
  const headers = diagnosticHeaders(res);
  const traceId = headers["x-vercel-id"];
  const hint = httpErrorHint(res.status, traceId);
  await debugLog("error", event, {
    method,
    url,
    path,
    status: res.status,
    statusText: res.statusText,
    durationMs: Date.now() - startedAt,
    headers,
    body,
    // Where in the CLI this request originated. The *server* stack is not here
    // (see ApiError.traceId) — this is the client-side call path only.
    callStack: new Error(`api ${event} ${res.status}`).stack,
    ...(hint ? { hint } : {}),
  });
  const suffix = traceId ? ` (trace ${traceId})` : "";
  return new ApiError(
    `Error ${res.status} from ${path}: ${body}${suffix}`,
    res.status,
    traceId,
  );
}

/**
 * Log a rich `error` entry for a network-layer failure and return the matching
 * `ApiError` for the caller to throw. Awaited for the same
 * flush-before-`process.exit` reason as {@link buildHttpError}.
 */
async function buildNetworkError(
  event: string,
  method: string,
  url: string,
  path: string,
  err: unknown,
  startedAt: number,
): Promise<ApiError> {
  await debugLog("error", event, {
    method,
    url,
    path,
    durationMs: Date.now() - startedAt,
    // `err` is sanitized to { name, message, stack } — filenames + line numbers
    // for a genuinely local failure (DNS, TLS, ECONNREFUSED, abort).
    error: err,
    hint: "Network/transport failure before an HTTP response. Check connectivity, the API base URL, and any proxy.",
  });
  return new ApiError(
    `Network error calling ${path}: ${err instanceof Error ? err.message : String(err)}`,
  );
}

const NOT_LOGGED_IN =
  "Not logged in. Run `oxagen login` to authenticate, or set " +
  "OXAGEN_API_TOKEN / OXAGEN_ORG_ID / OXAGEN_WORKSPACE_ID.";

/** Resolve auth + scope, or null when any of token / org / workspace is absent. */
export function resolveApiContext(): ApiContext | null {
  const token = getToken();
  const org = getOrgId();
  const ws = getWorkspaceId();
  if (!token || !org || !ws) return null;
  return { apiUrl: getApiUrl(), token, org, ws };
}

/**
 * Resolve scope or fail loudly. `writer` controls the failure contract: the
 * default (real stdout/stderr) means "one-shot CLI" and exits the process —
 * the historical contract for `oxagen <cmd>`. Any other writer (the REPL's
 * capture accumulator) means we're running *inside* the Ink-mounted REPL,
 * where `process.exit` would tear down the whole session — so it throws
 * `ApiError` instead, which the REPL's capture-execution seam always wraps in
 * a try/catch and renders as an assistant message.
 */
function requireApiContext(writer: CommandWriter = stdoutWriter): ApiContext {
  const ctx = resolveApiContext();
  if (!ctx) {
    writer.writeErr(NOT_LOGGED_IN);
    if (writer === stdoutWriter) process.exit(1);
    throw new ApiError(NOT_LOGGED_IN);
  }
  return ctx;
}

/**
 * GET an org-scoped capability and return the parsed JSON. Throws `ApiError`
 * on missing scope, network failure, or a non-2xx response — never exits.
 */
export async function apiGetOrThrow<T>(
  path: string,
  query?: Record<string, unknown>,
): Promise<T> {
  const ctx = resolveApiContext();
  if (!ctx) throw new ApiError(NOT_LOGGED_IN);
  const url = new URL(`${ctx.apiUrl}/v1/${ctx.org}/${ctx.ws}/${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) {
        url.searchParams.append(key, String(value));
      }
    }
  }
  void debugLog("api", "api.get.request", {
    method: "GET",
    url: url.toString(),
    path,
    query,
  });
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ctx.token}`,
      },
    });
  } catch (err) {
    throw await buildNetworkError(
      "api.get.network",
      "GET",
      url.toString(),
      path,
      err,
      startedAt,
    );
  }
  if (!res.ok) {
    throw await buildHttpError(
      "api.get.response",
      "GET",
      url.toString(),
      path,
      res,
      startedAt,
    );
  }
  const json = (await res.json()) as T;
  void debugLog("api", "api.get.response", {
    path,
    status: res.status,
    durationMs: Date.now() - startedAt,
    body: json,
  });
  return json;
}

/**
 * POST a user-scoped capability (token-only, no org/workspace) and return the
 * parsed JSON. Throws `ApiError` on missing token, network failure, or a
 * non-2xx response — never exits.
 */
export async function userApiPostOrThrow<T>(
  path: string,
  body: unknown,
): Promise<T> {
  const token = getToken();
  if (!token) throw new ApiError(NOT_LOGGED_IN);
  const apiUrl = getApiUrl();
  const url = `${apiUrl}/v1/user/${path}`;
  void debugLog("api", "api.user-post.request", {
    method: "POST",
    url,
    path,
    body,
  });
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    throw await buildNetworkError(
      "api.user-post.network",
      "POST",
      url,
      path,
      err,
      startedAt,
    );
  }
  if (!res.ok) {
    throw await buildHttpError(
      "api.user-post.response",
      "POST",
      url,
      path,
      res,
      startedAt,
    );
  }
  const json = (await res.json()) as T;
  void debugLog("api", "api.user-post.response", {
    path,
    status: res.status,
    durationMs: Date.now() - startedAt,
    body: json,
  });
  return json;
}

/**
 * POST an org-scoped capability and return the parsed JSON. Throws `ApiError`
 * on missing scope, network failure, or a non-2xx response — never exits.
 */
export async function apiPostOrThrow<T>(
  path: string,
  body: unknown,
): Promise<T> {
  const ctx = resolveApiContext();
  if (!ctx) throw new ApiError(NOT_LOGGED_IN);
  const url = `${ctx.apiUrl}/v1/${ctx.org}/${ctx.ws}/${path}`;
  void debugLog("api", "api.post.request", { method: "POST", url, path, body });
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    throw await buildNetworkError(
      "api.post.network",
      "POST",
      url,
      path,
      err,
      startedAt,
    );
  }
  if (!res.ok) {
    throw await buildHttpError(
      "api.post.response",
      "POST",
      url,
      path,
      res,
      startedAt,
    );
  }
  const json = (await res.json()) as T;
  void debugLog("api", "api.post.response", {
    path,
    status: res.status,
    durationMs: Date.now() - startedAt,
    body: json,
  });
  return json;
}

/**
 * POST an org-scoped capability and return the parsed JSON, or exit(1) on
 * error — UNLESS `writer` is a non-default (capture) writer, in which case it
 * throws `ApiError` instead so the REPL's inline capture-execution seam can
 * catch it and render an assistant message instead of killing the session.
 * Default (`stdoutWriter`) preserves the original one-shot CLI contract
 * exactly — every existing `apiPost(path, body)` call site is unaffected.
 */
export async function apiPost<T>(
  path: string,
  body: unknown,
  writer: CommandWriter = stdoutWriter,
): Promise<T> {
  // Keep the exit-on-error contract for the env/secret subcommands by resolving
  // scope eagerly (exits with the standard message) then delegating to the core.
  requireApiContext(writer);
  try {
    return await apiPostOrThrow<T>(path, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writer.writeErr(message);
    if (writer === stdoutWriter) process.exit(1);
    throw err instanceof ApiError ? err : new ApiError(message);
  }
}

/** Print rows as an aligned text table (human mode). */
export function printTable(
  headers: string[],
  rows: string[][],
  writer: CommandWriter = stdoutWriter,
): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ");
  writer.write(fmt(headers));
  for (const r of rows) writer.write(fmt(r));
}
