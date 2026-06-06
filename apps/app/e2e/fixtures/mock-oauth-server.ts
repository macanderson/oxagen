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
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
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
