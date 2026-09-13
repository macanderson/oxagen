/**
 * authorize-url.ts — builds the app-relative URL that starts the OAuth 2.1
 * flow for an installed MCP server (GET /api/v1/mcp/oauth/authorize).
 *
 * Client-safe (no server imports): the Authenticate buttons/dialog navigate
 * the whole window here, the route discovers the server's authorization
 * server (RFC 9728 + RFC 8414), registers a client (RFC 7591), and redirects
 * the browser to the provider's consent screen.
 */

export interface McpAuthorizeUrlInput {
  orgSlug: string;
  workspaceSlug: string;
  orgListingId: string;
  /** Same-org path to land on after the flow; defaults server-side to the MCP Servers page. */
  returnTo?: string;
}

export function mcpAuthorizeUrl(input: McpAuthorizeUrlInput): string {
  const params = new URLSearchParams({
    orgSlug: input.orgSlug,
    workspaceSlug: input.workspaceSlug,
    orgListingId: input.orgListingId,
  });
  if (input.returnTo) params.set("returnTo", input.returnTo);
  return `/api/v1/mcp/oauth/authorize?${params.toString()}`;
}
