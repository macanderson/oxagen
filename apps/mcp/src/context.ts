import type { CapabilityContext } from "@oxagen/oxagen";

/** Fixed placeholder tenant scope used until per-tenant MCP auth lands. */
const PLACEHOLDER_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Build a CapabilityContext for an MCP tool invocation.
 *
 * SECURITY: tenant identity (orgId / workspaceId / userId / apiKeyId) is NEVER
 * read from inbound request headers. Those headers are fully client-controlled,
 * and the Phase 1 middleware only validates a single shared MCP_API_KEY — it
 * sets no identity server-side. Trusting `x-oxagen-org-id` & friends would let
 * any holder of MCP_API_KEY inject an arbitrary org and operate on a real
 * tenant's data. With a shared key there is no authenticated tenant, so the
 * only honest scope is the fixed placeholder below (matching the injection-
 * immune behaviour of the former placeholderContext()).
 *
 * Phase 2 will resolve identity server-side from the validated credential
 * (@oxagen/auth resolveApiKey) inside the middleware and thread the resolved
 * org/workspace/apiKeyId through a trusted, non-client channel — at which point
 * this function reads from that channel, never from raw request headers.
 *
 * Only requestId is taken from headers: it is a trace-correlation id, not a
 * security boundary, and falls back to a fresh UUID when absent. Accepts the
 * wider HttpHeaders type returned by xmcp's headers() helper (values may be
 * string | string[] | undefined; the first element is used for arrays).
 */
export function buildContext(
  hdrs: Record<string, string | string[] | undefined>,
): CapabilityContext {
  const requestIdHeader = hdrs["x-request-id"];
  const requestId = Array.isArray(requestIdHeader)
    ? requestIdHeader[0]
    : requestIdHeader;

  return {
    orgId: PLACEHOLDER_UUID,
    workspaceId: PLACEHOLDER_UUID,
    userId: null,
    apiKeyId: null,
    requestId: requestId ?? crypto.randomUUID(),
    surface: "mcp",
    messageId: null,
  };
}
