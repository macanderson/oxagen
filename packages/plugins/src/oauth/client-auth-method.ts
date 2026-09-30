/**
 * How an MCP OAuth client authenticates at the token endpoint: the RFC 7591
 * `token_endpoint_auth_method` values `mcp.credentials.oauth_client_auth_method`
 * may hold (migration 20260930120000 checks the same list).
 */
const OAUTH_CLIENT_AUTH_METHODS = [
  "client_secret_basic",
  "client_secret_post",
  "none",
] as const;

export type OAuthClientAuthMethod = (typeof OAUTH_CLIENT_AUTH_METHODS)[number];

/** The method, or null for any value the column does not hold. */
export function oauthClientAuthMethodOf(
  raw: unknown,
): OAuthClientAuthMethod | null {
  return OAUTH_CLIENT_AUTH_METHODS.find((m) => m === raw) ?? null;
}
