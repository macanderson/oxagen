import { createServer } from "node:http";
import { xmcpHandler } from "xmcp-adapter-runtime";
import homeTemplate from "xmcp-home-template";
import middleware from "./middleware";
import { createMcpHttpApp, mcpAdmission } from "./http-app";

const app = createMcpHttpApp(
  middleware,
  (req, res) => xmcpHandler(req, res),
  mcpAdmission,
  homeTemplate("/mcp", undefined, undefined),
);
const server = createServer(app);
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.maxRequestsPerSocket = 1_000;
const port = Number(process.env.MCP_PORT ?? 4100);
server.listen(port, "127.0.0.1", () => {
  console.info(JSON.stringify({ service: "mcp", event: "listening", port }));
});
const metrics = setInterval(() => {
  console.info(JSON.stringify({ service: "mcp", event: "resource_budget", ...mcpAdmission.snapshot() }));
}, 30_000);
metrics.unref();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    clearInterval(metrics);
    server.close();
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 30_000).unref();
  });
}
