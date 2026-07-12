/**
 * fleet-detail-section.tsx — async server component for one fan-out's detail
 * view. Fetches get_subagent_fanout (the per-child row table — capability,
 * status, timing, error, input/output byte sizes) and aggregate_subagents
 * (the rolled-up status/timeline/conflicts used for the timeline strip) in
 * parallel, then renders <FleetDetailClient>. Each read fails independently —
 * a missing aggregate never blocks the child table, and vice versa.
 *
 * Auth note: apps/app does NOT bootstrap IAM; the caller (page.tsx) already
 * gated org membership via resolveWorkbenchScope. Both capabilities declare
 * surfaces ["api","mcp","agent"] — pass surface "agent".
 */
import "@oxagen/handlers/register";
// get_subagent_fanout / aggregate_subagents are agent.* capabilities bound by
// @oxagen/agent/register, NOT the foundation register — without this invoke()
// throws "No handler registered" (mirrors memories-section.tsx).
import "@oxagen/agent/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import { isFanoutNotFoundError } from "@oxagen/agent";
import type { AgentSubagentFanoutGetOutput } from "@oxagen/oxagen/contracts/agent.subagent_fanout.get";
import type { AgentSubagentAggregateOutput } from "@oxagen/oxagen/contracts/agent.subagent.aggregate";
import { buildWorkbenchCtx } from "@/lib/workbench/scope";
import { ErrorState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { FleetDetailClient } from "./fleet-detail-client";

interface FleetDetailSectionProps {
  fanoutId: string;
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
  canManage: boolean;
}

export async function FleetDetailSection({
  fanoutId,
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
  canManage,
}: FleetDetailSectionProps) {
  const ctx = buildWorkbenchCtx({ orgId, workspaceId, userId });

  let fanout: AgentSubagentFanoutGetOutput | null = null;
  let notFound = false;
  try {
    fanout = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke("get_subagent_fanout", { fanoutId }, ctx, { surface: "agent" }),
    )) as AgentSubagentFanoutGetOutput;
  } catch (e) {
    if (isFanoutNotFoundError(e)) {
      notFound = true;
    } else {
      // Never throw from an RSC — render the error state on transient failure.
      console.error("get_subagent_fanout failed:", e);
    }
  }

  let aggregate: AgentSubagentAggregateOutput | null = null;
  if (!notFound) {
    try {
      aggregate = (await runInTenantScope({ orgId, workspaceId }, () =>
        invoke(
          "aggregate_subagents",
          { fanoutId, includeOutputs: false, includeMerged: false },
          ctx,
          { surface: "agent" },
        ),
      )) as AgentSubagentAggregateOutput;
    } catch (e) {
      // The timeline strip degrades gracefully without aggregate data — the
      // per-child table (from get_subagent_fanout) still renders.
      console.error("aggregate_subagents failed:", e);
    }
  }

  if (notFound || !fanout) {
    return (
      <div data-testid="fleet-detail-not-found">
        <ErrorState
          title="Fan-out not found"
          description="This fan-out may have been purged or belongs to a different workspace."
        />
      </div>
    );
  }

  return (
    <FleetDetailClient
      fanout={fanout}
      aggregate={aggregate}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      workspaceId={workspaceId}
      canManage={canManage}
    />
  );
}
