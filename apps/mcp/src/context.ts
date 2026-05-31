import type { CapabilityContext } from "@oxagen/oxagen";

/**
 * Build a CapabilityContext from xmcp request headers.
 * Headers are set by the middleware after bearer-token / API-key validation.
 * Falls back to placeholder values until auth lands (matching current behaviour).
 *
 * Accepts the wider HttpHeaders type returned by xmcp's headers() helper
 * (values may be string | string[] | undefined). When an array is present,
 * the first element is used.
 */
export function buildContext(
  hdrs: Record<string, string | string[] | undefined>,
): CapabilityContext {
  const get = (key: string): string | undefined => {
    const v = hdrs[key];
    if (Array.isArray(v)) return v[0];
    return v;
  };

  return {
    orgId:       get("x-oxagen-org-id")       ?? "00000000-0000-0000-0000-000000000000",
    workspaceId: get("x-oxagen-workspace-id") ?? "00000000-0000-0000-0000-000000000000",
    userId:      get("x-oxagen-user-id")      ?? null,
    apiKeyId:    get("x-oxagen-api-key-id")   ?? null,
    requestId:   get("x-request-id")          ?? crypto.randomUUID(),
    surface:     "mcp",
    messageId:   null,
  };
}
