import "server-only";
import {
  resolveWorkbenchScope,
  type ResolvedWorkbenchScope,
} from "@/lib/workbench/scope";

/**
 * authz.ts — THE authorization choke point for the agent-tools surface.
 *
 * Every mutation that equips a workspace with agent tools or installs from
 * the marketplace — plugin install/toggle/uninstall, MCP server connect,
 * registry add/remove, GitHub MCP install, skill install/edit/activate —
 * MUST resolve its actor through `resolveAgentToolsManager`. Nothing else
 * in apps/app may make that decision.
 *
 * Why one seam: RBAC for this surface (a "Marketplace Install" role — see
 * docs/specs/rbac-permissions-plane.md) does not exist yet. When it lands,
 * swapping the `canManage` check below for the role lookup gates every
 * install path in the product at once, with zero call-site changes.
 *
 * Current policy: workspace Owner/Admin only.
 */
export const AGENT_TOOLS_NOT_AUTHORIZED =
  "Only workspace owners and admins can manage agent tools.";

export type AgentToolsManagerResult =
  | { ok: true; scope: ResolvedWorkbenchScope }
  | { ok: false; error: string };

/**
 * Resolve the session against the workspace and require manage rights.
 * Returns a discriminated result (server actions report errors as values,
 * not thrown redirects) carrying the full resolved scope on success.
 */
export async function resolveAgentToolsManager(
  orgSlug: string,
  workspaceSlug: string,
): Promise<AgentToolsManagerResult> {
  const scope = await resolveWorkbenchScope(orgSlug, workspaceSlug);
  if (!scope.canManage) {
    return { ok: false, error: AGENT_TOOLS_NOT_AUTHORIZED };
  }
  return { ok: true, scope };
}
