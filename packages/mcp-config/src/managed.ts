/**
 * managed.ts — Org-level managed policy enforcement.
 *
 * Enterprise orgs can push a managed configuration file that acts as an
 * unoverridable floor, stored at ~/.config/oxagen/managed.json.
 *
 * The managed policy provides:
 *   - Org-provisioned servers (users can't remove or change auth)
 *   - Allowlist: only permitted server URLs/commands can be registered
 *   - Denylist: blocked URLs/commands/tools that no user config can override
 *
 * Enforcement today happens at tool materialization time: managed servers
 * are injected into the effective config, and tools matching deniedTools
 * are dropped before they reach the model.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  managedConfigSchema,
  type ManagedConfig,
  type ManagedPolicy,
  type McpServerConfig,
} from "./schema";
import { matchGlob } from "./permissions";

// ── Paths ─────────────────────────────────────────────────────────────────────

const MANAGED_CONFIG_PATH = join(
  homedir(),
  ".config",
  "oxagen",
  "managed.json",
);

export function getManagedConfigPath(): string {
  return MANAGED_CONFIG_PATH;
}

// ── Loading ───────────────────────────────────────────────────────────────────

/**
 * Load the managed config file. Returns null if:
 *   - The file doesn't exist (org hasn't pushed a policy)
 *   - The file is invalid (parse failure logged to stderr)
 */
export function loadManagedConfig(path?: string): ManagedConfig | null {
  const filePath = path ?? MANAGED_CONFIG_PATH;
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const json: unknown = JSON.parse(raw);
    const result = managedConfigSchema.safeParse(json);
    if (!result.success) {
      process.stderr.write(
        `Warning: invalid managed config at ${filePath}: ${result.error.message}\n`,
      );
      return null;
    }
    return result.data;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `Warning: failed to read managed config from ${filePath}: ${detail}\n`,
    );
    return null;
  }
}

// ── Policy Enforcement ────────────────────────────────────────────────────────

export type PolicyViolation =
  | { type: "url_denied"; url: string; pattern: string }
  | { type: "url_not_allowed"; url: string }
  | { type: "command_denied"; command: string; pattern: string }
  | { type: "command_not_allowed"; command: string }
  | { type: "tool_denied"; tool: string; pattern: string };

/**
 * Check whether a server URL is permitted by the managed policy.
 * Returns null if allowed, or a PolicyViolation describing the block.
 */
export function checkServerUrl(
  url: string,
  policy: ManagedPolicy | undefined,
): PolicyViolation | null {
  if (!policy) return null;

  // Denylist takes priority
  if (policy.deniedServerUrls) {
    for (const pattern of policy.deniedServerUrls) {
      if (matchGlob(pattern, url)) {
        return { type: "url_denied", url, pattern };
      }
    }
  }

  // Allowlist: if non-empty, the URL must match at least one pattern
  if (policy.allowedServerUrls && policy.allowedServerUrls.length > 0) {
    const allowed = policy.allowedServerUrls.some((pattern) =>
      matchGlob(pattern, url),
    );
    if (!allowed) {
      return { type: "url_not_allowed", url };
    }
  }

  return null;
}

/**
 * Check whether a stdio command is permitted by the managed policy.
 * The full command string is "command arg1 arg2 ...".
 * Returns null if allowed, or a PolicyViolation describing the block.
 */
export function checkStdioCommand(
  command: string,
  args: string[],
  policy: ManagedPolicy | undefined,
): PolicyViolation | null {
  if (!policy) return null;

  const fullCommand = [command, ...args].join(" ");

  // Allowlist: if non-empty, the command must match at least one pattern
  if (policy.allowedCommands && policy.allowedCommands.length > 0) {
    const allowed = policy.allowedCommands.some((pattern) =>
      matchGlob(pattern, fullCommand),
    );
    if (!allowed) {
      return { type: "command_not_allowed", command: fullCommand };
    }
  }

  return null;
}

/**
 * Check whether a tool invocation is blocked by the managed policy's deniedTools.
 * Tool patterns are checked as "serverName.toolName" or just "toolName" with wildcards.
 * Returns null if allowed, or a PolicyViolation describing the block.
 */
export function checkToolDenied(
  serverName: string,
  toolName: string,
  policy: ManagedPolicy | undefined,
): PolicyViolation | null {
  if (!policy?.deniedTools) return null;

  // Check both qualified (server.tool) and unqualified (tool) forms
  const qualified = `${serverName}.${toolName}`;

  for (const pattern of policy.deniedTools) {
    if (matchGlob(pattern, toolName) || matchGlob(pattern, qualified)) {
      return { type: "tool_denied", tool: qualified, pattern };
    }
  }

  return null;
}

/**
 * Validate a server config against the managed policy before registration.
 *
 * @returns null if the server is permitted, or a PolicyViolation explaining the block
 */
export function validateServerAgainstPolicy(
  serverName: string,
  config: McpServerConfig,
  managed: ManagedConfig | null,
): PolicyViolation | null {
  if (!managed?.managedPolicy) return null;
  const policy = managed.managedPolicy;

  if (config.transport === "stdio") {
    return checkStdioCommand(config.command, config.args, policy);
  }

  // All HTTP-based transports check the URL
  if ("url" in config) {
    return checkServerUrl(config.url, policy);
  }

  return null;
}

// ── Managed Server Injection ──────────────────────────────────────────────────

/**
 * Get managed servers that should be injected into the effective config.
 * These are org-provisioned servers that cannot be removed or have their auth
 * overridden by user/project/local config.
 */
export function getManagedServers(
  managed: ManagedConfig | null,
): Record<string, McpServerConfig> {
  if (!managed?.mcpServers) return {};
  // Strip the `managed: true` field since it's metadata, not transport config
  const out: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(managed.mcpServers)) {
    const { managed: _managed, ...serverConfig } = config as McpServerConfig & {
      managed: true;
    };
    out[name] = serverConfig;
  }
  return out;
}

/**
 * Check if a server name is managed (org-provisioned). Managed servers cannot
 * be removed, disabled, or have their auth overridden by user config.
 */
export function isManagedServer(
  serverName: string,
  managed: ManagedConfig | null,
): boolean {
  return managed?.mcpServers?.[serverName] !== undefined;
}

// ── Policy Violation Formatting ───────────────────────────────────────────────

/**
 * Format a PolicyViolation into a user-friendly error message.
 */
export function formatViolation(violation: PolicyViolation): string {
  switch (violation.type) {
    case "url_denied":
      return `Blocked by organization policy: URL "${violation.url}" matches denied pattern "${violation.pattern}". Contact your admin.`;
    case "url_not_allowed":
      return `Blocked by organization policy: URL "${violation.url}" is not in the allowed server list. Contact your admin.`;
    case "command_not_allowed":
      return `Blocked by organization policy: command "${violation.command}" is not in the allowed command list. Contact your admin.`;
    case "command_denied":
      return `Blocked by organization policy: command "${violation.command}" matches denied pattern "${violation.pattern}". Contact your admin.`;
    case "tool_denied":
      return `Blocked by organization policy: tool "${violation.tool}" matches denied pattern "${violation.pattern}".`;
  }
}
