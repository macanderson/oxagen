/**
 * mock-oauth-server.ts
 *
 * A minimal OAuth 2.1 authorization server for E2E tests.
 * Implements:
 *   GET  /.well-known/oauth-authorization-server  — metadata
 *   GET  /authorize                               — instant-redirect (no UI)
 *   POST /token                                   — issues a mock access token
 *
 * All tokens are predictable so specs can assert stored credential values.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URLSearchParams } from "node:url";

export interface MockOAuthHandle {
  port: number;
  issuer: string;
  stop: () => Promise<void>;
}

export const MOCK_ACCESS_TOKEN = "e2e_mock_access_token";
export const MOCK_REFRESH_TOKEN = "e2e_mock_refresh_token";

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startMockOAuthServer(): Promise<MockOAuthHandle> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);

    // ── Well-known metadata ───────────────────────────────────────────────────
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          // registration_endpoint is required for the MCP SDK's Dynamic Client
          // Registration flow. Without it, mcpAuth() throws
          // "Incompatible auth server: does not support dynamic client registration".
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
      return;
    }

    // ── Dynamic Client Registration ───────────────────────────────────────────
    // The MCP SDK calls this when no stored client_id exists. We issue a
    // predictable fake client_id so the authorize step can proceed.
    // RFC 7591 §3.2.1: the response must echo the registered client metadata —
    // the SDK validates it with OAuthClientInformationFullSchema, which
    // requires `redirect_uris` (an array). Omitting it makes mcpAuth throw
    // "Invalid input: expected array, received undefined".
    if (req.method === "POST" && url.pathname === "/register") {
      const body = await readBody(req);
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(body) as Record<string, unknown>;
      } catch {
        // tolerate empty/invalid bodies — fall back to a minimal echo
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ...metadata,
          client_id: "e2e_mock_client_id",
          client_secret: "e2e_mock_client_secret",
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_secret_expires_at: 0,
        }),
      );
      return;
    }

    // ── Authorization endpoint — instant redirect with code ───────────────────
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const redirectTarget = new URL(redirectUri);
      redirectTarget.searchParams.set("code", "e2e_auth_code");
      if (state) redirectTarget.searchParams.set("state", state);
      res.writeHead(302, { location: redirectTarget.toString() });
      res.end();
      return;
    }

    // ── Token endpoint ────────────────────────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/token") {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const grantType = params.get("grant_type");

      if (grantType !== "authorization_code" && grantType !== "refresh_token") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unsupported_grant_type" }));
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: MOCK_ACCESS_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: MOCK_REFRESH_TOKEN,
          scope: "mcp",
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mock-oauth-server: no address");
  const port = addr.port;

  return {
    port,
    issuer: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
