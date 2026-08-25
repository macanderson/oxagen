/**
 * workspace-servers.ts — Bridge that makes DB-backed, workspace-installed MCP
 * servers usable from the CLI agent loop.
 *
 * ## The gap this closes (Defect 5)
 *
 * The CLI's own MCP client (`./client.ts`) only ever read servers from the
 * file-based `settings.json` `mcpServers` map. Servers a user installs through
 * the web app live in the platform DB (`mcp.mcp_servers` + `plugin.installed_plugins`)
 * with credentials encrypted at rest in `mcp.credentials`; the CLI never reached
 * them. This module fetches those servers from the platform, synthesizes
 * `McpServerConfig` entries the CLI client already knows how to connect, and
 * supplies a `remoteFetch` that resolves each server's credential — so a server
 * a user authenticated in the app becomes usable from the CLI turn, honoring all
 * three auth kinds (none / secret-bearer / oauth).
 *
 * ## Security design — why the CLI receives a resolved bearer (not a proxy)
 *
 * The IDEAL isolation is a server-side call-proxy: the CLI would ask the platform
 * to list/execute tools and the raw workspace credential would never leave the
 * server. We deliberately did NOT take that route here because:
 *
 *   1. The platform already resolves + decrypts the credential SERVER-SIDE. The
 *      CLI only ever receives the final usable access token / headers — never the
 *      ciphertext, the KMS key, or (for oauth) the refresh token. Token exchange
 *      and refresh stay entirely on the platform.
 *   2. The token is delivered over TLS on the CLI's OWN authenticated channel
 *      (its workspace API token). The same workspace member is already entitled
 *      to use these servers in the app, so no new trust boundary is crossed.
 *   3. It reuses the pre-built `remoteFetch` seam in @oxagen/mcp-config and the
 *      CLI's existing per-server connect / visibility / permission machinery,
 *      instead of re-implementing descriptor-pinning + tool execution outside the
 *      shared runtime.
 *   4. Hardening: these credentials are NEVER written to the CLI's credential
 *      cache (`resolveCredential({ persistRemote: false })`). They live in memory
 *      for the turn only and are re-resolved (fresh) next turn.
 *
 * A full server-side proxy remains the stronger long-term design; it is a known
 * follow-up, not implemented here.
 */
import {
  mcpServerSchema,
  type McpServerConfig,
} from "@oxagen/mcp-config/schema";
import type { StoredCredential } from "@oxagen/mcp-config/credentials";
import { apiGetOrThrow, resolveApiContext } from "../lib/api.js";

/**
 * One workspace-installed MCP server as resolved by the platform
 * `resolve_mcp_servers` capability. `token` / `headers` are the credential the
 * platform decrypted for THIS workspace; `needsReauth` flags an oauth/secret
 * server whose stored credential is missing or must be re-authenticated in the
 * app.
 */
export interface WorkspaceMcpServer {
  publicId: string;
  name: string;
  transportType: "streamable-http" | "stdio";
  endpointUrl: string;
  authStrategy: "none" | "bearer" | "header";
  authKind: "oauth" | "secret" | "none";
  token: string | null;
  headers: Record<string, string> | null;
  needsReauth: boolean;
}

interface ResolveMcpServersResponse {
  servers: WorkspaceMcpServer[];
}

/** The org-scoped API path the platform mounts `resolve_mcp_servers` at. */
const RESOLVE_PATH = "agent/mcp-servers/resolve";

/**
 * Fetch the workspace's installed MCP servers (with platform-resolved
 * credentials) from the API. Best-effort: returns `[]` when the CLI is not
 * logged in or the call fails, so a network hiccup or a logged-out session
 * never breaks the turn — file-based servers still load.
 *
 * `fetcher` is injectable so tests exercise the merge/remote-fetch logic without
 * a live API.
 */
export async function fetchWorkspaceMcpServers(
  fetcher?: (path: string) => Promise<ResolveMcpServersResponse>,
): Promise<WorkspaceMcpServer[]> {
  // buildTurnExtras calls this (directly and via runOneShot) from many hermetic
  // unit tests; the DEFAULT network fetcher would make those non-deterministic
  // and can hang the worker. Disable ONLY the default fetcher under the test
  // runner — checked FIRST so we don't even touch config/auth resolution — while
  // an explicitly injected `fetcher` (the bridge's own tests) still runs and
  // production (no VITEST) is unaffected.
  if (!fetcher && process.env.VITEST) return [];
  // No token/org/workspace ⇒ nothing to fetch. Skip the network entirely.
  if (!resolveApiContext()) return [];
  const doFetch =
    fetcher ??
    ((path: string) => apiGetOrThrow<ResolveMcpServersResponse>(path));
  try {
    const out = await doFetch(RESOLVE_PATH);
    return Array.isArray(out?.servers) ? out.servers : [];
  } catch {
    // Isolated: a platform failure must not break file-based servers or the turn.
    return [];
  }
}

/**
 * Synthesize `McpServerConfig` entries for DB-backed servers, keyed by server
 * name so their tools surface as `mcp__<name>__<tool>` — the same convention as
 * file-based servers.
 *
 * File-based config wins on a name collision: an entry whose name already exists
 * in `existingNames` is skipped, so an explicit local override is never clobbered
 * by the workspace copy. `stdio` servers are skipped — they have no remotely
 * reachable endpoint the CLI could connect to.
 */
export function buildWorkspaceServerConfigs(
  servers: WorkspaceMcpServer[],
  existingNames: ReadonlySet<string> = new Set(),
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const s of servers) {
    if (s.transportType !== "streamable-http") continue;
    if (existingNames.has(s.name)) continue;
    out[s.name] = mcpServerSchema.parse({
      transport: "streamable-http",
      url: s.endpointUrl,
      // The credential itself is supplied out-of-band via remoteFetch (see
      // buildWorkspaceRemoteFetch) — never embedded in the config.
      auth: s.authStrategy,
    });
  }
  return out;
}

/**
 * Build the `remoteFetch` the CLI hands to `resolveCredential`. It looks the
 * server up by name in the already-fetched list and returns the
 * platform-resolved credential as a {@link StoredCredential} (in memory only).
 * Returns `null` for an unknown server, or one flagged `needsReauth` / carrying
 * no usable secret — which makes `resolveCredential` report "no credential",
 * and the CLI client isolates + surfaces that one server without failing others.
 */
export function buildWorkspaceRemoteFetch(
  servers: WorkspaceMcpServer[],
): (serverName: string) => Promise<StoredCredential | null> {
  const byName = new Map(servers.map((s) => [s.name, s]));
  return async (serverName: string): Promise<StoredCredential | null> => {
    const s = byName.get(serverName);
    if (!s || s.needsReauth) return null;
    if (s.token) {
      return { accessToken: s.token, tokenType: "Bearer", expiresAt: null };
    }
    if (s.headers && Object.keys(s.headers).length > 0) {
      return { headers: s.headers, expiresAt: null };
    }
    return null;
  };
}
