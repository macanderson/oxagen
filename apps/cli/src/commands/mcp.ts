/**
 * mcp command — manage external MCP servers in settings.json.
 *
 *   oxagen mcp add <name> --command "npx -y server"      Add a stdio server
 *   oxagen mcp add <name> --url <url> [--auth bearer --env-token GH_TOKEN]
 *   oxagen mcp list                                       List configured servers
 *   oxagen mcp remove <name>                              Remove a server
 *   oxagen mcp enable|disable <name>                      Toggle a server
 *   oxagen mcp check [name]                               Connect + preview tools
 *
 * Servers are written to a scope file (default project) and resolved by the
 * agent loop, which materializes their tools through the same visibility +
 * permission rules shown by `check`.
 *
 * TODO(OXA-mcp-cli): add `oxagen mcp auth <server>` — the interactive OAuth
 * flow that writes ~/.config/oxagen/credentials/<server>.json for FILE-BASED
 * oauth servers (referenced by @oxagen/mcp-config credentials.ts). Only
 * file-based servers need it: DB-backed, workspace-installed servers are
 * authenticated in the web app and resolved server-side by the CLI turn bridge
 * (mcp/workspace-servers.ts).
 */
import {
  mcpServerSchema,
  type McpServerConfig,
} from "@oxagen/mcp-config/schema";
import {
  loadSettings,
  writeMcpServer,
  removeMcpServer,
  setMcpServerDisabled,
  type SettingsScope,
  type ResolveSettingsOptions,
} from "../settings/index.js";
import { checkServer } from "../mcp/client.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

export type McpCtx = Pick<
  ResolveSettingsOptions,
  "cwd" | "userSettingsPath" | "projectDirName"
>;

const SCOPES: SettingsScope[] = ["user", "project", "local"];
const HTTP_TRANSPORTS = ["streamable-http", "sse", "websocket"] as const;

function isScope(value: string): value is SettingsScope {
  return (SCOPES as string[]).includes(value);
}

export interface McpAddOptions {
  command?: string;
  arg?: string[];
  url?: string;
  transport?: string;
  auth?: string;
  envToken?: string;
  header?: string[];
  scope?: string;
}

function parseHeaders(
  pairs: string[] | undefined,
): Record<string, string> | undefined {
  if (!pairs || pairs.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1)
      throw new Error(`--header must be KEY=VALUE (got "${pair}")`);
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

function buildConfig(opts: McpAddOptions): McpServerConfig {
  if (opts.command) {
    return mcpServerSchema.parse({
      transport: "stdio",
      command: opts.command,
      args: opts.arg ?? [],
    });
  }
  if (!opts.url) {
    throw new Error(
      "provide either --command (stdio) or --url (http/sse/websocket)",
    );
  }
  const transport = opts.transport ?? "streamable-http";
  if (!(HTTP_TRANSPORTS as readonly string[]).includes(transport)) {
    throw new Error(
      `--transport must be one of: ${HTTP_TRANSPORTS.join(", ")}`,
    );
  }
  return mcpServerSchema.parse({
    transport,
    url: opts.url,
    auth: opts.auth ?? "none",
    envToken: opts.envToken,
    headers: parseHeaders(opts.header),
  });
}

export function mcpAdd(
  name: string,
  opts: McpAddOptions,
  ctx: McpCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const scope = opts.scope ?? "project";
  if (!isScope(scope)) {
    writer.writeErr(
      `Unknown scope "${scope}". Use one of: ${SCOPES.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }
  let config: McpServerConfig;
  try {
    config = buildConfig(opts);
  } catch (err) {
    writer.writeErr(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }
  const path = writeMcpServer({ ...ctx, scope, name, config });
  writer.write(
    `✓ Added MCP server "${name}" (${config.transport}) to ${scope}: ${path}`,
  );
  if ("envToken" in config && config.envToken) {
    writer.write(
      `  Set the token in your environment: export ${config.envToken}=…`,
    );
  }
}

/** Highest-precedence scope that defines each server (for display). */
function sourceMap(ctx: McpCtx): Record<string, SettingsScope> {
  const { scopes } = loadSettings({ ...ctx, noCache: true });
  const map: Record<string, SettingsScope> = {};
  for (const sc of scopes) {
    for (const serverName of Object.keys(sc.settings?.mcpServers ?? {})) {
      map[serverName] = sc.scope; // later scope (higher precedence) wins
    }
  }
  return map;
}

function target(config: McpServerConfig): string {
  if (config.transport === "stdio")
    return [config.command, ...config.args].join(" ");
  return config.url;
}

export function mcpList(
  ctx: McpCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const { settings } = loadSettings({ ...ctx, noCache: true });
  const servers = settings.mcpServers ?? {};
  const names = Object.keys(servers);
  if (names.length === 0) {
    writer.write("No MCP servers configured. Add one with `oxagen mcp add`.");
    return;
  }
  const source = sourceMap(ctx);
  writer.write("MCP servers:\n");
  for (const name of names) {
    const config = servers[name]!;
    const disabled =
      "disabled" in config && config.disabled ? " [disabled]" : "";
    writer.write(`  ${name}${disabled}`);
    writer.write(
      `    ${config.transport}  ${target(config)}  (${source[name] ?? "?"})`,
    );
  }
}

export function mcpRemove(
  name: string,
  scopeArg: string | undefined,
  ctx: McpCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  if (scopeArg && !isScope(scopeArg)) {
    writer.writeErr(
      `Unknown scope "${scopeArg}". Use one of: ${SCOPES.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }
  const { found, path } = removeMcpServer({
    ...ctx,
    name,
    scope: scopeArg as SettingsScope | undefined,
  });
  if (found) writer.write(`✓ Removed MCP server "${name}" from ${path}`);
  else {
    writer.writeErr(`MCP server "${name}" not found.`);
    process.exitCode = 1;
  }
}

export function mcpSetEnabled(
  name: string,
  enabled: boolean,
  scopeArg: string | undefined,
  ctx: McpCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  if (scopeArg && !isScope(scopeArg)) {
    writer.writeErr(
      `Unknown scope "${scopeArg}". Use one of: ${SCOPES.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }
  const { found, path } = setMcpServerDisabled({
    ...ctx,
    name,
    disabled: !enabled,
    scope: scopeArg as SettingsScope | undefined,
  });
  if (found)
    writer.write(
      `✓ ${enabled ? "Enabled" : "Disabled"} MCP server "${name}" (${path})`,
    );
  else {
    writer.writeErr(`MCP server "${name}" not found.`);
    process.exitCode = 1;
  }
}

export async function mcpCheck(
  name: string | undefined,
  ctx: McpCtx = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const { settings } = loadSettings({ ...ctx, noCache: true });
  const servers = settings.mcpServers ?? {};

  let entries: Array<[string, McpServerConfig]>;
  if (name) {
    const config = servers[name];
    if (!config) {
      writer.writeErr(`MCP server "${name}" not found.`);
      process.exitCode = 1;
      return;
    }
    entries = [[name, config]];
  } else {
    entries = Object.entries(servers).filter(
      ([, c]) => !("disabled" in c && c.disabled),
    );
    if (entries.length === 0) {
      writer.write("No enabled MCP servers to check.");
      return;
    }
  }

  for (const [serverName, config] of entries) {
    const result = await checkServer(serverName, config, settings);
    if (!result.ok) {
      writer.write(
        `Checking "${serverName}" (${config.transport})… ✗ ${result.error}`,
      );
      process.exitCode = 1;
      continue;
    }
    const r = result.report!;
    writer.write(
      `Checking "${serverName}" (${config.transport})… ✓ ${result.total} tools`,
    );
    writer.write(
      `    advertised: ${r.advertised.length ? r.advertised.join(", ") : "(none)"}`,
    );
    if (r.hidden.length)
      writer.write(`    hidden by visibility: ${r.hidden.join(", ")}`);
    if (r.denied.length)
      writer.write(`    denied by permissions: ${r.denied.join(", ")}`);
  }
}
