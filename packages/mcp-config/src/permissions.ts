/**
 * permissions.ts — Evaluates allow/deny/ask rules for MCP tool invocations.
 *
 * Given a (serverName, toolName) pair and the resolved Permissions config,
 * determines the effective policy decision. Rules use glob patterns for
 * flexible matching (e.g. "delete_*", "query_*", "*").
 *
 * Evaluation order (first match wins):
 *   1. Per-server deny rules (explicit block — highest priority)
 *   2. Per-server allow rules (explicit permit)
 *   3. Per-server defaultPolicy
 *   4. Global defaultMcpPolicy
 *
 * This mirrors Claude Code's permission model where deny always wins over
 * allow at the same scope level, and more specific rules override defaults.
 */
import type { Permissions, ServerPermission } from "./schema.ts";

export type PermissionDecision = "allow" | "deny" | "ask";

export interface PermissionResult {
  decision: PermissionDecision;
  /** Human-readable reason for the decision (useful for CLI output). */
  reason: string;
  /** The rule pattern that matched (if any). */
  matchedPattern?: string;
}

// ── Glob Matching ─────────────────────────────────────────────────────────────

/**
 * Match a tool name against a glob pattern.
 * Supports:
 *   - "*" matches everything
 *   - "prefix_*" matches any tool starting with "prefix_"
 *   - "*_suffix" matches any tool ending with "_suffix"
 *   - "exact_name" matches exactly
 *   - "prefix_*_suffix" matches tools with that prefix and suffix
 *
 * This is intentionally simple — not a full glob library — to keep the
 * permission rules predictable and debuggable. Two consequences worth knowing
 * before reusing it outside tool names:
 *
 *   - `*` compiles to `.*`, which crosses every separator. It is safe on flat
 *     tool names but NOT on structured values: `https://*.corp.com/*` also
 *     matches `https://evil.com/x.corp.com/y`. See checkServerUrl in managed.ts.
 *   - Matching is byte-exact and case-sensitive, with no normalization of the
 *     value, so a denylist entry is only as good as the exact spelling it was
 *     written against.
 */
export function matchGlob(pattern: string, value: string): boolean {
  // Exact match (no wildcards)
  if (!pattern.includes("*")) {
    return pattern === value;
  }

  // Universal wildcard
  if (pattern === "*") return true;

  // Convert glob pattern to regex:
  // Escape regex special chars except *, then replace * with .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexStr = `^${escaped.replace(/\*/g, ".*")}$`;
  try {
    return new RegExp(regexStr).test(value);
  } catch {
    // Invalid pattern — treat as no match rather than crashing
    return false;
  }
}

// ── Permission Evaluation ─────────────────────────────────────────────────────

/**
 * Evaluate the permission decision for a specific tool invocation.
 *
 * @param serverName - The MCP server name (as defined in settings.json keys)
 * @param toolName   - The tool name as advertised by the MCP server
 * @param permissions - The resolved (merged) permissions config
 */
export function evaluatePermission(
  serverName: string,
  toolName: string,
  permissions: Permissions | undefined,
): PermissionResult {
  if (!permissions) {
    return {
      decision: "ask",
      reason: "no permissions configured; defaulting to ask",
    };
  }

  const serverPerms: ServerPermission | undefined =
    permissions.mcpServers?.[serverName];

  if (serverPerms) {
    // 1. Check deny rules first (deny always wins at same scope)
    if (serverPerms.deny) {
      for (const pattern of serverPerms.deny) {
        if (matchGlob(pattern, toolName)) {
          return {
            decision: "deny",
            reason: `denied by server rule: "${pattern}"`,
            matchedPattern: pattern,
          };
        }
      }
    }

    // 2. Check allow rules
    if (serverPerms.allow) {
      for (const pattern of serverPerms.allow) {
        if (matchGlob(pattern, toolName)) {
          return {
            decision: "allow",
            reason: `allowed by server rule: "${pattern}"`,
            matchedPattern: pattern,
          };
        }
      }
    }

    // 3. Per-server default policy
    if (serverPerms.defaultPolicy) {
      return {
        decision: serverPerms.defaultPolicy,
        reason: `server default policy: ${serverPerms.defaultPolicy}`,
      };
    }
  }

  // 4. Global default
  const globalDefault = permissions.defaultMcpPolicy ?? "ask";
  return {
    decision: globalDefault,
    reason: `global default policy: ${globalDefault}`,
  };
}

// ── Tool Visibility ───────────────────────────────────────────────────────────

/**
 * Structurally identical to `ToolVisibility` in schema.ts. It exists so this
 * module stays independent of Zod; keep the two in step when either changes.
 */
export interface ToolVisibilityConfig {
  include?: string[];
  exclude?: string[];
}

/**
 * Filter a list of tool names through the visibility rules for a server.
 * Returns only the tools that should be advertised to the model.
 *
 * Logic:
 *   - If `include` is set, only tools matching at least one include pattern pass
 *   - Then, any tool matching an exclude pattern is removed
 *   - If neither is set, all tools pass through
 */
export function filterToolVisibility(
  toolNames: string[],
  visibility: ToolVisibilityConfig | undefined,
): string[] {
  if (!visibility) return toolNames;

  let filtered = toolNames;

  // Apply include filter (whitelist)
  if (visibility.include && visibility.include.length > 0) {
    filtered = filtered.filter((tool) =>
      visibility.include!.some((pattern) => matchGlob(pattern, tool)),
    );
  }

  // Apply exclude filter (blacklist)
  if (visibility.exclude && visibility.exclude.length > 0) {
    filtered = filtered.filter(
      (tool) =>
        !visibility.exclude!.some((pattern) => matchGlob(pattern, tool)),
    );
  }

  return filtered;
}

// ── Batch Evaluation ──────────────────────────────────────────────────────────

/**
 * Evaluate permissions for all tools on a server at once.
 * Returns a map of tool name → decision. Useful for pre-computing the tool
 * set before materializing (so denied tools are never shown to the model).
 */
export function evaluateServerPermissions(
  serverName: string,
  toolNames: string[],
  permissions: Permissions | undefined,
): Map<string, PermissionResult> {
  const results = new Map<string, PermissionResult>();
  for (const tool of toolNames) {
    results.set(tool, evaluatePermission(serverName, tool, permissions));
  }
  return results;
}

/**
 * Get only the tools that are NOT denied for a server. Tools with "ask" or
 * "allow" decisions are included (the runtime handles the ask flow).
 * Denied tools are never advertised to the model.
 */
export function getNonDeniedTools(
  serverName: string,
  toolNames: string[],
  permissions: Permissions | undefined,
): string[] {
  return toolNames.filter((tool) => {
    const result = evaluatePermission(serverName, tool, permissions);
    return result.decision !== "deny";
  });
}
