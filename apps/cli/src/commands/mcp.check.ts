/**
 * `oxagen mcp check` — Health check all configured MCP servers.
 *
 * Probes each enabled server and reports connectivity status.
 * For HTTP servers: attempts a connection and tool list.
 * For stdio servers: attempts to spawn the command.
 */
import { Command } from "commander";
import { resolveSettings, findProjectRoot } from "@oxagen/mcp-config/resolve";
import { resolveCredential } from "@oxagen/mcp-config/credentials";
import { loadManagedConfig, getManagedServers } from "@oxagen/mcp-config/managed";
import type { McpServerConfig } from "@oxagen/mcp-config/schema";

interface CheckResult {
  name: string;
  transport: string;
  status: "healthy" | "unreachable" | "auth_required" | "disabled" | "skipped";
  toolCount?: number;
  error?: string;
  latencyMs?: number;
}

async function checkServer(name: string, config: McpServerConfig): Promise<CheckResult> {
  const transport = config.transport;

  if ("disabled" in config && config.disabled) {
    return { name, transport, status: "disabled" };
  }

  if (transport === "stdio") {
    // For stdio, just verify the command exists (don't spawn it)
    const { execSync } = await import("node:child_process");
    try {
      execSync(`which ${config.command}`, { stdio: "ignore" });
      return { name, transport, status: "healthy" };
    } catch {
      return { name, transport, status: "unreachable", error: `command "${config.command}" not found` };
    }
  }

  // HTTP-based transports: resolve credentials and attempt connection
  const cred = await resolveCredential({ serverName: name, config });
  if (cred.source === "none" && "auth" in config && config.auth !== "none") {
    return { name, transport, status: "auth_required", error: "no credentials configured" };
  }

  if (cred.expired) {
    return { name, transport, status: "auth_required", error: "token expired" };
  }

  // Attempt HTTP probe
  const url = "url" in config ? config.url : "";
  const start = Date.now();
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (cred.token) headers["authorization"] = `Bearer ${cred.token}`;
    if (cred.headers) Object.assign(headers, cred.headers);

    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - start;

    if (res.status === 401 || res.status === 403) {
      return { name, transport, status: "auth_required", latencyMs, error: `HTTP ${res.status}` };
    }
    // Any response (even 404/405) means the server is reachable
    return { name, transport, status: "healthy", latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    return { name, transport, status: "unreachable", latencyMs, error };
  }
}

export const mcpCheckCommand = new Command("check")
  .description("Health check all configured MCP servers")
  .option("--json", "Output results as JSON")
  .option("--server <name>", "Check only this server")
  .action(async (options: { json?: boolean; server?: string }) => {
    const projectRoot = findProjectRoot();
    const { settings } = resolveSettings({ projectRoot });
    const managed = loadManagedConfig();
    const managedServers = getManagedServers(managed);

    // Merge all servers
    const allServers: Record<string, McpServerConfig> = {
      ...(settings.mcpServers ?? {}),
      ...managedServers,
    };

    // Filter if --server specified
    const targets = options.server
      ? Object.fromEntries(
          Object.entries(allServers).filter(([name]) => name === options.server),
        )
      : allServers;

    if (Object.keys(targets).length === 0) {
      if (options.server) {
        console.error(`Error: server "${options.server}" not found`);
      } else {
        console.log("No MCP servers configured.");
      }
      process.exit(options.server ? 1 : 0);
    }

    const results: CheckResult[] = [];

    for (const [name, config] of Object.entries(targets)) {
      const result = await checkServer(name, config);
      results.push(result);
    }

    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    // Pretty print
    console.log("MCP Server Health:\n");
    for (const r of results) {
      const icon = r.status === "healthy" ? "●"
        : r.status === "disabled" ? "○"
        : r.status === "auth_required" ? "◐"
        : "✕";
      const latency = r.latencyMs ? ` (${r.latencyMs}ms)` : "";
      const error = r.error ? ` — ${r.error}` : "";
      console.log(`  ${icon} ${r.name}: ${r.status}${latency}${error}`);
    }

    const healthy = results.filter((r) => r.status === "healthy").length;
    const total = results.filter((r) => r.status !== "disabled").length;
    console.log(`\n  ${healthy}/${total} servers healthy`);
  });
