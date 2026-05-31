/**
 * resolveMcpContext — resolves a real CapabilityContext from an MCP request.
 *
 * The MCP transport carries authentication via:
 *   1. Authorization: Bearer <session-token>  — session-based (in-app agent)
 *   2. Authorization: Bearer <prefix_secret>  — API key (external callers)
 *
 * Token classification: an API key always contains an underscore in the format
 * `<prefix>_<secret>`. A session token (Better Auth) never matches that shape.
 * The resolver tries the session path when the token has no underscore, and
 * the API key path otherwise.
 *
 * Returns null when the Authorization header is absent, malformed, or
 * resolves to no valid principal. Callers MUST reject with 401.
 */
import type { CapabilityContext } from "@oxagen/oxagen";
import { resolveSession, resolveApiKey } from "@oxagen/auth";

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
  | { ok: false; reason: "unauthenticated" | "invalid_token" | "expired_token" };

/**
 * Resolves a CapabilityContext from the Authorization header of an MCP
 * request. Returns ok:false for any failure — callers translate to 401.
 *
 * @param authHeader - Raw value of the Authorization HTTP header.
 * @returns McpContextResolution — ok:true with a fully-populated context on
 *   success, ok:false with a typed reason on failure.
 */
export async function resolveMcpContext(
  authHeader: string | undefined,
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
        requestId: crypto.randomUUID(),
        surface: "mcp",
        messageId: null,
      },
    };
  }

  // Session token path — resolves to a userId; orgId/workspaceId come from
  // the request context (headers) in a follow-up increment. For now the MCP
  // surface only supports API-key auth for scoped capabilities, and session
  // tokens are the bearer for unscoped / tool-discovery calls. If the session
  // resolves, we return the userId but leave orgId/workspaceId as empty
  // strings — capability handlers that require scoped access enforce
  // ctx.userId and ctx.orgId non-empty via their own guards.
  //
  // IMPORTANT: This is intentionally NOT using nil-UUIDs. An empty string
  // signals "not resolved" rather than faking a tenant boundary.
  const sessionResult = await resolveSession(token);
  if (!sessionResult) return { ok: false, reason: "invalid_token" };

  return {
    ok: true,
    ctx: {
      orgId: "",
      workspaceId: "",
      userId: sessionResult.userId,
      apiKeyId: null,
      requestId: crypto.randomUUID(),
      surface: "mcp",
      messageId: null,
    },
  };
}
