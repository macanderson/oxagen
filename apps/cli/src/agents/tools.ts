/**
 * tools.ts — Restrict a tool set to an agent's allowlist.
 *
 * Agent TOML stores canonical Oxagen tool/capability slugs. Runtime filtering is
 * exact: foreign aliases and wildcard permission classes belong exclusively to
 * the import mapper and can never broaden an activated agent's authority.
 */
import type { ToolSet } from "ai";

/** True when `toolName` is permitted by the agent's allowlist. */
export function toolAllowedForAgent(
  toolName: string,
  allow: string[] | undefined,
): boolean {
  if (!allow) return true;
  return allow.includes(toolName);
}

/** Return the subset of `tools` an agent is allowed to use. */
export function filterToolsForAgent(
  tools: ToolSet,
  allow: string[] | undefined,
): ToolSet {
  if (!allow) return tools;
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    if (toolAllowedForAgent(name, allow)) out[name] = t;
  }
  return out;
}
