// GET /api/v1/mcp/oauth/client-metadata: Oxagen's OAuth client metadata
// document (#4814).
//
// The MCP authorization spec prefers a Client ID Metadata Document to dynamic
// client registration. The client ID is the https URL of this document. An
// authorization server that advertises `client_id_metadata_document_supported`
// fetches it, checks the callback against `redirect_uris`, and needs no
// registration step. So a server that refuses to register unknown clients, or
// that registers none, still lets Oxagen sign in.
//
// The document is public and names no secret: its client authenticates with
// PKCE alone (`token_endpoint_auth_method: none`). `client_id` must equal the
// URL it is served from, so both are built from the one origin
// (`app-origin.ts`) that also names the callback.
import { appOriginOf } from "./app-origin";
import {
  MCP_OAUTH_CALLBACK_PATH,
  MCP_OAUTH_CLIENT_METADATA_PATH,
} from "./oauth-flow";

/** How long an authorization server may cache the document. */
const CACHE_SECONDS = 3600;

export function mcpOAuthClientMetadata(origin: string) {
  return {
    client_id: new URL(MCP_OAUTH_CLIENT_METADATA_PATH, origin).toString(),
    client_name: "Oxagen",
    client_uri: origin,
    logo_uri: new URL("/brand/oxagen-icon.svg", origin).toString(),
    redirect_uris: [new URL(MCP_OAUTH_CALLBACK_PATH, origin).toString()],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export function handleMcpOAuthClientMetadata(
  request: Request,
): Promise<Response> {
  const origin = appOriginOf((name) => request.headers.get(name));
  return Promise.resolve(
    new Response(JSON.stringify(mcpOAuthClientMetadata(origin)), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${CACHE_SECONDS}`,
        "access-control-allow-origin": "*",
      },
    }),
  );
}
