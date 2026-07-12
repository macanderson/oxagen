/**
 * fleet-list-section.tsx — async server component that fetches subagent
 * fan-outs via list_subagent_fanouts and renders <FleetListClient>. Sits
 * inside a Suspense boundary (via <Section>) so the page header renders
 * immediately while this streams in.
 *
 * Auth note (same as knowledge/memories, activity/activity-section): apps/app
 * does NOT bootstrap IAM, so invoke() skips role checks here; the caller
 * (page.tsx) already gated org membership via resolveWorkbenchScope.
 * list_subagent_fanouts declares surfaces ["api","mcp","agent"] — pass
 * surface "agent" (passing "app" would throw surface_denied).
 */
import "@oxagen/handlers/register";
// list_subagent_fanouts is an agent.* capability bound by @oxagen/agent/register,
// NOT the foundation register — without this invoke() throws "No handler
// registered for capability list_subagent_fanouts" (mirrors memories-section.tsx).
import "@oxagen/agent/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { AgentSubagentFanoutListOutput } from "@oxagen/oxagen/contracts/agent.subagent_fanout.list";
import { buildWorkbenchCtx } from "@/lib/workbench/scope";
import { FleetListClient } from "./fleet-list-client";

interface FleetListSectionProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
  canManage: boolean;
}

export async function FleetListSection({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
  canManage,
}: FleetListSectionProps) {
  const ctx = buildWorkbenchCtx({ orgId, workspaceId, userId });

  let fanouts: AgentSubagentFanoutListOutput["fanouts"] = [];
  try {
    const result = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke("list_subagent_fanouts", { limit: 50 }, ctx, { surface: "agent" }),
    )) as AgentSubagentFanoutListOutput;
    fanouts = result.fanouts;
  } catch (e) {
    // Never throw from an RSC — render the empty state on failure.
    console.error("list_subagent_fanouts failed:", e);
  }

  return (
    <FleetListClient
      fanouts={fanouts}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      canManage={canManage}
    />
  );
}
