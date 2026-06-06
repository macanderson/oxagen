/**
 * mock-mcp-server.ts
 *
 * A minimal MCP streamable-HTTP server for E2E tests. Implements one tool
 * ("e2e_ping") so agent-integration tests can assert the tool was invoked.
 * Started by globalSetup, stopped by globalTeardown; listens on a random
 * port written to MOCK_MCP_PORT env var.
 *
 * Transport: streamable HTTP (POST /mcp).
 * Protocol: MCP 2025-03-26 (minimal subset — initialize + tools/call).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface MockMcpHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

function buildJsonRpcResponse(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function buildJsonRpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startMockMcpServer(): Promise<MockMcpHandle> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404);
      res.end();
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    let rpc: { jsonrpc: string; id: unknown; method: string; params?: unknown };
    try {
      rpc = JSON.parse(body) as typeof rpc;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(buildJsonRpcError(null, -32700, "Parse error"));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });

    if (rpc.method === "initialize") {
      res.end(
        buildJsonRpcResponse(rpc.id, {
          protocolVersion: "2025-03-26",
          serverInfo: { name: "mock-mcp-e2e", version: "0.0.1" },
          capabilities: { tools: {} },
        }),
      );
      return;
    }

    if (rpc.method === "tools/list") {
      res.end(
        buildJsonRpcResponse(rpc.id, {
          tools: [
            {
              name: "e2e_ping",
              description: "E2E smoke tool — returns pong.",
              inputSchema: { type: "object", properties: {}, required: [] },
            },
          ],
        }),
      );
      return;
    }

    if (rpc.method === "tools/call") {
      const p = rpc.params as { name: string; arguments: Record<string, unknown> };
      if (p.name !== "e2e_ping") {
        res.end(buildJsonRpcError(rpc.id, -32601, "Tool not found"));
        return;
      }
      res.end(
        buildJsonRpcResponse(rpc.id, {
          content: [{ type: "text", text: "pong" }],
          isError: false,
        }),
      );
      return;
    }

    res.end(buildJsonRpcError(rpc.id, -32601, "Method not found"));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mock-mcp-server: no address");
  const port = addr.port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
