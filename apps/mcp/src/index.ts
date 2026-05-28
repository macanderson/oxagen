import { serve } from "@hono/node-server";
import { buildServer } from "./server.js";

// Port 4100 per spec §12.4. The MCP server speaks HTTP for the SDK
// transport; stdio mode is a follow-up once the SDK plumbing stabilizes.
const PORT = Number(process.env.MCP_PORT ?? 4100);

const app = buildServer();

serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  // eslint-disable-next-line no-console
  console.log(`[mcp] listening on http://localhost:${port}`);
});
