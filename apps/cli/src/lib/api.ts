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
import { getApiUrl, getOrgId, getToken, getWorkspaceId } from "./config.js";

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

/** Resolve auth + scope, or null when any of token / org / workspace is absent. */
export function resolveApiContext(): ApiContext | null {
  const token = getToken();
  const org = getOrgId();
  const ws = getWorkspaceId();
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
 * POST an org-scoped capability and return the parsed JSON. Throws `ApiError`
 * on missing scope, network failure, or a non-2xx response — never exits.
 */
export async function apiPostOrThrow<T>(path: string, body: unknown): Promise<T> {
  const ctx = resolveApiContext();
  if (!ctx) throw new ApiError(NOT_LOGGED_IN);
  let res: Response;
  try {
    res = await fetch(`${ctx.apiUrl}/v1/${ctx.org}/${ctx.ws}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    throw new ApiError(
      `Network error calling ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new ApiError(`Error ${res.status} from ${path}: ${text}`, res.status);
  }
  return (await res.json()) as T;
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
