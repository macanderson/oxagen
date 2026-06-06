/**
 * global-setup.ts — start fixture servers before Playwright runs any spec.
 *
 * Writes MOCK_MCP_PORT and MOCK_OAUTH_PORT to process.env so specs can read
 * them via `process.env`. Playwright passes env through to worker processes.
 * Also writes a JSON sidecar at /tmp/oxagen-e2e-fixtures.json for any helper
 * that needs the URLs outside of test process.env.
 */
import { writeFileSync } from "node:fs";
import { startMockMcpServer } from "./mock-mcp-server";
import { startMockOAuthServer } from "./mock-oauth-server";

let _mcpStop: (() => Promise<void>) | null = null;
let _oauthStop: (() => Promise<void>) | null = null;

export default async function globalSetup(): Promise<void> {
  const [mcp, oauth] = await Promise.all([startMockMcpServer(), startMockOAuthServer()]);

  _mcpStop = mcp.stop;
  _oauthStop = oauth.stop;

  process.env.MOCK_MCP_URL = mcp.url;
  process.env.MOCK_MCP_PORT = String(mcp.port);
  process.env.MOCK_OAUTH_ISSUER = oauth.issuer;
  process.env.MOCK_OAUTH_PORT = String(oauth.port);

  writeFileSync(
    "/tmp/oxagen-e2e-fixtures.json",
    JSON.stringify({ mcpUrl: mcp.url, oauthIssuer: oauth.issuer }),
  );
}

// Playwright calls a named export `globalTeardown` on the same module
// when using the `globalSetup` path. We store references above.
export async function globalTeardown(): Promise<void> {
  await Promise.all([_mcpStop?.(), _oauthStop?.()]);
}
