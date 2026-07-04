/**
 * activity-section.tsx — async server component that fetches recent agent runs
 * via agent.execution.list and renders <ActivityList>. Sits inside a Suspense
 * boundary so the page skeleton shows immediately.
 *
 * Auth note (same as knowledge/memories): apps/app does NOT bootstrap IAM, so
 * invoke() skips role checks here; the page already gated org membership via
 * assertOrgMember. agent.execution.list declares surfaces ["api","mcp","agent"]
 * — pass surface "agent" (passing "app" would throw surface_denied).
 */
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { AgentExecutionListOutput } from "@oxagen/oxagen/contracts/agent.execution.list";
import { ActivityList } from "@/components/activity/activity-list";
import { workspace } from "@/lib/routes";

interface ActivitySectionProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
  before?: string;
}

export async function ActivitySection({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
  before,
}: ActivitySectionProps) {
  let result: AgentExecutionListOutput = { executions: [], nextCursor: null };
  try {
    result = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke(
        "agent.execution.list",
        { limit: 25, before },
        {
          orgId,
          workspaceId,
          userId,
          apiKeyId: null as string | null,
          requestId: crypto.randomUUID(),
          surface: "app" as const,
          messageId: null as string | null,
        },
        { surface: "agent" },
      ),
    )) as AgentExecutionListOutput;
  } catch (e) {
    // Never throw from an RSC — render the empty state on failure.
    console.error("agent.execution.list failed:", e);
  }

  const basePath = workspace.activity.root({ orgSlug, workspaceSlug });

  return (
    <ActivityList
      executions={result.executions}
      nextCursor={result.nextCursor}
      basePath={basePath}
    />
  );
}
