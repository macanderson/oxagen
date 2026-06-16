/**
 * page.tsx — Workspace → Automation → Agents.
 *
 * The agent management surface now lives at the workspace-level /agents route
 * (real, wired to agent.definition.* / agent.trigger.* / agent.deploy). This
 * legacy Automation tab redirects there so there is a single source of truth —
 * no duplicate static mock.
 */
import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

export default async function AutomationAgentsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspace.agents.root({ orgSlug, workspaceSlug }));
}
