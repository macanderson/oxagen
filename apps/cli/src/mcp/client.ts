/**
 * client.ts — Connects the CLI agent loop to external MCP servers.
 *
 * Servers are declared in `settings.json` under `mcpServers` (the same schema
 * the platform agent runtime reads). For each enabled server we open a client
 * over the configured transport, list its tools, apply the file-based tool
 * visibility + permission rules, and wrap each surviving tool as an AI SDK tool
 * named `mcp__<server>__<tool>` (Claude Code's convention) so it sits alongside
 * the local coding tools in one tool set.
 *
 * Unlike the platform's HTTP-only contributor, this supports stdio servers too
 * (the dominant local-MCP transport: filesystem, git, etc.).
 *
 * Failures are isolated per server: a server that won't connect is reported and
 * skipped — it never breaks the turn or the other servers.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  resolveCredential,
  type StoredCredential,
} from "@oxagen/mcp-config/credentials";
import {
  filterToolVisibility,
  getNonDeniedTools,
} from "@oxagen/mcp-config/permissions";
import type { McpServerConfig } from "@oxagen/mcp-config/schema";
import type { OxagenSettings, Permissions } from "../settings/schema.js";

/** The slice of the MCP SDK client the CLI uses (structural, so tests can fake it). */
export interface McpClientLike {
  listTools(): Promise<{
    tools: Array<{ name: string; description?: string | null }>;
  }>;
  callTool(args: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpServerStatus {
  name: string;
  transport: McpServerConfig["transport"];
  /** Tools advertised to the model after visibility + permission filtering. */
  toolCount: number;
  ok: boolean;
  error?: string;
}

export interface LoadedMcpTools {
  tools: ToolSet;
  servers: McpServerStatus[];
  /** Disconnect every server opened by this load. Always safe to call. */
  close: () => Promise<void>;
}

/** The double-underscore tool name the model sees for an MCP tool. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** Adapt the unified permissions to @oxagen/mcp-config's per-server gate shape. */
function toMcpPermissions(
  p: Permissions | undefined,
): Permissions & { defaultMcpPolicy: "allow" | "deny" | "ask" } {
  return { ...p, defaultMcpPolicy: p?.defaultMcpPolicy ?? "ask" };
}

/**
 * How the CLI resolves a server's credential. Threaded from `loadMcpTools` down
 * to `resolveCredential` so DB-backed, workspace-installed servers can supply
 * their platform-resolved token via `remoteFetch` without persisting it to disk.
 */
export interface CredentialResolution {
  /** Fetch a credential from the platform when env/file resolution misses. */
  remoteFetch?: (serverName: string) => Promise<StoredCredential | null>;
  /**
   * Whether a `remoteFetch` result is cached to the local credential file.
   * Defaults to false here (workspace secrets stay in memory only).
   */
  persistRemote?: boolean;
}

/** Resolve auth headers for an HTTP-family server (none for stdio). */
async function resolveHeaders(
  name: string,
  config: McpServerConfig,
  creds?: CredentialResolution,
): Promise<Record<string, string>> {
  if (config.transport === "stdio") return {};
  const auth = "auth" in config ? config.auth : "none";
  if (auth === "none") return {};

  const cred = await resolveCredential({
    serverName: name,
    config,
    remoteFetch: creds?.remoteFetch,
    persistRemote: creds?.persistRemote ?? false,
  });
  if (cred.source === "none") {
    throw new Error(
      `MCP server "${name}" needs ${auth} auth but no credential was found ` +
        `(set ${"envToken" in config && config.envToken ? config.envToken : "the token env var"} ` +
        `or run \`oxagen mcp check ${name}\`).`,
    );
  }
  if (cred.expired && !cred.hasRefreshToken) {
    throw new Error(
      `MCP server "${name}" credential is expired — re-authenticate.`,
    );
  }
  const headers: Record<string, string> = {};
  if (cred.token) headers["authorization"] = `Bearer ${cred.token}`;
  else if (cred.headers) Object.assign(headers, cred.headers);
  return headers;
}

async function buildTransport(
  name: string,
  config: McpServerConfig,
  creds?: CredentialResolution,
): Promise<Transport> {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
    });
  }
  const url = new URL(config.url);
  const headers = await resolveHeaders(name, config, creds);
  switch (config.transport) {
    case "streamable-http":
      return new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
      });
    case "sse":
      return new SSEClientTransport(url, { requestInit: { headers } });
    case "websocket":
      // The WS transport carries no request headers; bearer/header auth over WS
      // is not expressible, so we connect unauthenticated.
      return new WebSocketClientTransport(url);
  }
}

/** Open a client to one MCP server. Caller owns closing it. */
export async function connectServer(
  name: string,
  config: McpServerConfig,
  creds?: CredentialResolution,
): Promise<Client> {
  const transport = await buildTransport(name, config, creds);
  const client = new Client(
    { name: "oxagen-cli", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

/** MCP content → a string the model can read. */
function formatResult(result: unknown): string {
  if (result === null || typeof result !== "object")
    return String(result ?? "");
  const obj = result as { content?: unknown; isError?: boolean };
  const content = obj.content;
  let text: string;
  if (Array.isArray(content)) {
    const parts = content
      .map((c) => {
        if (
          c &&
          typeof c === "object" &&
          "text" in c &&
          typeof (c as { text: unknown }).text === "string"
        ) {
          return (c as { text: string }).text;
        }
        return JSON.stringify(c);
      })
      .filter(Boolean);
    text = parts.join("\n") || JSON.stringify(content);
  } else {
    text = JSON.stringify(obj);
  }
  return obj.isError ? `MCP tool error: ${text}` : text;
}

/** The tool names a server advertises, after visibility + permission filtering. */
export function filterServerTools(
  serverName: string,
  toolNames: string[],
  settings: OxagenSettings,
): string[] {
  const visible = filterToolVisibility(
    toolNames,
    settings.toolVisibility?.[serverName],
  );
  return getNonDeniedTools(
    serverName,
    visible,
    toMcpPermissions(settings.permissions),
  );
}

/**
 * Wrap a connected server's allowed tools as AI SDK tools keyed
 * `mcp__<server>__<tool>`. The MCP server re-validates arguments, so we accept
 * an open record rather than reconstruct its JSON Schema as Zod.
 */
export async function materializeServerTools(
  client: McpClientLike,
  serverName: string,
  settings: OxagenSettings,
): Promise<ToolSet> {
  const { tools } = await client.listTools();
  const allowed = new Set(
    filterServerTools(
      serverName,
      tools.map((t) => t.name),
      settings,
    ),
  );

  const out: ToolSet = {};
  for (const t of tools) {
    if (!allowed.has(t.name)) continue;
    out[mcpToolName(serverName, t.name)] = tool({
      description:
        t.description ?? `External MCP tool ${t.name} (server: ${serverName})`,
      inputSchema: z.record(z.string(), z.unknown()),
      execute: async (input: unknown) => {
        const res = await client.callTool({
          name: t.name,
          arguments: (input ?? {}) as Record<string, unknown>,
        });
        return formatResult(res);
      },
    });
  }
  return out;
}

export interface ServerToolReport {
  /** Tools advertised to the model (pass visibility + permission). */
  advertised: string[];
  /** Tools removed by `toolVisibility` include/exclude. */
  hidden: string[];
  /** Tools removed by a permission deny rule. */
  denied: string[];
}

/** Classify a server's advertised tool names into advertised / hidden / denied. */
export function buildServerReport(
  serverName: string,
  allToolNames: string[],
  settings: OxagenSettings,
): ServerToolReport {
  const visible = filterToolVisibility(
    allToolNames,
    settings.toolVisibility?.[serverName],
  );
  const visibleSet = new Set(visible);
  const hidden = allToolNames.filter((t) => !visibleSet.has(t));
  const advertised = getNonDeniedTools(
    serverName,
    visible,
    toMcpPermissions(settings.permissions),
  );
  const advertisedSet = new Set(advertised);
  const denied = visible.filter((t) => !advertisedSet.has(t));
  return { advertised, hidden, denied };
}

export interface CheckResult {
  name: string;
  ok: boolean;
  error?: string;
  /** Total tools the server advertises (before filtering). */
  total?: number;
  report?: ServerToolReport;
}

/** Connect to one server, list its tools, and report what would be exposed. */
export async function checkServer(
  name: string,
  config: McpServerConfig,
  settings: OxagenSettings,
): Promise<CheckResult> {
  let client: Client | undefined;
  try {
    client = await connectServer(name, config);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    return {
      name,
      ok: true,
      total: names.length,
      report: buildServerReport(name, names, settings),
    };
  } catch (err) {
    return {
      name,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client?.close();
  }
}

/**
 * Connect every enabled MCP server in `settings`, materialize their tools, and
 * return the merged set plus a `close()` that disconnects them all. Per-server
 * failures are isolated and reported in `servers`.
 */
export async function loadMcpTools(
  settings: OxagenSettings,
  opts: {
    onStatus?: (status: McpServerStatus) => void;
    /**
     * Credential resolution for HTTP-family servers. The CLI→platform bridge
     * passes a `remoteFetch` here so DB-backed, workspace-installed servers
     * resolve their platform-provided token (see mcp/workspace-servers.ts).
     */
    credentials?: CredentialResolution;
  } = {},
): Promise<LoadedMcpTools> {
  const servers: McpServerStatus[] = [];
  const clients: McpClientLike[] = [];
  const tools: ToolSet = {};

  for (const [name, config] of Object.entries(settings.mcpServers ?? {})) {
    if ("disabled" in config && config.disabled) continue;
    const status: McpServerStatus = {
      name,
      transport: config.transport,
      toolCount: 0,
      ok: false,
    };
    try {
      const client = await connectServer(name, config, opts.credentials);
      clients.push(client);
      const serverTools = await materializeServerTools(client, name, settings);
      Object.assign(tools, serverTools);
      status.ok = true;
      status.toolCount = Object.keys(serverTools).length;
    } catch (err) {
      status.error = err instanceof Error ? err.message : String(err);
    }
    servers.push(status);
    opts.onStatus?.(status);
  }

  return {
    tools,
    servers,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
