/**
 * `oxagen mcp permit <server>` — Set permission rules for an MCP server.
 *
 * Writes allow/deny rules to the specified scope file.
 * Examples:
 *   oxagen mcp permit github --allow-all --deny delete_repository
 *   oxagen mcp permit internal-api --allow "query_*,get_*" --deny "delete_*"
 *   oxagen mcp permit filesystem --default allow
 */
import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
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

export const mcpPermitCommand = new Command("permit")
  .description("Set permission rules for an MCP server's tools")
  .argument("<server>", "Server name to configure permissions for")
  .option("--allow <patterns>", "Glob patterns for tools to allow (comma-separated)")
  .option("--deny <patterns>", "Glob patterns for tools to deny (comma-separated)")
  .option("--allow-all", "Set defaultPolicy to allow for this server")
  .option("--deny-all", "Set defaultPolicy to deny for this server")
  .option("--ask-all", "Set defaultPolicy to ask for this server (reset to default)")
  .option("--default <policy>", "Set server defaultPolicy: allow, deny, ask")
  .option("--scope <scope>", "Config scope: user, project, local", "project")
  .option("--clear", "Remove all permission rules for this server")
  .action(async (server: string, options: {
    allow?: string;
    deny?: string;
    allowAll?: boolean;
    denyAll?: boolean;
    askAll?: boolean;
    default?: string;
    scope: string;
    clear?: boolean;
  }) => {
    const scope = options.scope as Scope;
    const projectRoot = findProjectRoot();
    const filePath = getSettingsPath(scope, projectRoot);
    const dir = dirname(filePath);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const settings = readOrCreateSettings(filePath);

    // Ensure permissions structure exists
    if (!settings["permissions"]) {
      settings["permissions"] = {};
    }
    const permissions = settings["permissions"] as Record<string, unknown>;
    if (!permissions["mcpServers"]) {
      permissions["mcpServers"] = {};
    }
    const mcpServers = permissions["mcpServers"] as Record<string, Record<string, unknown>>;

    if (options.clear) {
      delete mcpServers[server];
      writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf8");
      console.log(`Cleared all permission rules for "${server}" in ${scope} scope`);
      return;
    }

    // Build the permission entry
    if (!mcpServers[server]) {
      mcpServers[server] = {};
    }
    const serverPerms = mcpServers[server]!;

    // Default policy
    if (options.allowAll) {
      serverPerms["defaultPolicy"] = "allow";
    } else if (options.denyAll) {
      serverPerms["defaultPolicy"] = "deny";
    } else if (options.askAll) {
      serverPerms["defaultPolicy"] = "ask";
    } else if (options.default) {
      if (!["allow", "deny", "ask"].includes(options.default)) {
        console.error("Error: --default must be allow, deny, or ask");
        process.exit(1);
      }
      serverPerms["defaultPolicy"] = options.default;
    }

    // Allow patterns (append to existing)
    if (options.allow) {
      const existing = (serverPerms["allow"] as string[] | undefined) ?? [];
      const newPatterns = options.allow.split(",").map((p) => p.trim());
      serverPerms["allow"] = [...new Set([...existing, ...newPatterns])];
    }

    // Deny patterns (append to existing)
    if (options.deny) {
      const existing = (serverPerms["deny"] as string[] | undefined) ?? [];
      const newPatterns = options.deny.split(",").map((p) => p.trim());
      serverPerms["deny"] = [...new Set([...existing, ...newPatterns])];
    }

    writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf8");

    // Print summary
    const parts: string[] = [];
    if (serverPerms["defaultPolicy"]) parts.push(`default: ${serverPerms["defaultPolicy"]}`);
    if (serverPerms["allow"]) parts.push(`allow: ${(serverPerms["allow"] as string[]).join(", ")}`);
    if (serverPerms["deny"]) parts.push(`deny: ${(serverPerms["deny"] as string[]).join(", ")}`);
    console.log(`Updated permissions for "${server}" in ${scope} scope`);
    if (parts.length > 0) console.log(`  ${parts.join(" | ")}`);
  });
