/**
 * preregistered-clients.ts — static OAuth client credentials for MCP
 * authorization servers that do NOT support RFC 7591 dynamic client
 * registration (GitHub, notably: its authorization-server metadata publishes
 * no registration_endpoint, so the SDK's registerClient() throws and the
 * authorize flow dies for every user).
 *
 * The MCP SDK consults OAuthClientProvider.clientInformation() BEFORE
 * attempting DCR, so returning a pre-registered client here bypasses
 * registration entirely and the rest of the OAuth 2.1 + PKCE flow proceeds
 * unchanged.
 *
 * Configuration: the MCP_OAUTH_PREREGISTERED_CLIENTS env var holds a JSON
 * object mapping the MCP server's endpoint HOST (lowercase, no scheme) to the
 * client registered with that provider:
 *
 *   MCP_OAUTH_PREREGISTERED_CLIENTS='{
 *     "api.githubcopilot.com": { "client_id": "Iv1…", "client_secret": "…" }
 *   }'
 *
 * The OAuth app registered with the provider must list
 * `<app-origin>/api/v1/mcp/oauth/callback` as its callback/redirect URL.
 */
import type { OAuthClientInformation } from "@modelcontextprotocol/sdk/shared/auth.js";

interface PreregisteredEntry {
  client_id?: unknown;
  client_secret?: unknown;
}

/** Warn about a malformed env value once per process, not per OAuth flow. */
let warnedMalformed = false;

/**
 * Parses raw JSON (the env var value) into a host → client map. Exported for
 * tests; production callers use preregisteredClientForEndpoint().
 */
export function parsePreregisteredClients(
  raw: string | undefined,
): Map<string, OAuthClientInformation> {
  const out = new Map<string, OAuthClientInformation>();
  if (!raw || raw.trim() === "") return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (!warnedMalformed) {
      warnedMalformed = true;
      console.error(
        "[mcp-oauth] MCP_OAUTH_PREREGISTERED_CLIENTS is not valid JSON — ignoring it",
      );
    }
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    if (!warnedMalformed) {
      warnedMalformed = true;
      console.error(
        "[mcp-oauth] MCP_OAUTH_PREREGISTERED_CLIENTS must be a JSON object keyed by endpoint host — ignoring it",
      );
    }
    return out;
  }

  for (const [host, entry] of Object.entries(
    parsed as Record<string, PreregisteredEntry>,
  )) {
    if (typeof entry !== "object" || entry === null) continue;
    const clientId = entry.client_id;
    if (typeof clientId !== "string" || clientId === "") continue;
    const secret = entry.client_secret;
    out.set(host.toLowerCase(), {
      client_id: clientId,
      ...(typeof secret === "string" && secret !== ""
        ? { client_secret: secret }
        : {}),
    });
  }
  return out;
}

/**
 * Returns the pre-registered OAuth client for an MCP endpoint URL, matched by
 * host, or undefined when none is configured. Never throws — a bad endpoint
 * URL or malformed env value simply yields undefined so the flow falls back
 * to dynamic client registration.
 */
export function preregisteredClientForEndpoint(
  endpointUrl: string,
  rawEnv: string | undefined = process.env.MCP_OAUTH_PREREGISTERED_CLIENTS,
): OAuthClientInformation | undefined {
  let host: string;
  try {
    host = new URL(endpointUrl).host.toLowerCase();
  } catch {
    return undefined;
  }
  return parsePreregisteredClients(rawEnv).get(host);
}

/** Test-only: reset the once-per-process malformed-env warning latch. */
export function resetPreregisteredClientsWarning(): void {
  warnedMalformed = false;
}
