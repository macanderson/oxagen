/**
 * studio/tools.ts — server-side wrapper over agent.tool.list.
 *
 * Returns the workspace's capabilities surfaced as agent tools (after allowlist
 * + risk filtering). Used by the Tools catalog page and by the Agent Builder's
 * Equip step (the "Tools" tab of the uniform agentTools picker).
 *
 * Server-only.
 */
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import type { StudioCtx } from "./scope";

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
  ctx: StudioCtx,
  includeExternal = true,
): Promise<AgentToolRow[]> {
  const out = (await invoke(
    "agent.tool.list",
    { includeExternal },
    ctx,
    { surface: "agent" },
  )) as { tools: AgentToolRow[] };
  return out.tools;
}
