/**
 * MCP capability-context resolution.
 *
 * Real per-request identity is resolved from the inbound Authorization header.
 * Only API keys are accepted:
 *   - API key `ox_<base64url(32 bytes)>` -> resolveApiKey -> org / workspace
 *     scope. (`resolveApiKey` indexes on the leading 12 characters, which is
 *     a fixed-width window, not "the characters before the first underscore"
 *     — see API_KEY_PREFIX_LENGTH in @oxagen/auth.)
 *
 * Session tokens (Better Auth opaque tokens -- no underscore) are rejected at
 * the edge with `invalid_token`. Session tokens carry no org/workspace scope;
 * accepting them would produce orgId:"" which fails closed in the kernel but
 * gives a confusing error. MCP clients must always authenticate with API keys.
 *
 * An orgId of "" (empty string) is never a valid scope, from either path.
 * The API-key path also rejects a resolved orgId/workspaceId that is empty,
 * so a bad scope is caught here instead of failing later, deeper in the
 * kernel.
 *
 * Token classification is a cheap pre-filter, not the authority: an API key
 * always contains an underscore (its `ox_` prefix), while a Better Auth
 * session token is a UUID (see `generateId` in packages/auth/src/auth.ts) and
 * so contains only hex digits and hyphens. A token that passes the underscore
 * check is still verified by `resolveApiKey`, which re-checks the full `ox_`
 * prefix and the hashed secret before returning any scope.
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
import { emitSecurityEvent } from "@oxagen/database/security";

/** xmcp's headers() helper returns this shape (array when a header repeats). */
type HttpHeaders = Record<string, string | string[] | undefined>;

/** Typed reasons an MCP request fails authentication. */
export type McpAuthFailure =
  | "unauthenticated"
  | "invalid_token"
  | "expired_token";

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
export function extractBearerToken(
  authHeader: string | undefined,
): string | null {
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
 * Extract the real client IP from proxy headers.
 * x-forwarded-for may carry a comma-separated list — take the first hop
 * (leftmost = original client). Falls back to x-real-ip, then null.
 *
 * SECURITY: these headers can be spoofed. Used only for IAM ip_ranges
 * condition evaluation, never for authentication.
 */
function extractClientIp(hdrs: HttpHeaders): string | null {
  const xff = firstHeader(hdrs["x-forwarded-for"]);
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first && first.length > 0) return first;
  }
  const realIp = firstHeader(hdrs["x-real-ip"]);
  return realIp?.trim() || null;
}

/**
 * Resolves a CapabilityContext from the Authorization header of an MCP
 * request. Returns a typed result (never throws for auth failures) so a
 * non-throwing caller can translate to 401.
 *
 * @param authHeader - Raw value of the Authorization HTTP header.
 * @param requestId  - Trace-correlation id to stamp onto the context.
 * @param clientIp   - Client IP extracted from x-forwarded-for / x-real-ip.
 */
export async function resolveMcpContext(
  authHeader: string | undefined,
  requestId: string,
  clientIp: string | null = null,
): Promise<McpContextResolution> {
  const token = extractBearerToken(authHeader);
  if (!token) return { ok: false, reason: "unauthenticated" };

  // Cheap pre-filter: API keys carry an `ox_` prefix, so they always contain
  // an underscore. Better Auth session tokens are UUIDs (hex + hyphens only),
  // so they never do — they are rejected below without a DB round-trip.
  // resolveApiKey re-validates the prefix authoritatively.
  const isApiKey = token.includes("_");

  if (isApiKey) {
    const resolution = await resolveApiKey(token);
    if (!resolution.ok) {
      return {
        ok: false,
        reason:
          resolution.kind === "expired" ? "expired_token" : "invalid_token",
      };
    }

    // An API key must resolve to a non-empty org/workspace scope.
    // resolveApiKey() should never return ok:true with an empty orgId, but
    // if a data bug ever produced one, runInTenantScope's uuid guard would
    // still fail closed deep in the kernel — after a security event already
    // logged the request as a success. Reject the empty scope here instead,
    // so it never reaches the kernel or the audit log as a success.
    if (!resolution.orgId || !resolution.workspaceId) {
      return { ok: false, reason: "invalid_token" };
    }

    // SOC2 audit: record machine-credential usage. Fires once per MCP tool
    // invocation (buildContext runs per tool call) — the correct semantic for
    // an "api_key.used" access-log event. Fire-and-forget: an audit-pipeline
    // hiccup must never fail-closed a legitimately authenticated request.
    // actorUserId is null (machine auth carries no user); ip is the resolved
    // client IP.
    emitSecurityEvent({
      eventType: "api_key.used",
      actorUserId: null,
      orgId: resolution.orgId,
      workspaceId: resolution.workspaceId,
      capability: null,
      outcome: "success",
      ip: clientIp,
      userAgent: null,
      requestId,
    });

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
        clientIp,
      },
    };
  }

  // Session token path -- MCP requires an API key to carry a fully-resolved
  // org/workspace scope. Session tokens (Better Auth opaque tokens) only
  // provide a userId; they carry no org/workspace context at all. Emitting
  // an empty orgId ("") would cause the kernel's runInTenantScope to throw
  // TenantScopeError (fail-closed), but that gives a confusing generic
  // denial. Reject here at the edge with invalid_token so the caller gets a
  // clear 401 rather than a cryptic 500/deny downstream.
  //
  // MCP clients authenticate with API keys (org+workspace scope baked into
  // the key). Browser sessions (app surface) use a different transport (the
  // /api/v1/chat/stream SSE route) where the session cookie is resolved
  // server-side with full tenant context. There is no legitimate MCP use
  // case for session-token auth.
  return { ok: false, reason: "invalid_token" };
}

/**
 * Build a CapabilityContext for an xmcp tool invocation from request headers.
 *
 * The single auth entrypoint for tools. Resolves real identity from the
 * validated Authorization credential and throws `McpUnauthorizedError`
 * (fail closed) when the request carries no valid principal.
 */
export async function buildContext(
  hdrs: HttpHeaders,
): Promise<CapabilityContext> {
  const authHeader = firstHeader(hdrs["authorization"]);
  const requestId = firstHeader(hdrs["x-request-id"]) ?? crypto.randomUUID();
  const clientIp = extractClientIp(hdrs);

  const resolution = await resolveMcpContext(authHeader, requestId, clientIp);
  if (!resolution.ok) throw new McpUnauthorizedError(resolution.reason);
  return resolution.ctx;
}
