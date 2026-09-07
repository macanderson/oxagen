/**
 * managed.ts — Org-level managed policy enforcement.
 *
 * Enterprise orgs can push a managed configuration file that acts as an
 * unoverridable floor, stored at ~/.config/oxagen/managed.json.
 *
 * The managed config file describes:
 *   - Org-provisioned servers (users can't remove or change auth)
 *   - `allowedServerUrls` / `deniedServerUrls` / `allowedCommands` allow- and
 *     denylists
 *   - `deniedTools`: tool-name patterns no user config can re-enable
 *
 * WHAT IS ACTUALLY ENFORCED. Every list above now reaches a runtime gate.
 * `validateServerAgainstPolicy` is called from
 * packages/agent/src/runtime/plugin-types/file-mcp.ts before a server is
 * connected — for stdio AND for every HTTP transport — so a refusal happens
 * before a process is spawned or a request leaves the machine. Managed servers
 * are still injected into the effective config, and tools matching
 * `deniedTools` are still dropped before they reach the model.
 *
 * This module used to be a policy API waiting to be wired.
 * `validateServerAgainstPolicy` had no caller, so `checkServerUrl` never ran
 * and `allowedServerUrls` governed nothing: an org could set it, the config
 * would validate, `oxagen mcp add` would succeed, the server would connect, and
 * nothing logged a word. An enterprise control that fails open and silently
 * (#1383). Meanwhile file-mcp.ts enforced `allowedCommands` through a private
 * copy of the matching logic that disagreed with `checkStdioCommand` on three
 * of four cases, in both directions (#1424) — that copy is gone and both paths
 * call this module.
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
 * Does `host` satisfy a pattern's host part?
 *
 * Compared as hostnames, case-insensitively, because that is what a hostname
 * is. A leading `*.` matches any subdomain but NOT the apex, which is the same
 * rule a wildcard certificate uses — `*.corp.com` covers `api.corp.com` and not
 * `corp.com`, so an operator who wants both writes both.
 */
function hostMatches(patternHost: string, host: string): boolean {
  const p = patternHost.toLowerCase();
  const h = host.toLowerCase();
  if (p === "*") return true;
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".corp.com"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return p === h;
}

/**
 * Match a server URL against one policy pattern, by PARSING both.
 *
 * This is deliberately not `matchGlob` over the raw string. Globbing a URL is
 * too weak to be a boundary, and this module's own comment said so before
 * anything enforced it: `*` expands across every separator, so a host allowlist
 * like `https://*.corp.com/*` also admits `https://evil.com/x.corp.com/y` —
 * the allowlist entry appears in the PATH of a host nobody allowed. In the other
 * direction a denylist entry misses trivial variations, because a raw-string
 * match is case-sensitive and blind to structure: `https://EVIL.com/`, a port,
 * or a `user@` prefix all slip past `https://evil.com/*`.
 *
 * So each part is compared as the thing it is:
 *
 * - **scheme** — exact, case-insensitive. A pattern with no `://` is read as
 *   host-and-path, and then any scheme matches.
 * - **host** — {@link hostMatches}, so a wildcard binds to a domain label and
 *   cannot reach across into a path.
 * - **port** — compared only when the pattern names one, so `https://corp.com`
 *   covers every port on that host and `https://corp.com:8443` covers exactly
 *   one.
 * - **path** — globbed with {@link matchGlob}, where `*` across separators is
 *   the useful behaviour. An empty pattern path matches any path.
 *
 * A URL that does not parse matches nothing, so an unparseable URL fails an
 * allowlist (refused) and is not silently exempted from a denylist by a pattern
 * that would otherwise catch it — see {@link checkServerUrl}, which refuses it
 * outright.
 */
export function matchUrlPattern(pattern: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const separator = pattern.indexOf("://");
  const schemePattern =
    separator === -1 ? null : pattern.slice(0, separator).toLowerCase();
  const remainder = separator === -1 ? pattern : pattern.slice(separator + 3);

  if (schemePattern !== null) {
    // URL.protocol keeps the trailing colon.
    if (parsed.protocol.slice(0, -1).toLowerCase() !== schemePattern) {
      return false;
    }
  }

  const slash = remainder.indexOf("/");
  const authorityPattern = slash === -1 ? remainder : remainder.slice(0, slash);
  const pathPattern = slash === -1 ? "" : remainder.slice(slash);

  const colon = authorityPattern.lastIndexOf(":");
  const hostPattern =
    colon === -1 ? authorityPattern : authorityPattern.slice(0, colon);
  const portPattern = colon === -1 ? null : authorityPattern.slice(colon + 1);

  if (!hostMatches(hostPattern, parsed.hostname)) return false;
  if (portPattern !== null && portPattern !== "" && portPattern !== "*") {
    if (parsed.port !== portPattern) return false;
  }

  if (pathPattern === "" || pathPattern === "/*") return true;
  return matchGlob(pathPattern, parsed.pathname);
}

/**
 * Check whether a server URL is permitted by the managed policy.
 * Returns null if allowed, or a PolicyViolation describing the block.
 *
 * Matching is structural — see {@link matchUrlPattern}. The denylist is
 * consulted first, so a denied URL stays denied however permissive the
 * allowlist is.
 */
export function checkServerUrl(
  url: string,
  policy: ManagedPolicy | undefined,
): PolicyViolation | null {
  if (!policy) return null;

  const hasAllowlist =
    policy.allowedServerUrls !== undefined &&
    policy.allowedServerUrls.length > 0;
  const hasDenylist =
    policy.deniedServerUrls !== undefined && policy.deniedServerUrls.length > 0;
  if (!hasAllowlist && !hasDenylist) return null;

  // A URL the runtime cannot parse cannot be checked against either list, and
  // a policy that is in force must not admit what it cannot inspect.
  let parseable = true;
  try {
    new URL(url);
  } catch {
    parseable = false;
  }
  if (!parseable) return { type: "url_not_allowed", url };

  // Denylist takes priority
  if (policy.deniedServerUrls) {
    for (const pattern of policy.deniedServerUrls) {
      if (matchUrlPattern(pattern, url)) {
        return { type: "url_denied", url, pattern };
      }
    }
  }

  // Allowlist: if non-empty, the URL must match at least one pattern
  if (hasAllowlist) {
    const allowed = (policy.allowedServerUrls ?? []).some((pattern) =>
      matchUrlPattern(pattern, url),
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
 *
 * Only the `allowedCommands` allowlist is consulted — ManagedPolicy has no
 * `deniedCommands` field, so the `command_denied` variant of PolicyViolation is
 * unreachable until one is added.
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
/**
 * Render a violation for a human. Each message names the policy KEY that
 * refused, so an operator reading a log line knows which list to edit rather
 * than which of four to guess at.
 */
export function formatViolation(violation: PolicyViolation): string {
  switch (violation.type) {
    case "url_denied":
      return `Blocked by organization policy: URL "${violation.url}" matches denied pattern "${violation.pattern}" (managedPolicy.deniedServerUrls). Contact your admin.`;
    case "url_not_allowed":
      return `Blocked by organization policy: URL "${violation.url}" is not in the allowed server list (managedPolicy.allowedServerUrls). Contact your admin.`;
    case "command_not_allowed":
      return `Blocked by organization policy: command "${violation.command}" is not in the allowed command list (managedPolicy.allowedCommands). Contact your admin.`;
    case "command_denied":
      return `Blocked by organization policy: command "${violation.command}" matches denied pattern "${violation.pattern}" (managedPolicy.deniedCommands). Contact your admin.`;
    case "tool_denied":
      return `Blocked by organization policy: tool "${violation.tool}" matches denied pattern "${violation.pattern}".`;
  }
}
