/**
 * tools.ts — Restrict a tool set to an agent's allowlist.
 *
 * An agent's `tools` list uses permission syntax (`Read`, `Bash`,
 * `mcp__github__*`). A tool survives if any allowlist entry glob-matches either
 * its raw name (`read_file`, `mcp__github__create_issue`) or its canonical
 * permission name (`Read`, `Bash`). An undefined allowlist inherits everything.
 */
import type { ToolSet } from "ai";
import { matchGlob } from "@oxagen/mcp-config/permissions";
import { canonicalToolName } from "../settings/permissions-gate.js";

/** True when `toolName` is permitted by the agent's allowlist. */
export function toolAllowedForAgent(toolName: string, allow: string[] | undefined): boolean {
  if (!allow) return true;
  const canonical = canonicalToolName(toolName);
  return allow.some((entry) => matchGlob(entry, toolName) || matchGlob(entry, canonical));
}

/** Return the subset of `tools` an agent is allowed to use. */
export function filterToolsForAgent(tools: ToolSet, allow: string[] | undefined): ToolSet {
  if (!allow) return tools;
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    if (toolAllowedForAgent(name, allow)) out[name] = t;
  }
  return out;
}
