/**
 * `oxagen mcp remove <name>` — Remove an MCP server from file-based configuration.
 *
 * Removes the server entry from the specified scope. Managed servers cannot
 * be removed. Also deletes stored credentials unless --keep-credentials.
 */
import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadManagedConfig, isManagedServer } from "@oxagen/mcp-config/managed";
import { deleteCredential } from "@oxagen/mcp-config/credentials";
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

export const mcpRemoveCommand = new Command("remove")
  .description("Remove an MCP server from file-based configuration")
  .argument("<name>", "Server name to remove")
  .option("--scope <scope>", "Config scope to remove from: user, project, local", "project")
  .option("--keep-credentials", "Do not delete stored credentials for this server")
  .action(async (name: string, options: { scope: string; keepCredentials?: boolean }) => {
    const scope = options.scope as Scope;
    const projectRoot = findProjectRoot();

    // Cannot remove managed servers
    const managed = loadManagedConfig();
    if (isManagedServer(name, managed)) {
      console.error(`Error: "${name}" is a managed server provisioned by your organization and cannot be removed.`);
      process.exit(1);
    }

    const filePath = getSettingsPath(scope, projectRoot);
    if (!existsSync(filePath)) {
      console.error(`Error: no settings file found at ${filePath}`);
      process.exit(1);
    }

    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    } catch {
      console.error(`Error: failed to parse ${filePath}`);
      process.exit(1);
    }

    const mcpServers = (settings["mcpServers"] ?? {}) as Record<string, unknown>;
    if (!(name in mcpServers)) {
      console.error(`Error: server "${name}" not found in ${scope} scope (${filePath})`);
      process.exit(1);
    }

    delete mcpServers[name];
    settings["mcpServers"] = mcpServers;
    writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf8");

    // Clean up credentials unless --keep-credentials
    if (!options.keepCredentials) {
      deleteCredential(name);
    }

    console.log(`Removed MCP server "${name}" from ${scope} scope (${filePath})`);
  });
