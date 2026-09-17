/**
 * The Claude Desktop config writer — the first *connected*-tier harness
 * (ADR-078). Claude Desktop exposes no hook surface, so Tacho cannot see the
 * actions it takes; what it can do is serve the workspace toolbelt through
 * the collector's loopback gateway and refuse, server-side, any call the
 * mandate does not allow.
 *
 * ## Paths, verified 2026-09-16
 *
 * Against the MCP quickstart (https://modelcontextprotocol.io/quickstart/user),
 * which is Anthropic's own documentation for adding a local server:
 *
 *   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
 *   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
 *   - Linux: **no path, because there is no official build.** The quickstart
 *     states "Claude Desktop is available for macOS and Windows". Paths in
 *     circulation for Linux belong to unofficial community ports, and writing
 *     a config for a binary Anthropic does not ship would be a file nothing
 *     reads. `claudeDesktopConfigPath` returns undefined there, and the app
 *     says the harness is unavailable on this platform rather than pretending
 *     it enrolled.
 *
 * ## Transport, verified 2026-09-16
 *
 * `claude_desktop_config.json` is **stdio only**. The documented entry shape
 * is `{ command, args, env? }`; no `type`, `transport` or `url` member is
 * documented for this file anywhere. Remote HTTP and SSE servers are added
 * through Settings → Connectors → "Add custom connector" in the app, a UI flow
 * no third party can write to. So this writer always emits the stdio entry and
 * the `tacho mcp-stdio` shim dials the loopback gateway on the app's behalf.
 *
 * ## Restart, verified 2026-09-16
 *
 * Required, and stated as such: "After saving the configuration file,
 * completely quit Claude Desktop and restart it." The app tells the user this
 * in plain words rather than writing the file and leaving them to wonder why
 * nothing happened — see `CLAUDE_DESKTOP_RESTART_NOTE`.
 *
 * ## What this writer cannot do, and why the product says so
 *
 * Nothing stops the user adding a second MCP server beside ours, and a tool
 * served by that server never reaches Oxagen. Anthropic's enterprise controls
 * (`com.anthropic.claudefordesktop` on macOS, `HKLM:\SOFTWARE\Policies\Claude`
 * on Windows) carry `isLocalDevMcpEnabled` and its siblings, which are
 * **on/off switches for local MCP as a whole**, not a named-server allowlist;
 * the one real allowlist Anthropic ships governs the Desktop Extension
 * (`.mcpb`) registry, not hand-written entries in this file. So the connected
 * tier on this app is advisory with respect to *other* servers, and ADR-078 §3
 * requires every surface to say so instead of implying coverage it does not
 * have. `oxagenMcpPresence` returns the count and names of those other servers
 * for exactly that purpose.
 */
import { join } from "node:path";
import {
  type GatewayInstallConfig,
  type McpMergeResult,
  type McpServerEntry,
  type McpStripResult,
  mergeOxagenMcpServer,
  type McpServerPresence,
  oxagenMcpPresence,
  stripOxagenMcpServer,
} from "./mcp-config-writer";

/** Claude Desktop ships for these platforms and no others. */
export const CLAUDE_DESKTOP_PLATFORMS: ReadonlyArray<NodeJS.Platform> = [
  "darwin",
  "win32",
];

export const CLAUDE_DESKTOP_RESTART_NOTE =
  "Quit Claude Desktop completely and open it again. It reads this file only at startup, so the Oxagen tools appear on the next launch.";

/**
 * Where Claude Desktop keeps its MCP config, or undefined on a platform it
 * does not ship for. `APPDATA` is honoured on Windows because a roaming
 * profile moves it; the macOS path has no such override.
 */
export function claudeDesktopConfigPath(
  platform: NodeJS.Platform,
  home: string,
  env: Record<string, string | undefined> = {},
): string | undefined {
  if (platform === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (platform === "win32") {
    const appData = env["APPDATA"] ?? join(home, "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  return undefined;
}

/** Add the Oxagen gateway to Claude Desktop's config. Always stdio. */
export function mergeClaudeDesktopConfig(
  existing: unknown,
  config: GatewayInstallConfig,
): McpMergeResult {
  return mergeOxagenMcpServer(existing, config, "stdio");
}

/** Remove it again, restoring whatever it displaced. */
export function stripClaudeDesktopConfig(
  existing: unknown,
  enrollmentId?: string,
  restore: Record<string, McpServerEntry> = {},
): McpStripResult {
  return stripOxagenMcpServer(existing, enrollmentId, restore);
}

/** What is installed, and how much of this app routes around us. */
export function claudeDesktopPresence(
  existing: unknown,
  enrollmentId: string,
): McpServerPresence {
  return oxagenMcpPresence(existing, enrollmentId);
}
