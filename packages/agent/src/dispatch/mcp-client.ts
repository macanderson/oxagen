import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { tool, type Tool } from "@oxagen/ai";
import { z } from "zod";
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.mcp-client" },
});

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
  const transport = new StreamableHTTPClientTransport(
    new URL(args.endpointUrl),
    {
      authProvider: args.authProvider,
      requestInit: { headers: buildHeaders(args) },
    },
  );
  const client = new Client(
    { name: "oxagen-runner", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

// ── stdio transport ─────────────────────────────────────────────────────────
// stdio-transport MCP servers spawn a local child process and speak MCP over its
// stdin/stdout. Unlike the HTTP transport (a stateless keep-alive connection),
// the child MUST be reaped or it leaks a live OS process. There is no per-turn
// dispose seam in the plugin-type contributor pipeline (materialize-tools.ts
// never closes the HTTP client either), and the materialized tools keep the
// connection open so they remain callable across the turn — so we can't close
// right after listing tools. Instead we tie each spawned child's lifecycle to
// the runtime process: track every live transport and kill them on process exit,
// and expose closeStdioMcpTransports() for explicit shutdown/disposal wiring.

export interface McpStdioConnectArgs {
  command: string;
  args?: string[];
  /** Extra env for the child. Merged over getDefaultEnvironment() so PATH etc. survive. */
  env?: Record<string, string>;
  cwd?: string;
}

const activeStdioTransports = new Set<StdioClientTransport>();
let stdioExitHandlerInstalled = false;

// Kill every tracked child synchronously. StdioClientTransport.close() calls
// child.kill() synchronously, so this delivers the signal even inside the
// 'exit' handler (where async work cannot complete). We deliberately do NOT
// install SIGINT/SIGTERM handlers: hijacking those would override the host
// process's (apps/api) own graceful-shutdown handling. On an abrupt signal the
// child is still reaped by the OS when its inherited stdin pipe breaks.
function installStdioExitHandler(): void {
  if (stdioExitHandlerInstalled) return;
  stdioExitHandlerInstalled = true;
  process.once("exit", () => {
    for (const t of activeStdioTransports) {
      void t.close().catch(() => {});
    }
    activeStdioTransports.clear();
  });
}

export async function connectMcpStdio(
  args: McpStdioConnectArgs,
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: args.command,
    args: args.args ?? [],
    // Merge over the SDK's safe default environment so the child inherits a sane
    // baseline (PATH, HOME, …) plus the server-specific vars. Passing only
    // args.env would strip PATH and break `npx`/`node`/`python` resolution.
    env: { ...getDefaultEnvironment(), ...(args.env ?? {}) },
    cwd: args.cwd,
    // Surface the child's stderr on the parent so spawn failures are diagnosable.
    stderr: "inherit",
  });
  const client = new Client(
    { name: "oxagen-runner", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  activeStdioTransports.add(transport);
  installStdioExitHandler();
  // Drop the transport from the tracking set if it closes on its own (child
  // exit / broken pipe) so the set never accumulates dead references.
  const priorOnClose = transport.onclose;
  transport.onclose = () => {
    activeStdioTransports.delete(transport);
    priorOnClose?.();
  };
  return client;
}

/**
 * Close and reap every live stdio MCP child process. Idempotent. Wire this into
 * a runtime's shutdown/dispose path; also called by the process 'exit' handler.
 */
export async function closeStdioMcpTransports(): Promise<void> {
  const transports = [...activeStdioTransports];
  activeStdioTransports.clear();
  await Promise.all(transports.map((t) => t.close().catch(() => {})));
}

export async function listMcpTools(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name);
}

// The raw per-tool descriptor as advertised by the MCP server. Captured at
// registration into mcp.tool_snapshots so a replayed run can render
// the tool even after the server is disabled or deleted.
export interface McpToolDescriptor {
  name: string;
  description: string | null;
  // The tool's JSONSchema input descriptor, exactly as the server advertised it.
  inputSchema: Record<string, unknown>;
}

// Return the full descriptor (JSONSchema) for every tool the server advertises.
export async function listMcpToolDescriptors(
  client: Client,
): Promise<McpToolDescriptor[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? null,
    inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
  }));
}

// A pinned external tool ready for contribution: the descriptor fields come
// from the PINNED snapshot (never the live listing) while execute still calls
// the live server. Not an AI SDK Tool — plugin-types/mcp.ts maps this 1:1 to
// ContributedRawTool and materialize-tools.ts applies the model-facing typing.
export interface PinnedMcpTool {
  /** Synthetic tool key: `<prefix>.<toolName>`. */
  key: string;
  toolName: string;
  description: string | null;
  /** The pinned JSONSchema input contract. */
  inputSchema: Record<string, unknown>;
  execute: (input: unknown) => Promise<unknown>;
}

/**
 * Build callable tools from PINNED descriptors (descriptor pinning, see
 * runtime/mcp-snapshots.ts). The live server is only used to execute calls —
 * every model-visible string (name, description, input schema) comes from the
 * pin, so a server that rewrites its descriptors post-registration cannot
 * inject new text into the prompt.
 */
export function materializePinnedMcpTools(
  client: Client,
  prefix: string,
  descriptors: McpToolDescriptor[],
): PinnedMcpTool[] {
  return descriptors.map((d) => ({
    key: `${prefix}.${d.name}`,
    toolName: d.name,
    description: d.description,
    inputSchema: d.inputSchema ?? {},
    execute: async (input: unknown) => {
      const res = await client.callTool({
        name: d.name,
        arguments: input as Record<string, unknown>,
      });
      return res.content;
    },
  }));
}

// Wrap each MCP-side tool as an AI SDK Tool. We use z.record(z.string(), z.unknown())
// because the MCP server's JSONSchema isn't a Zod schema; the remote server
// re-validates on call. z.record is type-safe while still accepting arbitrary k/v.
// NOTE: this materializes from the LIVE listing and is only appropriate for the
// file-based local-config trust model (plugin-types/file-mcp.ts). The DB-backed
// external-server path must use materializePinnedMcpTools + the snapshot pins.
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
        const res = await client.callTool({
          name: t.name,
          arguments: input as Record<string, unknown>,
        });
        return res.content;
      },
    });
  }
  return out;
}

export async function healthcheck(args: McpConnectArgs): Promise<{
  status: "healthy" | "degraded" | "unreachable";
  discoveredTools: string[];
  // Full per-tool descriptors (JSONSchema) captured during the probe so the
  // caller can snapshot them without a second connection.
  descriptors: McpToolDescriptor[];
}> {
  try {
    const client = await connectMcp(args);
    const descriptors = await listMcpToolDescriptors(client);
    await client.close();
    return {
      status: "healthy",
      discoveredTools: descriptors.map((d) => d.name),
      descriptors,
    };
  } catch (err) {
    logger.warn(
      { endpointUrl: args.endpointUrl, err },
      "MCP healthcheck failed; marking unreachable",
    );
    return { status: "unreachable", discoveredTools: [], descriptors: [] };
  }
}
