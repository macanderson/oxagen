/**
 * global-setup.ts — start fixture servers before Playwright runs any spec.
 *
 * Writes MOCK_MCP_PORT and MOCK_OAUTH_PORT to process.env so specs can read
 * them via `process.env`. Playwright passes env through to worker processes.
 * Also writes a JSON sidecar at /tmp/oxagen-e2e-fixtures.json for any helper
 * that needs the URLs outside of test process.env.
 *
 * Returns a teardown function so Playwright stops the servers after all tests
 * without needing a separate `globalTeardown` file. Both setup and teardown
 * share the same process, so the server handles are closed correctly.
 */
import { writeFileSync } from "node:fs";
import { startMockMcpServer } from "./mock-mcp-server";
import { startMockOAuthServer } from "./mock-oauth-server";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const [mcp, oauth] = await Promise.all([startMockMcpServer(), startMockOAuthServer()]);

  process.env.MOCK_MCP_URL = mcp.url;
  process.env.MOCK_MCP_PORT = String(mcp.port);
  process.env.MOCK_OAUTH_ISSUER = oauth.issuer;
  process.env.MOCK_OAUTH_PORT = String(oauth.port);

  writeFileSync(
    "/tmp/oxagen-e2e-fixtures.json",
    JSON.stringify({ mcpUrl: mcp.url, oauthIssuer: oauth.issuer }),
  );

  return async () => {
    await Promise.all([mcp.stop(), oauth.stop()]);
  };
}
