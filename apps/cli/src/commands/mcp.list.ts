/**
 * `oxagen mcp list` — List effective MCP servers (merged across all scopes).
 *
 * Shows each server with its transport, source scope, and auth status.
 * If --verbose, also shows the file paths being loaded and any warnings.
 */
import { Command } from "commander";
import { resolveSettings, getSettingsPaths, findProjectRoot } from "@oxagen/mcp-config/resolve";
import { loadManagedConfig, getManagedServers } from "@oxagen/mcp-config/managed";
import { readCredential } from "@oxagen/mcp-config/credentials";

export const mcpListLocalCommand = new Command("list")
  .description("List effective MCP servers from file-based configuration")
  .option("--verbose", "Show file paths and detailed configuration")
  .option("--json", "Output as JSON")
  .action(async (options: { verbose?: boolean; json?: boolean }) => {
    const projectRoot = findProjectRoot();
    const { settings, serverSources } = resolveSettings({ projectRoot });

    // Inject managed servers
    const managed = loadManagedConfig();
    const managedServers = getManagedServers(managed);

    // Build unified server list
    const allServers: Record<string, {
      config: unknown;
      scope: string;
      managed: boolean;
      authStatus: string;
    }> = {};

    // File-based servers
    for (const [name, config] of Object.entries(settings.mcpServers ?? {})) {
      const cred = readCredential(name);
      let authStatus = "none";
      if ("auth" in config && config.auth !== "none") {
        if (cred?.accessToken) {
          const expired = cred.expiresAt ? new Date(cred.expiresAt).getTime() < Date.now() : false;
          authStatus = expired ? "expired" : "authenticated";
        } else {
          authStatus = "not configured";
        }
      }
      allServers[name] = {
        config,
        scope: serverSources[name] ?? "unknown",
        managed: false,
        authStatus,
      };
    }

    // Managed servers (override file-based)
    for (const [name, config] of Object.entries(managedServers)) {
      allServers[name] = {
        config,
        scope: "managed",
        managed: true,
        authStatus: "org-managed",
      };
    }

    if (options.json) {
      console.log(JSON.stringify(allServers, null, 2));
      return;
    }

    // Pretty print
    const entries = Object.entries(allServers);
    if (entries.length === 0) {
      console.log("No MCP servers configured.");
      if (options.verbose) {
        const paths = getSettingsPaths(projectRoot);
        console.log("\nSearched:");
        console.log(`  User:    ${paths.user}`);
        console.log(`  Project: ${paths.project}`);
        console.log(`  Local:   ${paths.local}`);
      }
      return;
    }

    console.log("MCP Servers:\n");

    // Calculate column widths
    const nameWidth = Math.max(...entries.map(([n]) => n.length), 4);
    const transportWidth = 16;

    console.log(
      `  ${"NAME".padEnd(nameWidth)}  ${"TRANSPORT".padEnd(transportWidth)}  ${"SCOPE".padEnd(10)}  AUTH`,
    );
    console.log(
      `  ${"─".repeat(nameWidth)}  ${"─".repeat(transportWidth)}  ${"─".repeat(10)}  ${"─".repeat(16)}`,
    );

    for (const [name, info] of entries) {
      const config = info.config as Record<string, unknown>;
      const transport = (config["transport"] as string) ?? "unknown";
      const disabled = config["disabled"] === true;
      const prefix = disabled ? "  (disabled) " : "  ";

      console.log(
        `${prefix}${name.padEnd(nameWidth)}  ${transport.padEnd(transportWidth)}  ${info.scope.padEnd(10)}  ${info.authStatus}`,
      );
    }

    if (options.verbose) {
      const paths = getSettingsPaths(projectRoot);
      console.log("\nSettings files:");
      console.log(`  User:    ${paths.user}`);
      console.log(`  Project: ${paths.project}`);
      console.log(`  Local:   ${paths.local}`);
      if (managed) {
        console.log(`  Managed: synced ${managed._syncedAt} (org: ${managed._orgId})`);
      }
    }
  });
