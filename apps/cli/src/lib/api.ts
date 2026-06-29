/**
 * Thin client for the /v1 API used by the env, secret, memory, and linker
 * commands. Single place that talks HTTP so commands stay declarative.
 *
 * Three call styles share one core:
 *   - `apiPost`            — exits the process with a friendly message on error.
 *     Right for one-shot CLI subcommands where a non-zero exit is the contract.
 *   - `apiPostOrThrow`     — POST to `${apiUrl}/v1/{org}/{ws}/{path}` (org+ws
 *     scoped). Throws `ApiError` on missing scope / network failure / non-2xx.
 *     Right for the REPL, where a thrown error is caught and rendered into the
 *     TUI rather than tearing the whole session down with process.exit.
 *   - `userApiPostOrThrow` — POST to `${apiUrl}/v1/{path}` with ONLY the Bearer
 *     token (no org/ws scope). Used for pre-org calls such as org.list and
 *     workspace.list — the routes the linker hits before an org is chosen.
 *   - `apiGetOrThrow`      — GET to `${apiUrl}/v1/{org}/{ws}/{path}?{params}`.
 *     Org+ws scoped, used for GET-based endpoints (e.g. connection.list).
 *
 * Scope resolution in resolveApiContext()
 * ─────────────────────────────────────────
 * Precedence (lowest → highest):
 *   global config  (~/.config/oxagen/config.json orgSlug / workspaceSlug)
 *   project link   (.oxagen/workspace.json in process.cwd())
 *   env vars       (OXAGEN_ORG_ID / OXAGEN_WORKSPACE_ID)
 *
 * This means `oxagen init` and per-project commands automatically use the
 * workspace linked by `oxagen init --link`, with no extra flags required.
 */
import { readConfig, getApiUrl, getToken } from "./config.js";
import { readWorkspaceLink } from "./workspace-link.js";

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
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const NOT_LOGGED_IN =
  "Not logged in. Run `oxagen login` to authenticate, or set " +
  "OXAGEN_API_TOKEN / OXAGEN_ORG_ID / OXAGEN_WORKSPACE_ID.";

const NOT_AUTHED =
  "Not logged in. Run `oxagen login`.";

/**
 * Resolve auth + scope, or null when any of token / org / workspace is absent.
 *
 * Resolution order for org/ws:
 *   env (OXAGEN_ORG_ID / OXAGEN_WORKSPACE_ID)
 *   → .oxagen/workspace.json in process.cwd()  (project workspace link)
 *   → global config (~/.config/oxagen/config.json)
 */
export function resolveApiContext(): ApiContext | null {
  const token = getToken();
  const config = readConfig();
  const link = readWorkspaceLink(process.cwd());

  const org =
    process.env["OXAGEN_ORG_ID"] ??
    link?.orgSlug ??
    config.orgSlug;

  const ws =
    process.env["OXAGEN_WORKSPACE_ID"] ??
    link?.workspaceSlug ??
    config.workspaceSlug;

  if (!token || !org || !ws) return null;
  return { apiUrl: getApiUrl(), token, org, ws };
}

function requireApiContext(): ApiContext {
  const ctx = resolveApiContext();
  if (!ctx) {
    process.stderr.write(`${NOT_LOGGED_IN}\n`);
    process.exit(1);
  }
  return ctx;
}

/**
 * Core fetch helper shared by all call styles. Accepts the full URL and
 * headers; throws ApiError on network failure or non-2xx.
 */
async function coreRequest<T>(
  url: string,
  method: "GET" | "POST" | "PUT",
  headers: Record<string, string>,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError(
      `Network error calling ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new ApiError(`Error ${res.status} from ${url}: ${text}`, res.status);
  }
  return (await res.json()) as T;
}

/**
 * POST an org-scoped capability and return the parsed JSON. Throws `ApiError`
 * on missing scope, network failure, or a non-2xx response — never exits.
 */
export async function apiPostOrThrow<T>(path: string, body: unknown): Promise<T> {
  const ctx = resolveApiContext();
  if (!ctx) throw new ApiError(NOT_LOGGED_IN);
  return coreRequest<T>(
    `${ctx.apiUrl}/v1/${ctx.org}/${ctx.ws}/${path}`,
    "POST",
    {
      Authorization: `Bearer ${ctx.token}`,
      "Content-Type": "application/json",
    },
    body ?? {},
  );
}

/**
 * GET an org-scoped endpoint and return the parsed JSON. Throws `ApiError`
 * on missing scope, network failure, or a non-2xx response — never exits.
 *
 * `params` is appended as a query string. Pass `undefined` for no params.
 */
export async function apiGetOrThrow<T>(
  path: string,
  params?: Record<string, string | undefined>,
): Promise<T> {
  const ctx = resolveApiContext();
  if (!ctx) throw new ApiError(NOT_LOGGED_IN);
  let url = `${ctx.apiUrl}/v1/${ctx.org}/${ctx.ws}/${path}`;
  if (params) {
    const qs = new URLSearchParams(
      Object.entries(params).flatMap(([k, v]) => (v !== undefined ? [[k, v]] : [])),
    ).toString();
    if (qs) url += `?${qs}`;
  }
  return coreRequest<T>(url, "GET", {
    Authorization: `Bearer ${ctx.token}`,
    Accept: "application/json",
  });
}

/**
 * POST a user-level (pre-org) capability and return the parsed JSON.
 * Hits `${apiUrl}/v1/${path}` with ONLY the Bearer token — no org/workspace
 * in the path. Used for org.list and workspace.list.
 * Throws `ApiError` when the token is absent or the call fails.
 */
export async function userApiPostOrThrow<T>(
  path: string,
  body: unknown,
): Promise<T> {
  const token = getToken();
  if (!token) throw new ApiError(NOT_AUTHED);
  return coreRequest<T>(
    `${getApiUrl()}/v1/${path}`,
    "POST",
    {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body ?? {},
  );
}

/** POST an org-scoped capability and return the parsed JSON, or exit(1) on error. */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  // Keep the exit-on-error contract for the env/secret subcommands by resolving
  // scope eagerly (exits with the standard message) then delegating to the core.
  requireApiContext();
  try {
    return await apiPostOrThrow<T>(path, body);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

/** Print rows as an aligned text table (human mode). */
export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ");
  process.stdout.write(fmt(headers) + "\n");
  for (const r of rows) process.stdout.write(fmt(r) + "\n");
}
