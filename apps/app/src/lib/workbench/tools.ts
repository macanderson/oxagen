/**
 * workbench/tools.ts — server-side wrapper over agent.tool.list.
 *
 * Returns the workspace's capabilities surfaced as agent tools (after allowlist
 * + risk filtering). Used by the Tools catalog page and by the Agent Builder's
 * Equip step (the "Tools" tab of the uniform agentTools picker).
 *
 * Server-only.
 */
import "@oxagen/handlers/register";
// `list_agent_tools` is bound by @oxagen/agent's LOADERS map, not the
// foundation handlers — without this side-effect import the kernel throws
// "No handler registered for capability" at runtime.
import "@oxagen/agent/register";
import { invoke } from "@oxagen/oxagen";
import type { WorkbenchCtx } from "./scope";

export type AgentToolRow = {
  name: string;
  description: string;
  domain: string;
  category: string | null;
  riskLevel: "low" | "medium" | "high";
  requiresApproval: boolean;
  external: boolean;
};

export async function listAgentTools(
  ctx: WorkbenchCtx,
  includeExternal = true,
): Promise<AgentToolRow[]> {
  const out = (await invoke("list_agent_tools", { includeExternal }, ctx, {
    surface: "agent",
  })) as { tools: AgentToolRow[] };
  return out.tools;
}
