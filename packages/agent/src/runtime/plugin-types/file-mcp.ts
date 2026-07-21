/**
 * file-mcp.ts — File-based MCP server plugin-type contributor.
 *
 * Reads MCP server definitions from the file-based configuration system
 * (.oxagen/settings.json, ~/.config/oxagen/settings.json) and contributes
 * their tools to the agent runtime alongside DB-backed servers.
 *
 * Key differences from the DB-backed mcp.ts contributor:
 *   - No database queries — fully offline-capable
 *   - Credential resolution from env/files (not encrypted DB columns)
 *   - Permission evaluation from file-based rules (not platform IAM)
 *   - Tool visibility filtering before contribution
 *   - Managed policy enforcement (org denylist)
 *
 * Both contributors feed into the same materializeTools() pipeline, which
 * applies the uniform IAM gate + ClickHouse telemetry wrapping.
 */
import pino from "pino";
import { resolveSettings, findProjectRoot } from "@oxagen/mcp-config/resolve";
import { resolveCredential } from "@oxagen/mcp-config/credentials";
import {
  filterToolVisibility,
  getNonDeniedTools,
} from "@oxagen/mcp-config/permissions";
import {
  loadManagedConfig,
  getManagedServers,
  checkToolDenied,
} from "@oxagen/mcp-config/managed";
import type {
  McpServerConfig,
  ManagedPolicy,
  Settings,
} from "@oxagen/mcp-config/schema";
import type { Tool } from "@oxagen/ai";
import type { CapabilityContext } from "../../types";
import {
  connectMcp,
  connectMcpStdio,
  materializeMcpTools,
} from "../../dispatch/mcp-client";
import {
  registerPluginType,
  type ContributedRawTool,
  type PluginContributeOptions,
} from "../plugin-type";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.plugin-types.file-mcp" },
});

/**
 * SECURITY GATE for stdio-transport MCP servers.
 *
 * An stdio server declaration causes the runtime to SPAWN AN ARBITRARY LOCAL
 * PROCESS (its `command`). This contributor is registered into the shared
 * `materializeTools()` pipeline that runs SERVER-SIDE inside apps/api's chat
 * stream (see materialize-tools.ts) — so enabling stdio spawning by default
 * would let a workspace-scoped config execute arbitrary commands on the API
 * host. It is therefore OFF by default and gated behind an explicit opt-in env
 * flag intended for a trusted local/CLI runtime only. HTTP transports carry no
 * such risk and are always processed.
 */
function stdioSpawnEnabled(): boolean {
  const v = process.env.OXAGEN_ALLOW_STDIO_MCP;
  return v === "1" || v === "true";
}

// Minimal glob → RegExp: `*` matches any run of chars, `?` a single char;
// everything else is literal. Used only for the org-managed command allowlist.
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/**
 * Defense-in-depth on top of the env gate: when the org managed policy declares
 * an `allowedCommands` allowlist, a stdio server's `command` must match one of
 * its globs. An empty/absent allowlist means "no additional restriction" (the
 * env gate remains the deciding factor).
 */
function commandAllowedByPolicy(
  command: string,
  policy: ManagedPolicy | undefined,
): boolean {
  const patterns = policy?.allowedCommands;
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => globToRegExp(p).test(command));
}

/**
 * Apply the uniform visibility → permission → managed-denylist filtering to a
 * server's materialized tools and return the contributable raw tools. Shared by
 * the HTTP and stdio branches so both transports enforce the exact same gates.
 */
function collectAllowedTools(
  serverName: string,
  mcpTools: Record<string, Tool>,
  settings: Settings,
  managedPolicy: ManagedPolicy | undefined,
): ContributedRawTool[] {
  const prefix = `file-mcp.${serverName}.`;
  const stripPrefix = (key: string) =>
    key.startsWith(prefix) ? key.slice(prefix.length) : key;

  const allToolNames = Object.keys(mcpTools).map(stripPrefix);

  // Apply tool visibility filtering
  const visibilityConfig = settings.toolVisibility?.[serverName];
  const visibleTools = filterToolVisibility(allToolNames, visibilityConfig);

  // Apply permission filtering (remove denied tools before they reach the model)
  const nonDeniedTools = getNonDeniedTools(
    serverName,
    visibleTools,
    settings.permissions,
  );

  // Apply managed policy tool denylist
  const allowedTools = nonDeniedTools.filter(
    (tool) => checkToolDenied(serverName, tool, managedPolicy) === null,
  );
  const allowedSet = new Set(allowedTools);

  const out: ContributedRawTool[] = [];
  for (const [rawKey, rawTool] of Object.entries(mcpTools)) {
    const toolName = stripPrefix(rawKey);
    if (!allowedSet.has(toolName)) continue;

    const execute = rawTool.execute;
    if (typeof execute !== "function") continue;

    out.push({
      realName: rawKey,
      // AI SDK v7 allows function-valued tool descriptions (resolved with
      // call options we don't have here) — only static strings carry over.
      description:
        typeof rawTool.description === "string"
          ? rawTool.description
          : undefined,
      execute: execute as ContributedRawTool["execute"],
      externalServerId: `file:${serverName}`,
      // Agent-RBAC rule identity (spec §3.7): the settings server key is the
      // name "server:tool" rule patterns address.
      externalServerName: serverName,
      externalToolName: toolName,
    });
  }
  return out;
}

async function contributeFileBasedMcpTools(
  _ctx: CapabilityContext,
  _options?: PluginContributeOptions,
): Promise<ContributedRawTool[]> {
  // Resolve the effective file-based config
  const projectRoot = findProjectRoot();
  const { settings } = resolveSettings({ projectRoot });
  const managed = loadManagedConfig();
  const managedServers = getManagedServers(managed);

  // Merge: file-based + managed (managed overrides)
  const allServers: Record<string, McpServerConfig> = {
    ...(settings.mcpServers ?? {}),
    ...managedServers,
  };

  const out: ContributedRawTool[] = [];

  for (const [serverName, config] of Object.entries(allServers)) {
    // Skip disabled servers
    if ("disabled" in config && config.disabled) continue;

    // stdio-transport servers spawn a local process — handled by a dedicated,
    // security-gated branch (see stdioSpawnEnabled + connectMcpStdio below).
    if (config.transport === "stdio") {
      if (!stdioSpawnEnabled()) {
        // Default server-side posture: never spawn arbitrary local processes.
        logger.warn(
          { serverName, command: config.command },
          "skipping stdio MCP server: local process spawning is disabled — set OXAGEN_ALLOW_STDIO_MCP=1 in a trusted local/CLI runtime to enable",
        );
        continue;
      }
      if (!commandAllowedByPolicy(config.command, managed?.managedPolicy)) {
        logger.warn(
          { serverName, command: config.command },
          "skipping stdio MCP server: command not permitted by managed policy allowedCommands",
        );
        continue;
      }
      try {
        // Spawn the child, list its tools, and contribute them exactly like an
        // HTTP server. The connection stays open so the tools remain callable;
        // the child is reaped on process exit / closeStdioMcpTransports().
        const client = await connectMcpStdio({
          command: config.command,
          args: config.args,
          env: config.env,
          cwd: config.cwd ?? projectRoot,
        });
        const mcpTools = await materializeMcpTools(
          client,
          `file-mcp.${serverName}`,
        );
        out.push(
          ...collectAllowedTools(
            serverName,
            mcpTools,
            settings,
            managed?.managedPolicy,
          ),
        );
      } catch (err) {
        // Per-server failure is isolated — log and continue.
        logger.error(
          { serverName, err },
          "failed to load tools from stdio MCP server",
        );
      }
      continue;
    }

    try {
      // Resolve credentials
      const cred = await resolveCredential({ serverName, config });

      // Skip servers with no credentials when auth is required
      const auth = "auth" in config ? config.auth : "none";
      if (auth !== "none" && cred.source === "none") {
        logger.debug(
          { serverName },
          "skipping file-based MCP server: no credentials",
        );
        continue;
      }

      // Skip expired tokens (user needs to re-auth)
      if (cred.expired && !cred.hasRefreshToken) {
        logger.warn(
          { serverName },
          "skipping file-based MCP server: token expired",
        );
        continue;
      }

      // Build connection args
      const url = "url" in config ? config.url : "";
      let authStrategy: "none" | "bearer" | "header" = "none";
      let authConfig: Record<string, string> = {};

      if (cred.token) {
        authStrategy = "bearer";
        authConfig = { token: cred.token };
      } else if (cred.headers) {
        authStrategy = "header";
        authConfig = cred.headers;
      }

      // Connect and discover tools
      const client = await connectMcp({
        endpointUrl: url,
        authStrategy,
        authConfig,
      });

      const mcpTools = await materializeMcpTools(
        client,
        `file-mcp.${serverName}`,
      );

      out.push(
        ...collectAllowedTools(
          serverName,
          mcpTools,
          settings,
          managed?.managedPolicy,
        ),
      );
    } catch (err) {
      // Per-server failure is isolated — log and continue
      logger.error(
        { serverName, err },
        "failed to load tools from file-based MCP server",
      );
    }
  }

  return out;
}

registerPluginType({
  type: "mcp_server_local",
  contributeTools: contributeFileBasedMcpTools,
});

export { contributeFileBasedMcpTools };
