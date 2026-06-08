import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { tool, type Tool } from "ai";
import { z } from "zod";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info", base: { app: "agent.mcp-client" } });

export interface McpConnectArgs {
  endpointUrl: string;
  authStrategy: "none" | "bearer" | "header";
  authConfig?: Record<string, string>;
  authProvider?: OAuthClientProvider; // OAuth path — transport auto-refreshes
}

// Apply auth strategy to the transport headers — bearer goes in
// Authorization; header carries arbitrary k/v from authConfig.
function buildHeaders(args: McpConnectArgs): Record<string, string> {
  const h: Record<string, string> = {};
  if (args.authStrategy === "bearer" && args.authConfig?.token) {
    h["authorization"] = `Bearer ${args.authConfig.token}`;
  } else if (args.authStrategy === "header" && args.authConfig) {
    for (const [k, v] of Object.entries(args.authConfig)) h[k] = v;
  }
  return h;
}

export async function connectMcp(args: McpConnectArgs): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(args.endpointUrl), {
    authProvider: args.authProvider,
    requestInit: { headers: buildHeaders(args) },
  });
  const client = new Client(
    { name: "oxagen-runner", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

export async function listMcpTools(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name);
}

// Wrap each MCP-side tool as an AI SDK Tool. We use z.record(z.string(), z.unknown())
// because the MCP server's JSONSchema isn't a Zod schema; the remote server
// re-validates on call. z.record is type-safe while still accepting arbitrary k/v.
export async function materializeMcpTools(
  client: Client,
  prefix: string,
): Promise<Record<string, Tool>> {
  const { tools } = await client.listTools();
  const out: Record<string, Tool> = {};
  for (const t of tools) {
    const key = `${prefix}.${t.name}`;
    out[key] = tool({
      description: t.description ?? `External MCP tool ${t.name}`,
      inputSchema: z.record(z.string(), z.unknown()),
      execute: async (input: unknown) => {
        const res = await client.callTool({ name: t.name, arguments: input as Record<string, unknown> });
        return res.content;
      },
    });
  }
  return out;
}

export async function healthcheck(args: McpConnectArgs): Promise<{
  status: "healthy" | "degraded" | "unreachable";
  discoveredTools: string[];
}> {
  try {
    const client = await connectMcp(args);
    const tools = await listMcpTools(client);
    await client.close();
    return { status: "healthy", discoveredTools: tools };
  } catch (err) {
    logger.warn({ endpointUrl: args.endpointUrl, err }, "MCP healthcheck failed; marking unreachable");
    return { status: "unreachable", discoveredTools: [] };
  }
}
