/**
 * Thin client for the org-scoped /v1 API used by the env + secret commands.
 * Resolves auth + org/workspace scope from config (or OXAGEN_* env) and POSTs
 * to `${apiUrl}/v1/{org}/{workspace}/<path>`. Single place that talks HTTP so
 * commands stay declarative.
 */
import { getApiUrl, getOrgId, getToken, getWorkspaceId } from "./config.js";

interface ApiContext {
  apiUrl: string;
  token: string;
  org: string;
  ws: string;
}

function requireApiContext(): ApiContext {
  const token = getToken();
  const org = getOrgId();
  const ws = getWorkspaceId();
  if (!token || !org || !ws) {
    process.stderr.write(
      "Missing auth or scope. Run `oxagen login` to authenticate, or set " +
        "OXAGEN_API_TOKEN / OXAGEN_ORG_ID / OXAGEN_WORKSPACE_ID.\n",
    );
    process.exit(1);
  }
  return { apiUrl: getApiUrl(), token, org, ws };
}

/** POST an org-scoped capability and return the parsed JSON, or exit(1) on error. */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const { apiUrl, token, org, ws } = requireApiContext();
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/v1/${org}/${ws}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    process.stderr.write(`Network error calling ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    process.stderr.write(`Error ${res.status} from ${path}: ${text}\n`);
    process.exit(1);
  }
  return (await res.json()) as T;
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
