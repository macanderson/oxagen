/**
 * MCP capability-context resolution.
 *
 * Real per-request identity is resolved from the inbound Authorization header.
 * Only API keys are accepted:
 *   - API key   `<prefix>_<secret>`  -> resolveApiKey  -> org / workspace scope
 *
 * Session tokens (Better Auth opaque tokens -- no underscore) are rejected at
 * the edge with `invalid_token`. Session tokens carry no org/workspace scope;
 * accepting them would produce orgId:"" which fails closed in the kernel but
 * gives a confusing error. MCP clients must always authenticate with API keys.
 * See OXA-1515 for the tenancy-scope rationale.
 *
 * Token classification: an API key always contains an underscore in the format
 * `<prefix>_<secret>`. A session token (Better Auth opaque token) never does.
 *
 * SECURITY: tenant identity (orgId / workspaceId / userId / apiKeyId) is NEVER
 * read from client-controlled identity headers (`x-oxagen-org-id` & friends).
 * It is derived solely from the validated credential. Only `x-request-id` is
 * read from headers -- a trace-correlation id, not a security boundary -- and it
 * falls back to a fresh UUID when absent.
 *
 * `buildContext` is the single auth entrypoint for xmcp tools: each tool calls
 * `await buildContext(headers())`. It throws `McpUnauthorizedError` on any auth
 * failure so the tool invocation fails closed (xmcp surfaces it as an error).
 */
import type { CapabilityContext } from "@oxagen/oxagen";
import { resolveApiKey } from "@oxagen/auth";

/** xmcp's headers() helper returns this shape (array when a header repeats). */
type HttpHeaders = Record<string, string | string[] | undefined>;

/** Typed reasons an MCP request fails authentication. */
export type McpAuthFailure = "unauthenticated" | "invalid_token" | "expired_token";

/** Thrown when an MCP request carries no valid principal. Fails closed. */
export class McpUnauthorizedError extends Error {
  readonly reason: McpAuthFailure;
  constructor(reason: McpAuthFailure) {
    super(`MCP request unauthorized: ${reason}`);
    this.name = "McpUnauthorizedError";
    this.reason = reason;
  }
}

/** First value of a (possibly repeated) header. */
function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Extracts a raw Bearer token from an Authorization header value.
 *
 * @param authHeader - The raw Authorization header (e.g. "Bearer abc123").
 * @returns The token string, or null when the header is absent or malformed.
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const trimmed = authHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

export type McpContextResolution =
  | { ok: true; ctx: CapabilityContext }
  | { ok: false; reason: McpAuthFailure };

/**
 * Resolves a CapabilityContext from the Authorization header of an MCP
 * request. Returns a typed result (never throws for auth failures) so a
 * non-throwing caller can translate to 401.
 *
 * @param authHeader - Raw value of the Authorization HTTP header.
 * @param requestId - Trace-correlation id to stamp onto the context.
 */
export async function resolveMcpContext(
  authHeader: string | undefined,
  requestId: string,
): Promise<McpContextResolution> {
  const token = extractBearerToken(authHeader);
  if (!token) return { ok: false, reason: "unauthenticated" };

  // API keys contain an underscore separator: `<prefix>_<secret>`.
  // Session tokens (Better Auth opaque tokens) never do.
  const isApiKey = token.includes("_");

  if (isApiKey) {
    const resolution = await resolveApiKey(token);
    if (!resolution.ok) {
      return {
        ok: false,
        reason: resolution.kind === "expired" ? "expired_token" : "invalid_token",
      };
    }
    return {
      ok: true,
      ctx: {
        orgId: resolution.orgId,
        workspaceId: resolution.workspaceId,
        userId: null,
        apiKeyId: resolution.apiKeyId,
        requestId,
        surface: "mcp",
        messageId: null,
      },
    };
  }

  // Session token path -- MCP requires an API key to carry a fully-resolved
  // org/workspace scope. Session tokens (Better Auth opaque tokens) only
  // provide a userId; they carry no org/workspace context at all. Emitting
  // an empty orgId ("") would cause the kernel's runInTenantScope to throw
  // TenantScopeError (fail-closed, OXA-1515 Task 3 Step 4), but that gives
  // a confusing generic denial. Reject here at the edge with invalid_token so
  // the caller gets a clear 401 rather than a cryptic 500/deny downstream.
  //
  // Rationale: MCP clients authenticate with API keys (org+workspace scope
  // baked into the key). Browser sessions (app surface) use a different
  // transport (the /api/v1/chat/stream SSE route) where the session cookie
  // is resolved server-side with full tenant context. There is no legitimate
  // MCP use case for session-token auth.
  //
  // tenancy: unscoped seam -- session tokens have no org scope; reject before
  // any data access so the kernel never receives an empty orgId. -- OXA-1515
  return { ok: false, reason: "invalid_token" };
}

/**
 * Build a CapabilityContext for an xmcp tool invocation from request headers.
 *
 * The single auth entrypoint for tools. Resolves real identity from the
 * validated Authorization credential and throws `McpUnauthorizedError`
 * (fail closed) when the request carries no valid principal.
 */
export async function buildContext(hdrs: HttpHeaders): Promise<CapabilityContext> {
  const authHeader = firstHeader(hdrs["authorization"]);
  const requestId = firstHeader(hdrs["x-request-id"]) ?? crypto.randomUUID();

  const resolution = await resolveMcpContext(authHeader, requestId);
  if (!resolution.ok) throw new McpUnauthorizedError(resolution.reason);
  return resolution.ctx;
}
