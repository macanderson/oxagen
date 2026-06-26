/**
 * `oxagen mcp add <name>` — Add an MCP server to the file-based configuration.
 *
 * Writes a server entry to the appropriate scope file:
 *   --scope user    → ~/.config/oxagen/settings.json
 *   --scope project → .oxagen/settings.json (default)
 *   --scope local   → .oxagen/settings.local.json
 *
 * Validates against managed policy before writing.
 */
import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { McpServerConfig } from "@oxagen/mcp-config/schema";
import { loadManagedConfig, validateServerAgainstPolicy, formatViolation } from "@oxagen/mcp-config/managed";
import { findProjectRoot } from "@oxagen/mcp-config/resolve";

type Scope = "user" | "project" | "local";

function getSettingsPath(scope: Scope, projectRoot: string): string {
  switch (scope) {
    case "user":
      return join(homedir(), ".config", "oxagen", "settings.json");
    case "project":
      return join(projectRoot, ".oxagen", "settings.json");
    case "local":
      return join(projectRoot, ".oxagen", "settings.local.json");
  }
}

function readOrCreateSettings(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export const mcpAddCommand = new Command("add")
  .description("Add an MCP server to the file-based configuration")
  .argument("<name>", "Name for this server (used as the key in settings.json)")
  .requiredOption("--url <url>", "Server endpoint URL (for http/sse/websocket transports)")
  .option("--transport <type>", "Transport type: streamable-http, sse, stdio, websocket", "streamable-http")
  .option("--auth <strategy>", "Auth strategy: none, bearer, header, oauth", "none")
  .option("--env-token <varName>", "Environment variable name holding the bearer token")
  .option("--oauth-server-url <url>", "OAuth authorization server URL")
  .option("--scopes <scopes>", "OAuth scopes (comma-separated)")
  .option("--command <cmd>", "Command to spawn (for stdio transport)")
  .option("--args <args>", "Arguments for stdio command (comma-separated)")
  .option("--scope <scope>", "Config scope: user, project, local", "project")
  .option("--disabled", "Add server in disabled state")
  .action(async (name: string, options: {
    url?: string;
    transport: string;
    auth: string;
    envToken?: string;
    oauthServerUrl?: string;
    scopes?: string;
    command?: string;
    args?: string;
    scope: string;
    disabled?: boolean;
  }) => {
    const scope = options.scope as Scope;
    const projectRoot = findProjectRoot();

    // Build server config based on transport type
    let serverConfig: McpServerConfig;

    if (options.transport === "stdio") {
      if (!options.command) {
        console.error("Error: --command is required for stdio transport");
        process.exit(1);
      }
      serverConfig = {
        transport: "stdio",
        command: options.command,
        args: options.args?.split(",").map((a) => a.trim()) ?? [],
        ...(options.disabled ? { disabled: true } : {}),
      };
    } else {
      if (!options.url) {
        console.error("Error: --url is required for HTTP-based transports");
        process.exit(1);
      }
      const base = {
        url: options.url,
        auth: options.auth as "none" | "bearer" | "header" | "oauth",
        ...(options.envToken ? { envToken: options.envToken } : {}),
        ...(options.oauthServerUrl ? { oauthServerUrl: options.oauthServerUrl } : {}),
        ...(options.scopes ? { scopes: options.scopes.split(",").map((s) => s.trim()) } : {}),
        ...(options.disabled ? { disabled: true } : {}),
      };

      if (options.transport === "sse") {
        serverConfig = { transport: "sse", ...base };
      } else if (options.transport === "websocket") {
        serverConfig = { transport: "websocket", ...base } as McpServerConfig;
      } else {
        serverConfig = { transport: "streamable-http", ...base };
      }
    }

    // Check managed policy
    const managed = loadManagedConfig();
    const violation = validateServerAgainstPolicy(name, serverConfig, managed);
    if (violation) {
      console.error(formatViolation(violation));
      process.exit(1);
    }

    // Write to the appropriate settings file
    const filePath = getSettingsPath(scope, projectRoot);
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const settings = readOrCreateSettings(filePath);
    const mcpServers = (settings["mcpServers"] ?? {}) as Record<string, unknown>;
    mcpServers[name] = serverConfig;
    settings["mcpServers"] = mcpServers;

    writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    console.log(`Added MCP server "${name}" to ${scope} scope (${filePath})`);
  });
