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
import type { McpServerConfig } from "@oxagen/mcp-config/schema";
import type { CapabilityContext } from "../../types";
import { connectMcp, materializeMcpTools } from "../../dispatch/mcp-client";
import {
  registerPluginType,
  type ContributedRawTool,
  type PluginContributeOptions,
} from "../plugin-type";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.plugin-types.file-mcp" },
});

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

    // Only handle HTTP-based transports (stdio requires process spawning
    // which is a separate transport — future enhancement)
    if (config.transport === "stdio") {
      // TODO: stdio transport support via StdioClientTransport
      logger.debug(
        { serverName },
        "skipping stdio server (not yet supported in runtime)",
      );
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

      // Get tool names for filtering
      const allToolNames = Object.keys(mcpTools).map((key) => {
        // key is `file-mcp.<serverName>.<toolName>` — extract toolName
        const prefix = `file-mcp.${serverName}.`;
        return key.startsWith(prefix) ? key.slice(prefix.length) : key;
      });

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
      const allowedTools = nonDeniedTools.filter((tool) => {
        const violation = checkToolDenied(
          serverName,
          tool,
          managed?.managedPolicy,
        );
        return violation === null;
      });

      // Build the allowed tool set
      const allowedSet = new Set(allowedTools);

      for (const [rawKey, rawTool] of Object.entries(mcpTools)) {
        const prefix = `file-mcp.${serverName}.`;
        const toolName = rawKey.startsWith(prefix)
          ? rawKey.slice(prefix.length)
          : rawKey;

        if (!allowedSet.has(toolName)) continue;

        const execute = rawTool.execute;
        if (typeof execute !== "function") continue;

        out.push({
          realName: rawKey,
          // AI SDK v7 allows function-valued tool descriptions (resolved with
          // call options we don't have here) — only static strings carry over.
          description:
            typeof rawTool.description === "string" ? rawTool.description : undefined,
          execute: execute as ContributedRawTool["execute"],
          externalServerId: `file:${serverName}`,
        });
      }
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
